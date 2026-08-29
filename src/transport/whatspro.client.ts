import axios from "axios";
import fs from "node:fs/promises";
import path from "node:path";
import { auditDecision, auditError, auditOutbound } from "../services/auditLogger.service.js";
import { getRestaurantConfig } from "../services/platformConfig.service.js";
import crypto from "node:crypto";
import { connectRedis, redisClient, scanKeys } from "../services/redis.service.js";
import { envNumber } from "../utils/envNumber.js";
import { planHumanPacing, regroupBySentence, type PaceUrgency } from "./humanPace.js";

const RESPONSE_CHUNK_MAX = envNumber(process.env.OPENBOT_RESPONSE_CHUNK_MAX, 320, { min: 180 });
const URL_RE = /https?:\/\/[^\s<>"')\]]+/gi;
const volatileOutbox = new Map<string, WhatsProOutboxRecord>();
let outboxTimer: ReturnType<typeof setInterval> | null = null;
const outboxDirectory = path.resolve(
  process.env.OPENBOT_OUTBOX_DIR ||
  (process.env.NODE_ENV === "production"
    ? "/app/state/whatspro-outbox"
    : path.join(process.cwd(), ".openbot-outbox"))
);

interface WhatsProOutboxRecord {
  id: string;
  instanceId: string;
  phone: string;
  text: string;
  attempts: number;
  createdAt: number;
  nextAttemptAt: number;
  error?: string;
}

function maskPhone(phone = "") {
  const clean = String(phone || "").replace(/\D/g, "");
  if (clean.length <= 6) return clean || "-";
  // ӨЗГЕРІС: Бірінші санды анық көру үшін масканы 4 санға дейін ұзарттық (мысалы 7707***567)
  return `${clean.slice(0, 4)}***${clean.slice(-3)}`; 
}

function hostFromUrl(url = "") {
  try {
    return new URL(url).host;
  } catch {
    return url || "-";
  }
}

function firstValue(...values: unknown[]) {
  for (const value of values) {
    if (value !== undefined && value !== null && String(value).trim() !== "") return String(value).trim();
  }
  return "";
}

// The instance travels in a header as well as the body. WhatsPro authenticates
// /api/send before parsing the body — it will not run a 23mb parse for an
// unauthenticated caller — so a per-restaurant token has nothing to scope itself
// to unless the header is there. The gateway then checks the two agree.
function whatsproHeaders(apiToken = "", instanceId = "") {
  const headers: Record<string, string> = { "content-type": "application/json" };
  if (apiToken) {
    headers.authorization = `Bearer ${apiToken}`;
    headers["x-api-key"] = apiToken;
  }
  if (instanceId) headers["x-chat-instance"] = instanceId;
  return headers;
}

async function resolveWhatsProTransport(instanceId: string) {
  const config = (await getRestaurantConfig(instanceId).catch(() => null)) || {};
  const baseUrl = firstValue(config.whatspro_base_url, config.whatsproBaseUrl).replace(/\/+$/, "");
  return {
    baseUrl,
    sendUrl: firstValue(config.whatspro_send_url, config.whatsproSendUrl),
    presenceUrl: firstValue(config.whatspro_presence_url, config.whatsproPresenceUrl),
    apiToken: firstValue(config.whatspro_api_token, config.whatsproApiToken),
    source: "tenant_platform",
    tenantFound: Boolean(config.instance_id || config.instance),
  };
}

function endpointFromTransport(rawUrl: string, baseUrl: string, path: "/api/send" | "/api/presence") {
  if (rawUrl) {
    try {
      const parsed = new URL(rawUrl);
      return parsed.pathname === "/" || parsed.pathname === "" ? `${rawUrl.replace(/\/+$/, "")}${path}` : rawUrl;
    } catch {
      return rawUrl;
    }
  }
  return baseUrl ? `${baseUrl}${path}` : "";
}

function delay(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function pushSized(chunks: string[], value = "") {
  // Single newlines INSIDE a block are the author's own line breaks (a warm
  // sentence, then the invitation under it). Collapsing every whitespace run
  // flattened them into one long line, which is exactly the wall of text a
  // person would never send - so only spaces/tabs are normalised here.
  const text = value.replace(/[ \t]+/g, " ").replace(/\n{2,}/g, "\n").split("\n").map((line) => line.trim()).filter(Boolean).join("\n").trim();
  if (!text) return;
  if (text.length <= RESPONSE_CHUNK_MAX) {
    chunks.push(text);
    return;
  }

  const sentences = text.match(/[^.!?。！？]+[.!?。！？]+|[^.!?。！？]+$/gu) || [text];
  let current = "";
  for (const sentence of sentences) {
    const cleanSentence = sentence.trim();
    const next = `${current} ${cleanSentence}`.trim();
    if (next.length > RESPONSE_CHUNK_MAX && current) {
      chunks.push(current);
      current = cleanSentence;
    } else {
      current = next;
    }
  }
  if (current) chunks.push(current.trim());
}

function normalizeUrlForSeparateMessage(url: string): string {
  const u = url.trim().replace(/[.,!?;:]+$/g, "");
  if (u.startsWith("http://") || u.startsWith("https://")) return u;
  return u;
}

function normalizeMarkdownLinks(text: string): string {
  return String(text || "").replace(/\[([^\]]*)\]\((https?:\/\/[^)\s]+)\)/gi, (_match, label, url) =>
    [String(label || "").trim(), String(url || "").trim()].filter(Boolean).join("\n")
  );
}

export function splitWhatsProResponse(text = ""): string[] {
  const cleanText = normalizeMarkdownLinks(String(text || "").trim());
  if (!cleanText) return [];

  // Extract all URLs
  const urls = Array.from(new Set((cleanText.match(URL_RE) || []).map(normalizeUrlForSeparateMessage).filter(Boolean)));

  // "Міне мәзір сілтемесі:" followed by the link arrived as two WhatsApp
  // messages - the intro, then a bare URL. A person sends that as one message.
  // Splitting only earns its keep when there is more than one link or the prose
  // is long enough to need chunking anyway, so a short one-link answer stays
  // whole, with the link on its own line so it still renders as a preview. The
  // URL's own length does not count: a magic-link token cannot be chunked.
  if (urls.length === 1) {
    const intro = cleanText.replace(URL_RE, "").replace(/[ \t]+/g, " ").replace(/\n{2,}/g, "\n").split("\n").map((line) => line.trim()).filter(Boolean).join("\n").trim();
    if (intro.length <= RESPONSE_CHUNK_MAX) return [intro ? `${intro}\n${urls[0]}` : urls[0]];
  }
  // Remove URLs from text body. Author line breaks survive (see pushSized): a
  // blank line still starts a new WhatsApp message, a single newline stays a
  // line break inside one message.
  const textOnly = cleanText.replace(URL_RE, "").replace(/[ \t]+/g, " ").replace(/[ \t]*\n/g, "\n").trim();

  const chunks: string[] = [];

  // Split text-only body into chunks (paragraph-based)
  for (const paragraph of textOnly.split(/\n{2,}/)) {
    pushSized(chunks, paragraph);
  }

  // If there are URLs AND text chunks, URLs go as completely separate messages
  if (urls.length > 0 && chunks.length > 0) {
    // Keep text chunks as-is
    // URLs will be appended as individual separate messages
  }

  for (const url of urls) {
    chunks.push(url);
  }

  return chunks.filter(Boolean);
}

export async function sendWhatsProMessage(payload: {
  instanceId: string;
  phone: string;
  text: string;
  media?: any;
  requestId?: string;
}) {
  const transport = await resolveWhatsProTransport(payload.instanceId);
  const url = endpointFromTransport(transport.sendUrl, transport.baseUrl, "/api/send");
  if (!url) {
    auditDecision("WhatsPro outbound skipped: send URL not configured", {
      instance: payload.instanceId,
      tenantFound: transport.tenantFound,
      hasTenantToken: Boolean(transport.apiToken),
      phone: payload.phone,
      textLength: payload.text?.length || 0,
      media: Boolean(payload.media),
    });
    return { skipped: true, reason: "tenant whatspro_send_url/whatspro_base_url is not configured" };
  }

  const headers = whatsproHeaders(transport.apiToken, payload.instanceId);
  if (!transport.apiToken) {
    auditDecision("WhatsPro outbound skipped: tenant API token not configured", {
      instance: payload.instanceId,
      tenantFound: transport.tenantFound,
      phone: payload.phone,
      textLength: payload.text?.length || 0,
      media: Boolean(payload.media),
    });
    return { skipped: true, reason: "tenant whatspro_api_token is not configured" };
  }

  const started = Date.now();
  auditOutbound("WhatsPro send begin", {
    to: payload.phone,
    phone: payload.phone,
    maskedPhone: maskPhone(payload.phone),
    text: payload.text,
    textLength: payload.text?.length || 0,
    instance: payload.instanceId,
    host: hostFromUrl(url),
    media: Boolean(payload.media),
    transportSource: transport.source,
  });

  try {
    const response = await axios.post(
      url,
      {
        instanceId: payload.instanceId,
        phone: payload.phone,
        text: payload.text,
        media: payload.media,
        requestId: payload.requestId,
      },
      { timeout: 10000, headers }
    );
    const acknowledged = response.status >= 200 && response.status < 300 && response.data?.success === true;
    if (!acknowledged) {
      const error: any = new Error("WHATSPRO_DELIVERY_NOT_ACKNOWLEDGED");
      error.code = "WHATSPRO_DELIVERY_NOT_ACKNOWLEDGED";
      error.response = response;
      throw error;
    }
    auditOutbound("WhatsPro send success", {
      to: payload.phone,
      phone: payload.phone,
      maskedPhone: maskPhone(payload.phone),
      text: payload.text,
      status: response.status,
      elapsedMs: Date.now() - started,
      instance: payload.instanceId,
      host: hostFromUrl(url),
      transportSource: transport.source,
      response: response.data,
    });
    return { ...response.data, ok: true, acknowledged: true };
  } catch (error: any) {
    auditError("WhatsPro send failed", error, {
      failedStep: "whatspro_send_message",
      to: payload.phone,
      phone: payload.phone,
      maskedPhone: maskPhone(payload.phone),
      text: payload.text,
      status: error?.response?.status || "-",
      response: error?.response?.data,
      elapsedMs: Date.now() - started,
      instance: payload.instanceId,
      host: hostFromUrl(url),
      transportSource: transport.source,
    });
    throw error;
  }
}

async function persistOutbox(record: WhatsProOutboxRecord) {
  volatileOutbox.set(record.id, record);
  try {
    await fs.mkdir(outboxDirectory, { recursive: true, mode: 0o700 });
    const target = path.join(outboxDirectory, `${record.id}.json`);
    const temporary = `${target}.${process.pid}.${crypto.randomUUID()}.tmp`;
    await fs.writeFile(temporary, JSON.stringify(record), { encoding: "utf8", mode: 0o600 });
    await fs.rename(temporary, target);
  } catch (error: any) {
    auditError("WhatsPro file outbox write failed", error, {
      failedStep: "whatspro_file_outbox_write",
      instance: record.instanceId,
      outboxId: record.id,
    });
  }
  try {
    await connectRedis();
    await redisClient.setEx(`outbox:whatspro:${record.id}`, 7 * 24 * 60 * 60, JSON.stringify(record));
  } catch {
    // The process-local copy keeps retrying while Redis reconnects.
  }
}

async function removeOutbox(id: string) {
  volatileOutbox.delete(id);
  await fs.unlink(path.join(outboxDirectory, `${id}.json`)).catch((error: any) => {
    if (error?.code !== "ENOENT") {
      auditError("WhatsPro file outbox cleanup failed", error, {
        failedStep: "whatspro_file_outbox_cleanup",
        outboxId: id,
      });
    }
  });
  try {
    await connectRedis();
    await redisClient.del(`outbox:whatspro:${id}`);
  } catch {
    // A replay is safe because the same requestId reaches WhatsPro idempotency.
  }
}

export async function getWhatsProOutboxSummary() {
  const filePending = await fs.readdir(outboxDirectory)
    .then((names) => names.filter((name) => /^[a-f0-9]{64}\.json$/.test(name)).length)
    .catch(() => 0);
  let redisPending = 0;
  try {
    redisPending = (await scanKeys("outbox:whatspro:*")).length;
  } catch {
    redisPending = -1;
  }
  return {
    volatilePending: volatileOutbox.size,
    filePending,
    redisPending,
  };
}

export async function drainWhatsProOutbox(limit = 25) {
  const records = new Map<string, WhatsProOutboxRecord>(volatileOutbox);
  try {
    const names = (await fs.readdir(outboxDirectory))
      .filter((name) => /^[a-f0-9]{64}\.json$/.test(name))
      .slice(0, limit);
    for (const name of names) {
      try {
        const record = JSON.parse(await fs.readFile(path.join(outboxDirectory, name), "utf8")) as WhatsProOutboxRecord;
        if (record?.id && record?.instanceId && record?.phone && record?.text) records.set(record.id, record);
      } catch {
        await fs.unlink(path.join(outboxDirectory, name)).catch(() => undefined);
      }
    }
  } catch {
    // The Redis and process-local copies remain available.
  }
  try {
    const keys = await scanKeys("outbox:whatspro:*");
    for (const key of keys.slice(0, limit)) {
      const raw = await redisClient.get(key);
      if (!raw) continue;
      try {
        const record = JSON.parse(raw) as WhatsProOutboxRecord;
        if (record?.id && record?.instanceId && record?.phone && record?.text) records.set(record.id, record);
      } catch {
        await redisClient.del(key);
      }
    }
  } catch {
    // Redis will be retried by the connection manager; volatile records remain.
  }

  let delivered = 0;
  for (const record of [...records.values()].slice(0, limit)) {
    if (Number(record.nextAttemptAt || 0) > Date.now()) continue;
    try {
      const result = await sendWhatsProMessage({
        instanceId: record.instanceId,
        phone: record.phone,
        text: record.text,
        requestId: record.id,
      });
      if (result?.acknowledged !== true) throw new Error("WHATSPRO_DELIVERY_NOT_ACKNOWLEDGED");
      await removeOutbox(record.id);
      delivered += 1;
    } catch (error: any) {
      const attempts = Number(record.attempts || 0) + 1;
      // The same three brakes D12 gave the developer-alert outbox. Without them an
      // undeliverable reply was re-sent every ~5 minutes for as long as its Redis copy lived
      // (7 days), each attempt leaving a file copy under outboxDirectory that only success
      // removed - and a guest could receive an answer to a question asked hours earlier
      // (found 2026-08-23).
      const MAX_ATTEMPTS = envNumber(process.env.OPENBOT_OUTBOX_MAX_ATTEMPTS, 5, { min: 1 });
      const AGE_LIMIT_MS = envNumber(process.env.OPENBOT_OUTBOX_MAX_AGE_MS, 6 * 60 * 60_000, { min: 60_000 });
      const age = Date.now() - Number(record.createdAt || 0);
      if (attempts >= MAX_ATTEMPTS || age > AGE_LIMIT_MS) {
        auditError(
          `[OPENBOT:OUTBOX:ABANDONED] instance=${record.instanceId} id=${record.id} attempts=${attempts} ageMs=${age}`,
          new Error(String(error?.message || error || "delivery_failed")),
          { failedStep: "whatspro_outbox_abandoned" },
        );
        await removeOutbox(record.id);
        continue;
      }
      await persistOutbox({
        ...record,
        attempts,
        nextAttemptAt: Date.now() + Math.min(5 * 60_000, 2_000 * (2 ** Math.min(attempts, 7))),
        error: String(error?.message || error || "delivery_failed"),
      });
    }
  }
  return { checked: Math.min(records.size, limit), delivered, pending: records.size - delivered };
}

export function startWhatsProOutboxWorker() {
  if (outboxTimer) return outboxTimer;
  void drainWhatsProOutbox().catch(() => undefined);
  outboxTimer = setInterval(() => {
    void drainWhatsProOutbox().catch((error) => {
      auditError("WhatsPro outbox drain failed", error, { failedStep: "whatspro_outbox_drain" });
    });
  }, envNumber(process.env.OPENBOT_OUTBOX_INTERVAL_MS, 10_000, { min: 2_000 }));
  outboxTimer.unref?.();
  return outboxTimer;
}

export async function sendWhatsProPresence(payload: { instanceId: string; phone: string }) {
  const transport = await resolveWhatsProTransport(payload.instanceId);
  const url = endpointFromTransport(transport.presenceUrl, transport.baseUrl, "/api/presence");
  if (!url) return { skipped: true, reason: "tenant whatspro_presence_url/whatspro_base_url is not configured" };
  if (!transport.apiToken) return { skipped: true, reason: "tenant whatspro_api_token is not configured" };

  try {
    const response = await axios.post(
      url,
      {
        instanceId: payload.instanceId,
        phone: payload.phone,
        state: "composing",
      },
      { timeout: 3000, headers: whatsproHeaders(transport.apiToken, payload.instanceId) }
    );
    return response.data;
  } catch (error: any) {
    auditError("WhatsPro presence skipped", error, {
      failedStep: "whatspro_presence",
      host: hostFromUrl(url),
      instance: payload.instanceId,
      phone: payload.phone,
      maskedPhone: maskPhone(payload.phone),
      status: error?.response?.status || "-",
      response: error?.response?.data,
      transportSource: transport.source,
    });
    return { skipped: true, reason: error?.message || "presence_failed" };
  }
}

export function startWhatsProTyping(payload: { instanceId: string; phone: string }) {
  let stopped = false;
  const pulse = () => {
    if (!stopped) void sendWhatsProPresence(payload).catch(() => undefined);
  };
  pulse();
  // WhatsApp presence expires after a few seconds; 3s keeps "typing..." alive
  // through the whole turn (buffer + think + generation + send).
  const timer = setInterval(pulse, 3000);
  timer.unref?.();
  return () => {
    stopped = true;
    clearInterval(timer);
  };
}

/**
 * Blue-tick read receipt over the presence channel.
 *
 * The gateway exposes /api/presence (verified to exist); read states ride the
 * same channel, so the customer immediately sees their message was read the
 * moment the guard accepts it - long before the answer is generated. Fire and
 * forget: a gateway that does not map the read state simply ignores it.
 */
export async function markWhatsProChatRead(payload: { instanceId: string; phone: string }): Promise<void> {
  try {
    const transport = await resolveWhatsProTransport(payload.instanceId);
    const url = endpointFromTransport(transport.presenceUrl, transport.baseUrl, "/api/presence");
    if (!url || !transport.apiToken) return;
    await axios.post(
      url,
      {
        instanceId: payload.instanceId,
        phone: payload.phone,
        state: String(process.env.WHATSPRO_READ_STATE || "read"),
      },
      { timeout: 2500, headers: whatsproHeaders(transport.apiToken, payload.instanceId) }
    );
  } catch {
    // Read receipts are a courtesy; never let them delay or break a reply.
  }
}

export async function sendWhatsProResponseSequence(payload: {
  instanceId: string;
  phone: string;
  text: string;
  requestScope?: string;
  /** Collapses the human pauses: an angry guest or an escalation must not wait on a show. */
  pace?: PaceUrgency;
}) {
  // Sentence-complete chunks first: the size-based splitter cuts on a character
  // budget and could send half a sentence as its own message ("сөйлемді аяқтап",
  // owner request 2026-08-29).
  const chunks = regroupBySentence(splitWhatsProResponse(payload.text), RESPONSE_CHUNK_MAX);
  if (!chunks.length) throw new Error("WHATSPRO_EMPTY_RESPONSE");
  // Stable for retries of one inbound message, but unique for a later customer
  // turn that happens to produce the same reply text.
  const requestScope = String(payload.requestScope || crypto.randomUUID());
  // How a person would have paced this: a beat to read, then typing time per message.
  const pacing = planHumanPacing(chunks, payload.pace || "normal");
  const sent: any[] = [];
  for (let index = 0; index < chunks.length; index += 1) {
    // "typing…" starts BEFORE the pause, so the guest sees composing for the whole
    // wait instead of silence followed by a sudden message.
    await sendWhatsProPresence(payload);
    const pause = index === 0 ? pacing.readPauseMs + (pacing.typingMs[0] || 0) : pacing.typingMs[index] || 0;
    if (pause > 0) await delay(pause);
    const outboundId = crypto.createHash("sha256")
      .update(`${payload.instanceId}|${payload.phone}|${requestScope}|${index}|${chunks[index]}`)
      .digest("hex");
    let result: any = null;
    let lastError: any = null;
    for (let attempt = 1; attempt <= 3; attempt += 1) {
      try {
        result = await sendWhatsProMessage({
          instanceId: payload.instanceId,
          phone: payload.phone,
          text: chunks[index],
          requestId: outboundId,
        });
        if (result?.acknowledged === true) break;
        throw new Error("WHATSPRO_DELIVERY_NOT_ACKNOWLEDGED");
      } catch (error) {
        lastError = error; result = null;
        if (attempt < 3) await delay(300 * 2 ** (attempt - 1));
      }
    }
    if (!result?.acknowledged) {
      await persistOutbox({
        id: outboundId,
        instanceId: payload.instanceId,
        phone: payload.phone,
        text: chunks[index],
        attempts: 3,
        createdAt: Date.now(),
        nextAttemptAt: Date.now() + 5_000,
        error: String(lastError?.message || "delivery_not_acknowledged"),
      });
      throw lastError || new Error("WHATSPRO_DELIVERY_NOT_ACKNOWLEDGED");
    }
    await removeOutbox(outboundId);
    sent.push(result);
  }
  return { ok: sent.length === chunks.length, chunks: chunks.length, sent };
}
