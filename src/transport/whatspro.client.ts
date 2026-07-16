import axios from "axios";
import { auditDecision, auditError, auditOutbound } from "../services/auditLogger.service.js";

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

function whatsproHeaders() {
  const headers: Record<string, string> = { "content-type": "application/json" };
  if (process.env.WHATSPRO_API_TOKEN) {
    headers.authorization = `Bearer ${process.env.WHATSPRO_API_TOKEN}`;
    headers["x-api-key"] = process.env.WHATSPRO_API_TOKEN;
  }
  return headers;
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
  const baseUrl = String(process.env.WHATSPRO_BASE_URL || "").replace(/\/+$/, "");
  const rawSendUrl = process.env.WHATSPRO_SEND_URL || "";
  let url: string;
  if (rawSendUrl) {
    try {
      const parsed = new URL(rawSendUrl);
      url = parsed.pathname === "/" || parsed.pathname === "" ? `${rawSendUrl.replace(/\/+$/, "")}/api/send` : rawSendUrl;
    } catch {
      url = rawSendUrl;
    }
  } else {
    url = baseUrl ? `${baseUrl}/api/send` : "";
  }
  if (!url) {
    auditDecision("WhatsPro outbound skipped: send URL not configured", {
      instance: payload.instanceId,
      phone: payload.phone,
      textLength: payload.text?.length || 0,
      media: Boolean(payload.media),
    });
    return { skipped: true, reason: "WHATSPRO_SEND_URL or WHATSPRO_BASE_URL is not configured" };
  }

  const headers = whatsproHeaders();

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
    auditOutbound("WhatsPro send success", {
      to: payload.phone,
      phone: payload.phone,
      maskedPhone: maskPhone(payload.phone),
      text: payload.text,
      status: response.status,
      elapsedMs: Date.now() - started,
      instance: payload.instanceId,
      host: hostFromUrl(url),
      response: response.data,
    });
    return response.data;
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
    });
    throw error;
  }
}

export async function sendWhatsProPresence(payload: { instanceId: string; phone: string }) {
  const baseUrl = String(process.env.WHATSPRO_BASE_URL || "").replace(/\/+$/, "");
  const rawPresenceUrl = process.env.WHATSPRO_PRESENCE_URL || "";
  let url: string;
  if (rawPresenceUrl) {
    try {
      const parsed = new URL(rawPresenceUrl);
      url = parsed.pathname === "/" || parsed.pathname === "" ? `${rawPresenceUrl.replace(/\/+$/, "")}/api/presence` : rawPresenceUrl;
    } catch {
      url = rawPresenceUrl;
    }
  } else {
    url = baseUrl ? `${baseUrl}/api/presence` : "";
  }
  if (!url) return { skipped: true, reason: "WHATSPRO_PRESENCE_URL or WHATSPRO_BASE_URL is not configured" };

  try {
    const response = await axios.post(
      url,
      {
        instanceId: payload.instanceId,
        phone: payload.phone,
        state: "composing",
      },
      { timeout: 3000, headers: whatsproHeaders() }
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
    });
    return { skipped: true, reason: error?.message || "presence_failed" };
  }
}

export async function sendWhatsProResponseSequence(payload: { instanceId: string; phone: string; text: string }) {
  const chunks = splitWhatsProResponse(payload.text);
  const sent: any[] = [];
  for (let index = 0; index < chunks.length; index += 1) {
    if (index > 0) {
      await sendWhatsProPresence(payload);
      await delay(randomTypingDelayMs());
    }
    sent.push(
      await sendWhatsProMessage({
        instanceId: payload.instanceId,
        phone: payload.phone,
        text: chunks[index],
      })
    );
  }
  return { ok: true, chunks: chunks.length, sent };
}
