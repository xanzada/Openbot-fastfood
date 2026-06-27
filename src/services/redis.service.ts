import crypto from "node:crypto";
import { createClient } from "redis";

export const redisClient = createClient({
  url: process.env.REDIS_URL || "redis://localhost:6379",
});

let redisReady: Promise<void> | null = null;
let redisConnectLogged = false;

export function getRedisTarget() {
  const raw = process.env.REDIS_URL || "redis://localhost:6379";
  try {
    const url = new URL(raw);
    return {
      host: url.hostname || "unknown",
      port: url.port || "6379",
      database: url.pathname?.replace("/", "") || "0",
      configured: Boolean(process.env.REDIS_URL),
    };
  } catch {
    return {
      host: "invalid-url",
      port: "",
      database: "",
      configured: Boolean(process.env.REDIS_URL),
    };
  }
}

redisClient.on("error", (error) => {
  console.error("[REDIS] error:", error?.message || error);
});

export async function connectRedis(): Promise<void> {
  if (redisClient.isOpen) return;
  if (!redisReady) {
    const target = getRedisTarget();
    if (!redisConnectLogged) {
      console.log(`[OPENBOT:REDIS] connecting host=${target.host} port=${target.port} db=${target.database}`);
      redisConnectLogged = true;
    }
    redisReady = redisClient
      .connect()
      .then(() => {
        console.log(`[OPENBOT:REDIS] connected host=${target.host} port=${target.port}`);
      })
      .catch((error) => {
        redisReady = null;
        console.error(`[OPENBOT:REDIS] connect failed host=${target.host} port=${target.port}:`, error?.message || error);
        throw error;
      });
  }
  await redisReady;
}

export async function pingRedis(): Promise<string> {
  await connectRedis();
  return redisClient.ping();
}

async function safeRedis<T>(fallback: T, fn: () => Promise<T>): Promise<T> {
  try {
    await connectRedis();
    return await fn();
  } catch {
    return fallback;
  }
}

function historyKey(instanceId: string, phone: string) {
  return `history:${instanceId}:${phone}`;
}

function magicLinkKey(instanceId: string, phone: string) {
  return `has_sent_link:${instanceId}:${phone}`;
}

const CHAT_HISTORY_TTL_SECONDS = 604800;
const CHAT_HISTORY_MAX_ITEMS = 120;
const MAGIC_LINK_SENT_TTL_SECONDS = 2592000;

export async function getChatHistory(instanceId: string, phone: string): Promise<any[]> {
  return safeRedis([], async () => {
    const raw = await redisClient.lRange(historyKey(instanceId, phone), 0, -1);
    return raw
      .map((item) => {
        try {
          return JSON.parse(item);
        } catch {
          return null;
        }
      })
      .filter(Boolean);
  });
}

export async function saveToHistory(
  instanceId: string,
  phone: string,
  role: "user" | "assistant" | "system",
  text: string,
  meta: Record<string, unknown> = {}
): Promise<void> {
  if (!text) return;
  await safeRedis(undefined, async () => {
    const key = historyKey(instanceId, phone);
    const ttlBefore = await redisClient.ttl(key);
    const entry = JSON.stringify({ role, text, createdAt: Date.now(), ...meta });
    await redisClient.multi().rPush(key, entry).lTrim(key, -CHAT_HISTORY_MAX_ITEMS, -1).exec();
    if (ttlBefore < 0) await redisClient.expire(key, CHAT_HISTORY_TTL_SECONDS);
  });
}

export async function getUserLang(instanceId: string, phone: string): Promise<"kk" | "ru" | null> {
  return safeRedis(null, async () => {
    const value = await redisClient.get(`lang:${instanceId}:${phone}`);
    return value === "kk" || value === "ru" ? value : null;
  });
}

export async function saveUserLang(instanceId: string, phone: string, lang: "kk" | "ru"): Promise<void> {
  await safeRedis(undefined, async () => {
    await redisClient.setEx(`lang:${instanceId}:${phone}`, 604800, lang);
  });
}

export async function hasMagicLinkBeenSent(instanceId: string, phone: string): Promise<boolean> {
  return safeRedis(false, async () => Boolean(await redisClient.get(magicLinkKey(instanceId, phone))));
}

export async function markMagicLinkSent(instanceId: string, phone: string): Promise<boolean> {
  return safeRedis(false, async () => {
    await redisClient.setEx(magicLinkKey(instanceId, phone), MAGIC_LINK_SENT_TTL_SECONDS, String(Date.now()));
    return true;
  });
}

function parseShiftNoteRecord(raw = "") {
  const text = String(raw || "").trim();
  if (!text) return { text: "", plain: false, expired: false, expiresAt: 0 };
  try {
    const parsed = JSON.parse(text);
    const expiresAt = Number(parsed?.expiresAt || parsed?.expires_at || 0);
    return {
      text: String(parsed?.text || "").trim(),
      plain: false,
      expired: Boolean(expiresAt && expiresAt <= Date.now()),
      expiresAt,
    };
  } catch {
    return { text, plain: true, expired: false, expiresAt: 0 };
  }
}

function normalizeShiftNoteText(value = "") {
  return String(value || "")
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function shiftNoteTextMatches(currentText = "", expectedText = "") {
  const current = normalizeShiftNoteText(currentText);
  const expected = normalizeShiftNoteText(expectedText);
  return Boolean(current && expected && (current === expected || current.includes(expected) || expected.includes(current)));
}

async function scanKeys(pattern: string): Promise<string[]> {
  await connectRedis();
  const keys: string[] = [];
  for await (const chunk of redisClient.scanIterator({ MATCH: pattern, COUNT: 100 })) {
    if (Array.isArray(chunk)) keys.push(...chunk.map(String));
    else keys.push(String(chunk));
  }
  return keys;
}

async function purgeShiftNoteTextFromHistory(instanceId: string, noteText: string): Promise<void> {
  const expected = normalizeShiftNoteText(noteText);
  if (!expected) return;
  const keys = await scanKeys(`history:${instanceId}:*`);
  for (const key of keys) {
    const raw = await redisClient.lRange(key, 0, -1).catch(() => []);
    const kept = raw.filter((item) => {
      try {
        const parsed = JSON.parse(item);
        return !shiftNoteTextMatches(parsed?.text || "", noteText);
      } catch {
        return true;
      }
    });
    if (kept.length !== raw.length) {
      const ttl = await redisClient.ttl(key).catch(() => -1);
      await redisClient.del(key);
      if (kept.length) await redisClient.rPush(key, kept);
      if (ttl > 0) await redisClient.expire(key, ttl);
    }
  }
}

export async function saveShiftNote(
  instanceId: string,
  noteId: string | number | undefined,
  text: string,
  expiresAtString?: string
): Promise<boolean> {
  const noteText = String(text || "").trim();
  if (!noteText) return false;
  return safeRedis(false, async () => {
    const safeNoteId =
      String(noteId || "").trim() ||
      `fallback_${crypto.createHash("sha1").update(`${instanceId}|${noteText}|${expiresAtString || ""}`).digest("hex").slice(0, 16)}`;

    let ttlSeconds = 24 * 60 * 60;
    const expiresAt = expiresAtString ? Date.parse(expiresAtString) : 0;
    if (Number.isFinite(expiresAt) && expiresAt > Date.now()) {
      ttlSeconds = Math.max(60, Math.ceil((expiresAt - Date.now()) / 1000));
    }

    await redisClient.setEx(
      `shift_note:${instanceId}:${safeNoteId}`,
      ttlSeconds,
      JSON.stringify({ text: noteText, createdAt: Date.now(), expiresAt: Date.now() + ttlSeconds * 1000 })
    );
    return true;
  });
}

export async function deleteShiftNote(
  instanceId: string,
  noteId?: string | number,
  text = ""
): Promise<void> {
  await safeRedis(undefined, async () => {
    const purgeTexts = new Set<string>();
    const safeNoteId = String(noteId || "").trim();
    if (text) purgeTexts.add(text);

    if (safeNoteId && safeNoteId !== "0") {
      const key = `shift_note:${instanceId}:${safeNoteId}`;
      const existing = parseShiftNoteRecord((await redisClient.get(key)) || "");
      if (existing.text) purgeTexts.add(existing.text);
      await redisClient.del(key);
    } else {
      const keys = await scanKeys(`shift_note:${instanceId}:*`);
      for (const key of keys) {
        const existing = parseShiftNoteRecord((await redisClient.get(key)) || "");
        if (!text || shiftNoteTextMatches(existing.text, text)) {
          if (existing.text) purgeTexts.add(existing.text);
          await redisClient.del(key);
        }
      }
    }

    for (const purgeText of purgeTexts) {
      await purgeShiftNoteTextFromHistory(instanceId, purgeText);
    }
  });
}

export async function getActiveShiftNotes(instanceId: string): Promise<Array<{ text: string; expiresAt?: number }>> {
  return safeRedis([], async () => {
    const keys = await scanKeys(`shift_note:${instanceId}:*`);
    const notes = [];
    for (const key of keys) {
      const note = parseShiftNoteRecord((await redisClient.get(key)) || "");
      if (!note.text || note.expired || note.plain) {
        await redisClient.del(key).catch(() => undefined);
        continue;
      }
      notes.push({ text: note.text, expiresAt: note.expiresAt || undefined });
    }
    return notes;
  });
}

export async function getJsonCache<T>(key: string): Promise<T | null> {
  return safeRedis<T | null>(null, async () => {
    const raw = await redisClient.get(key);
    return raw ? (JSON.parse(raw) as T) : null;
  });
}

export async function setJsonCache(key: string, ttlSeconds: number, value: unknown): Promise<void> {
  await safeRedis(undefined, async () => {
    await redisClient.setEx(key, ttlSeconds, JSON.stringify(value));
  });
}

export async function deleteCache(key: string): Promise<void> {
  await safeRedis(undefined, async () => {
    await redisClient.del(key);
  });
}
