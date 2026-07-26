import axios from "axios";
import { auditDecision, auditError, auditOutbound } from "../services/auditLogger.service.js";
import { getRestaurantConfig } from "../services/nocodb.service.js";
import crypto from "node:crypto";
import { connectRedis, redisClient } from "../services/redis.service.js";

const RESPONSE_CHUNK_MAX = Number(process.env.OPENBOT_RESPONSE_CHUNK_MAX || 650);
const URL_RE = /https?:\/\/[^\s<>"')\]]+/gi;

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
    source: "tenant_nocodb",
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

function randomTypingDelayMs() {
  return 1500 + Math.floor(Math.random() * 1500);
}

function pushSized(chunks: string[], value = "") {
  const text = value.replace(/\s+/g, " ").trim();
  if (!text) return;
  if (text.length <= RESPONSE_CHUNK_MAX) {
    chunks.push(text);
    return;
  }

  const sentences = text.match(/[^.!?。！？]+[.!?。！？]+|[^.!?。！？]+$/gu) || [text];
  let current = "";
  for (const sentence of sentences) {
    const next = `${current} ${sentence}`.trim();
    if (next.length > RESPONSE_CHUNK_MAX && current) {
      chunks.push(current);
      current = sentence.trim();
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
  // Remove URLs from text body
  const textOnly = cleanText.replace(URL_RE, "").replace(/[ \t]+\n/g, "\n").replace(/\s{2,}/g, " ").trim();

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
  const timer = setInterval(pulse, 4000);
  timer.unref?.();
  return () => {
    stopped = true;
    clearInterval(timer);
  };
}

export async function sendWhatsProResponseSequence(payload: { instanceId: string; phone: string; text: string }) {
  const chunks = splitWhatsProResponse(payload.text);
  if (!chunks.length) throw new Error("WHATSPRO_EMPTY_RESPONSE");
  const sent: any[] = [];
  for (let index = 0; index < chunks.length; index += 1) {
    await sendWhatsProPresence(payload);
    if (index > 0) await delay(randomTypingDelayMs());
    const outboundId = crypto.createHash("sha256").update(`${payload.instanceId}|${payload.phone}|${index}|${chunks[index]}`).digest("hex");
    let result: any = null;
    let lastError: any = null;
    for (let attempt = 1; attempt <= 3; attempt += 1) {
      try {
        result = await sendWhatsProMessage({ instanceId: payload.instanceId, phone: payload.phone, text: chunks[index] });
        if (result?.acknowledged === true) break;
        throw new Error("WHATSPRO_DELIVERY_NOT_ACKNOWLEDGED");
      } catch (error) {
        lastError = error; result = null;
        if (attempt < 3) await delay(300 * 2 ** (attempt - 1));
      }
    }
    if (!result?.acknowledged) {
      await connectRedis().then(() => redisClient.setEx(`outbox:whatspro:${outboundId}`, 24 * 60 * 60, JSON.stringify({ id: outboundId, instanceId: payload.instanceId, phone: payload.phone, text: chunks[index], attempts: 3, failedAt: Date.now(), error: String(lastError?.message || "delivery_not_acknowledged") }))).catch(() => undefined);
      throw lastError || new Error("WHATSPRO_DELIVERY_NOT_ACKNOWLEDGED");
    }
    await connectRedis().then(() => redisClient.del(`outbox:whatspro:${outboundId}`)).catch(() => undefined);
    sent.push(result);
  }
  return { ok: sent.length === chunks.length, chunks: chunks.length, sent };
}
