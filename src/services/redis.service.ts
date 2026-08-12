import crypto from "node:crypto";
import { createClient } from "redis";

const REDIS_CONNECT_TIMEOUT_MS = Math.max(
  500,
  Math.min(10_000, Number(process.env.REDIS_CONNECT_TIMEOUT_MS || 2_500))
);

export const redisClient = createClient({
  url: process.env.REDIS_URL || "redis://localhost:6379",
  disableOfflineQueue: true,
  socket: {
    connectTimeout: REDIS_CONNECT_TIMEOUT_MS,
    reconnectStrategy: (retries) => Math.min(250 * (2 ** Math.min(retries, 5)), 5_000),
  },
});

let redisReady: Promise<void> | null = null;
let redisConnectLogged = false;

function redisUsable() {
  return redisClient.isReady ||
    (Boolean(process.env.NODE_TEST_CONTEXT) && redisClient.isOpen);
}

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

redisClient.on("error", (error: any) => {
  console.error("[REDIS] error:", error?.message || error);
});

export async function connectRedis(): Promise<void> {
  if (redisUsable()) return;
  if (!redisReady && !redisClient.isOpen) {
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
      .catch((error: any) => {
        console.error(`[OPENBOT:REDIS] connect failed host=${target.host} port=${target.port}:`, error?.message || error);
      })
      .finally(() => {
        redisReady = null;
      });
  }
  if (redisReady) {
    let timer: ReturnType<typeof setTimeout> | undefined;
    await Promise.race([
      redisReady,
      new Promise<void>((resolve) => {
        timer = setTimeout(resolve, REDIS_CONNECT_TIMEOUT_MS);
        timer.unref?.();
      }),
    ]).finally(() => {
      if (timer) clearTimeout(timer);
    });
  }
  if (!redisUsable()) throw new Error(`REDIS_NOT_READY:${REDIS_CONNECT_TIMEOUT_MS}ms`);
}

export async function pingRedis(): Promise<string> {
  await connectRedis();
  return redisClient.ping();
}

async function withRedisTimeout<T>(operation: Promise<T>, timeoutMs: number): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      operation,
      new Promise<never>((_resolve, reject) => {
        timer = setTimeout(
          () => reject(new Error(`REDIS_OPERATION_TIMEOUT:${timeoutMs}ms`)),
          timeoutMs
        );
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

async function safeRedis<T>(fallback: T, fn: () => Promise<T>): Promise<T> {
  try {
    const timeoutMs = Math.max(
      500,
      Math.min(10_000, Number(process.env.REDIS_OPERATION_TIMEOUT_MS || 2_500))
    );
    await withRedisTimeout(connectRedis(), timeoutMs);
    return await withRedisTimeout(fn(), timeoutMs);
  } catch {
    return fallback;
  }
}

function historyKey(instanceId: string, phone: string) {
  return `history:${instanceId}:${phone}`;
}

function whatsProHistoryKey(instanceId: string, phone: string) {
  return `chatwoot:history:${instanceId}:${phone}`;
}

function magicLinkKey(instanceId: string, phone: string) {
  return `has_sent_link:${instanceId}:${phone}`;
}

const CHAT_HISTORY_TTL_SECONDS = 604800;
const CHAT_HISTORY_MAX_ITEMS = 120;
const MAGIC_LINK_SENT_TTL_SECONDS = 2592000;
export const USER_LANG_TTL_SECONDS = 24 * 60 * 60;
export const SITE_LANG_HINT_TTL_SECONDS = 24 * 60 * 60;
const RECEIPT_FINGERPRINT_TTL_SECONDS = 7 * 24 * 60 * 60;
const COMPLAINT_MEDIA_TTL_SECONDS = 300;
const DAILY_LOG_TTL_SECONDS = 172800;
const KITCHEN_STATUS_TTL_SECONDS = 604800;

export interface PaymentDetail {
  label: string;
  value: string;
  source?: string;
}

export interface KitchenStatusState {
  wait_time: number;
  is_emergency: boolean;
  delivery: boolean;
  pickup: boolean;
  reset_at: number;
  payment_details: PaymentDetail[];
  source: string;
  synced_at: string;
}

function kitchenStatusKey(instanceId: string) {
  return `${instanceId}:kitchen_status`;
}

const KITCHEN_CONSENT_TTL_SECONDS = 30 * 60;
const KITCHEN_CHECKOUT_GRACE_TTL_SECONDS = 30 * 60;

function kitchenConsentKey(instanceId: string, phone: string) {
  return `kitchen_consent:${instanceId}:${phone}`;
}

function kitchenCheckoutGraceKey(instanceId: string, phone: string) {
  return `kitchen_checkout_grace:${instanceId}:${phone}`;
}

export async function savePendingKitchenConsent(
  instanceId: string,
  phone: string,
  policyFingerprint: string,
  kind: "delay" | "channel" | "delay_and_channel" = "delay"
): Promise<boolean> {
  return safeRedis(false, async () => {
    const result = await redisClient.set(
      kitchenConsentKey(instanceId, phone),
      JSON.stringify({ policyFingerprint, kind, createdAt: Date.now() }),
      { EX: KITCHEN_CONSENT_TTL_SECONDS }
    );
    return result === "OK";
  });
}

export async function getPendingKitchenConsent(instanceId: string, phone: string): Promise<{ policyFingerprint: string; kind: "delay" | "channel" | "delay_and_channel" } | null> {
  return safeRedis(null, async () => {
    const raw = await redisClient.get(kitchenConsentKey(instanceId, phone));
    if (!raw) return null;
    try {
      const parsed = JSON.parse(raw);
      const kind = ["delay", "channel", "delay_and_channel"].includes(parsed?.kind) ? parsed.kind : "delay";
      return parsed?.policyFingerprint ? { policyFingerprint: String(parsed.policyFingerprint), kind } : null;
    } catch {
      return null;
    }
  });
}

export async function clearPendingKitchenConsent(instanceId: string, phone: string): Promise<void> {
  await safeRedis(undefined, async () => {
    await redisClient.del(kitchenConsentKey(instanceId, phone));
  });
}

// The grace stores the kitchen policy as it stood when the link went out, so a
// guest mid-order is not interrupted for conditions that never changed, while a
// genuine change still reaches them on their next message.
export async function markKitchenCheckoutStarted(instanceId: string, phone: string, policyFingerprint = ""): Promise<boolean> {
  return safeRedis(false, async () => {
    const value = policyFingerprint || String(Date.now());
    const result = await redisClient.set(kitchenCheckoutGraceKey(instanceId, phone), value, { EX: KITCHEN_CHECKOUT_GRACE_TTL_SECONDS });
    return result === "OK";
  });
}

export async function hasActiveKitchenCheckout(instanceId: string, phone: string): Promise<boolean> {
  return safeRedis(false, async () => Boolean(await redisClient.get(kitchenCheckoutGraceKey(instanceId, phone))));
}

export async function getKitchenCheckoutFingerprint(instanceId: string, phone: string): Promise<string | null> {
  return safeRedis(null, async () => {
    const value = await redisClient.get(kitchenCheckoutGraceKey(instanceId, phone));
    return value ? String(value) : null;
  });
}

export async function clearKitchenCheckoutState(instanceId: string, phone: string): Promise<void> {
  await safeRedis(undefined, async () => {
    await redisClient.del([kitchenCheckoutGraceKey(instanceId, phone), kitchenConsentKey(instanceId, phone)]);
  });
}

function toBool(value: unknown, fallback = false): boolean {
  if (typeof value === "boolean") return value;
  if (typeof value === "number") return value !== 0;
  if (typeof value === "string") {
    const normalized = value.trim().toLowerCase();
    if (["1", "true", "yes", "on"].includes(normalized)) return true;
    if (["0", "false", "no", "off"].includes(normalized)) return false;
  }
  return fallback;
}

function parseJsonArray(value: unknown): unknown[] {
  if (Array.isArray(value)) return value;
  if (typeof value !== "string" || !value.trim()) return [];
  try {
    const parsed = JSON.parse(value);
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

function normalizePaymentDetails(value: unknown): PaymentDetail[] {
  return parseJsonArray(value)
    .map((item) => {
      const source = item && typeof item === "object" ? (item as Record<string, unknown>) : {};
      return {
        label: String(source.label || source.name || source.title || "Реквизит").trim().slice(0, 60),
        value: String(source.value || source.number || source.url || source.link || "").trim().slice(0, 250),
        source: source.source ? String(source.source).trim().slice(0, 40) : undefined,
      };
    })
    .filter((item) => item.value)
    .slice(0, 6);
}

function normalizeKitchenWaitTime(value: unknown): number {
  const waitTime = Math.min(720, Math.max(0, Math.floor(Number(value ?? 0) || 0)));
  return waitTime <= 40 ? 0 : waitTime;
}

function normalizeKitchenStatus(
  value: Record<string, any> = {},
  previousPaymentDetails: PaymentDetail[] = []
): KitchenStatusState {
  const paymentDetails = normalizePaymentDetails(value.payment_details).length
    ? normalizePaymentDetails(value.payment_details)
    : previousPaymentDetails;
  const hoursValid = Math.min(120, Math.max(0, Number(value.hours_valid || value.hoursValid || 0) || 0));
  const preserveReset = toBool(value.preserve_reset ?? value.preserveReset, false);
  const now = Math.floor(Date.now() / 1000);
  const resetAt =
    preserveReset
      ? Math.min(now + 5 * 86400, Math.max(0, Number(value.reset_at || value.resetAt || 0) || 0))
      : hoursValid > 0
        ? Math.floor(now + hoursValid * 3600)
        : Math.max(0, Number(value.reset_at || value.resetAt || 0) || 0);

  return {
    wait_time: normalizeKitchenWaitTime(value.wait_time ?? value.waitTime),
    is_emergency: toBool(value.is_emergency ?? value.isEmergency, false),
    delivery: toBool(value.delivery, true),
    pickup: toBool(value.pickup, true),
    reset_at: resetAt,
    payment_details: paymentDetails,
    source: String(value.source || "redis_kitchen_status").trim(),
    synced_at: new Date().toISOString(),
  };
}

function parseHistoryRows(rows: string[], store: "openbot" | "whatspro") {
  return rows.map((item: any, index) => {
    try {
      const entry = JSON.parse(item);
      return { ...entry, __historyStore: store, __historyIndex: index };
    } catch {
      return null;
    }
  }).filter((entry: any) => Boolean(entry) && entry.source !== "openbot_operator_case");
}

function historyRole(entry: any) {
  const role = String(entry?.role || "").trim().toLowerCase();
  const source = String(entry?.source || "").trim().toLowerCase();
  if (role === "operator" || source === "operator_panel" || source === "whatsapp_app") return "operator";
  if (["assistant", "model", "bot", "ai"].includes(role) || entry?.direction === "outgoing" || entry?.fromMe === true) return "assistant";
  if (role === "system") return "system";
  return "user";
}

function mergeConversationHistory(openbotRows: string[], whatsProRows: string[]) {
  const combined = [
    ...parseHistoryRows(openbotRows, "openbot"),
    ...parseHistoryRows(whatsProRows, "whatspro"),
  ].sort((a: any, b: any) =>
    (Number(a?.createdAt || a?.timestamp || 0) - Number(b?.createdAt || b?.timestamp || 0)) ||
    (Number(a?.__historyIndex || 0) - Number(b?.__historyIndex || 0))
  );

  const result: any[] = [];
  const ids = new Set<string>();
  for (const entry of combined) {
    const id = String(entry?.id || entry?.messageId || "").trim();
    if (id && ids.has(id)) continue;

    const role = historyRole(entry);
    const text = String(entry?.text || entry?.body || "").replace(/\s+/g, " ").trim();
    const createdAt = Number(entry?.createdAt || entry?.timestamp || 0) || 0;
    const duplicateIndex = result.findIndex((current) => {
      if (historyRole(current) !== role) return false;
      const currentText = String(current?.text || current?.body || "").replace(/\s+/g, " ").trim();
      const currentAt = Number(current?.createdAt || current?.timestamp || 0) || 0;
      return Boolean(text && text === currentText && createdAt && currentAt && Math.abs(createdAt - currentAt) <= 15000);
    });
    if (duplicateIndex >= 0) {
      if (role === "operator" && historyRole(result[duplicateIndex]) !== "operator") result[duplicateIndex] = entry;
      if (id) ids.add(id);
      continue;
    }
    if (id) ids.add(id);
    result.push(entry);
  }

  return result.map(({ __historyStore, __historyIndex, ...entry }) => entry);
}

export async function getChatHistory(instanceId: string, phone: string): Promise<any[]> {
  return safeRedis([], async () => {
    const [openbotRows, whatsProRows] = await Promise.all([
      redisClient.lRange(historyKey(instanceId, phone), 0, -1),
      redisClient.lRange(whatsProHistoryKey(instanceId, phone), 0, -1),
    ]);
    return mergeConversationHistory(openbotRows, whatsProRows);
  });
}

export async function saveToHistory(
  instanceId: string,
  phone: string,
  role: "user" | "assistant" | "system" | "operator" | "model",
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

export function languageKey(instanceId: string, phone: string) {
  return `lang:${instanceId}:${phone}`;
}

export function siteLanguageHintKey(instanceId: string, phone: string) {
  return `site_lang_hint:${instanceId}:${phone}`;
}

export function receiptFingerprintKey(instanceId: string, fingerprint: string) {
  return `receipt_seen:${instanceId}:${fingerprint}`;
}

export function languageSetOptions() {
  return { EX: USER_LANG_TTL_SECONDS, NX: true as const };
}

export async function getUserLang(instanceId: string, phone: string): Promise<"kk" | "ru" | null> {
  return safeRedis(null, async () => {
    const value = await redisClient.get(languageKey(instanceId, phone));
    return value === "kk" || value === "ru" ? value : null;
  });
}

export async function saveUserLang(instanceId: string, phone: string, lang: "kk" | "ru"): Promise<boolean> {
  return safeRedis(false, async () => {
    const result = await redisClient.set(languageKey(instanceId, phone), lang, languageSetOptions());
    return result === "OK";
  });
}

export async function replaceUserLang(instanceId: string, phone: string, lang: "kk" | "ru"): Promise<boolean> {
  return safeRedis(false, async () => {
    const result = await redisClient.set(languageKey(instanceId, phone), lang, { EX: USER_LANG_TTL_SECONDS });
    return result === "OK";
  });
}

// Support needs to see why a guest is being answered in one language and to undo
// a wrong lock without waiting out its 24 hours.
export async function getUserLangState(instanceId: string, phone: string) {
  return safeRedis({ language: null as "kk" | "ru" | null, ttlSeconds: -2, siteHint: null as "kk" | "ru" | null }, async () => {
    const key = languageKey(instanceId, phone);
    const [value, ttl, hint] = await Promise.all([
      redisClient.get(key),
      redisClient.ttl(key),
      redisClient.get(siteLanguageHintKey(instanceId, phone)),
    ]);
    return {
      language: value === "kk" || value === "ru" ? value : null,
      ttlSeconds: Number(ttl),
      siteHint: hint === "kk" || hint === "ru" ? hint : null,
    };
  });
}

export async function clearUserLang(instanceId: string, phone: string): Promise<number> {
  return safeRedis(0, async () => {
    const removed = await redisClient.del([languageKey(instanceId, phone), siteLanguageHintKey(instanceId, phone)]);
    return Number(removed) || 0;
  });
}

export async function getSiteLanguageHint(instanceId: string, phone: string): Promise<"kk" | "ru" | null> {
  return safeRedis(null, async () => {
    const value = await redisClient.get(siteLanguageHintKey(instanceId, phone));
    return value === "kk" || value === "ru" ? value : null;
  });
}

export async function saveSiteLanguageHint(instanceId: string, phone: string, lang: "kk" | "ru"): Promise<boolean> {
  return safeRedis(false, async () => {
    const result = await redisClient.set(siteLanguageHintKey(instanceId, phone), lang, { EX: SITE_LANG_HINT_TTL_SECONDS });
    return result === "OK";
  });
}

export async function claimReceiptFingerprint(instanceId: string, fingerprint: string): Promise<boolean> {
  return safeRedis(false, async () => {
    const result = await redisClient.set(receiptFingerprintKey(instanceId, fingerprint), "1", {
      EX: RECEIPT_FINGERPRINT_TTL_SECONDS,
      NX: true,
    });
    return result === "OK";
  });
}

export async function releaseReceiptFingerprint(instanceId: string, fingerprint: string): Promise<void> {
  await safeRedis(undefined, async () => {
    await redisClient.del(receiptFingerprintKey(instanceId, fingerprint));
  });
}

export async function saveComplaintMedia(
  instanceId: string,
  phone: string,
  base64: string,
  mimeType: string
): Promise<void> {
  if (!base64) return;
  await safeRedis(undefined, async () => {
    const key = `complaint_media:${instanceId}:${phone}`;
    await redisClient.setEx(key, COMPLAINT_MEDIA_TTL_SECONDS, JSON.stringify({ base64, mimeType }));
  });
}

export async function getComplaintMedia(instanceId: string, phone: string): Promise<Record<string, any> | null> {
  return safeRedis(null, async () => {
    try {
      const data = await redisClient.get(`complaint_media:${instanceId}:${phone}`);
      return data ? JSON.parse(data) : null;
    } catch (error: any) {
      console.warn(`[REDIS] getComplaintMedia read failed (${phone}):`, error?.message || error);
      return null;
    }
  });
}

export async function clearComplaintMedia(instanceId: string, phone: string): Promise<void> {
  await safeRedis(undefined, async () => {
    await redisClient.del(`complaint_media:${instanceId}:${phone}`);
  });
}

// A bare "у меня жалоба" carries nothing an operator can act on. The agent is
// given one turn to ask what happened; this flag guarantees the very next
// message escalates regardless of what it says, so nobody is left waiting.
const COMPLAINT_CLARIFY_TTL_SECONDS = 30 * 60;

function complaintClarifyKey(instanceId: string, phone: string) {
  return `complaint_clarify:${instanceId}:${phone}`;
}

export async function markComplaintClarificationPending(instanceId: string, phone: string, text: string): Promise<boolean> {
  return safeRedis(false, async () => {
    const result = await redisClient.set(complaintClarifyKey(instanceId, phone), String(text || "").slice(0, 900), {
      EX: COMPLAINT_CLARIFY_TTL_SECONDS,
    });
    return result === "OK";
  });
}

export async function takeComplaintClarification(instanceId: string, phone: string): Promise<string | null> {
  return safeRedis(null, async () => {
    const key = complaintClarifyKey(instanceId, phone);
    const value = await redisClient.get(key);
    if (value === null || value === undefined) return null;
    await redisClient.del(key).catch(() => undefined);
    return String(value);
  });
}

export async function hasComplaintClarificationPending(instanceId: string, phone: string): Promise<boolean> {
  return safeRedis(false, async () => Boolean(await redisClient.get(complaintClarifyKey(instanceId, phone))));
}

export async function saveDailyLog(instanceId: string, logData: Record<string, any>): Promise<void> {
  await safeRedis(undefined, async () => {
    const key = `daily_logs:${instanceId}`;
    try {
      await redisClient.rPush(key, JSON.stringify(logData));
      await redisClient.expire(key, DAILY_LOG_TTL_SECONDS);
    } catch (error: any) {
      console.error(`[REDIS] Daily log save failed (${instanceId}):`, error?.message || error);
    }
  });
}

export async function saveKitchenStatus(
  instanceId: string,
  value: Record<string, any>
): Promise<KitchenStatusState> {
  const previous = await getKitchenStatus(instanceId).catch(() => null);
  const status = normalizeKitchenStatus(value, previous?.payment_details || []);
  await safeRedis(undefined, async () => {
    await redisClient.setEx(kitchenStatusKey(instanceId), KITCHEN_STATUS_TTL_SECONDS, JSON.stringify(status));
  });
  return status;
}

export async function getKitchenStatus(instanceId: string): Promise<KitchenStatusState | null> {
  return safeRedis(null, async () => {
    const raw = await redisClient.get(kitchenStatusKey(instanceId));
    if (!raw) return null;
    const parsed = JSON.parse(raw);
    const current = normalizeKitchenStatus(parsed && typeof parsed === "object" ? parsed : {});
    if (current.reset_at > 0 && current.reset_at <= Math.floor(Date.now() / 1000)) {
      const reset = normalizeKitchenStatus({
        wait_time: 0,
        is_emergency: false,
        delivery: true,
        pickup: true,
        reset_at: 0,
        payment_details: current.payment_details,
        source: "redis_kitchen_status_reset",
      });
      await redisClient.setEx(kitchenStatusKey(instanceId), KITCHEN_STATUS_TTL_SECONDS, JSON.stringify(reset));
      return reset;
    }
    return current;
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

async function purgeShiftNoteIdsFromHistory(instanceId: string, noteIds: string[]): Promise<number> {
  const ids = new Set(noteIds.map(String).filter(Boolean));
  if (!ids.size) return 0;
  let removedTotal = 0;
  const keys = await scanKeys(`history:${instanceId}:*`);
  for (const key of keys) {
    const ttlBefore = await redisClient.ttl(key).catch(() => -1);
    const rows = await redisClient.lRange(key, 0, -1).catch(() => []);
    const kept = rows.filter((raw) => {
      try {
        const entry = JSON.parse(raw);
        const sourceNoteIds = Array.isArray(entry?.sourceNoteIds) ? entry.sourceNoteIds.map(String) : [];
        return !sourceNoteIds.some((id: string) => ids.has(id));
      } catch { return true; }
    });
    const removed = rows.length - kept.length;
    if (!removed) continue;
    const multi = redisClient.multi().del(key);
    kept.forEach((row) => multi.rPush(key, row));
    await multi.exec();
    if (kept.length && ttlBefore > 0) await redisClient.expire(key, ttlBefore);
    // The rolling summary is written from this history, so a note that was
    // just deleted survives inside it ("pizza was unavailable") and reaches
    // the prompt again long after the operator removed it. The summary is a
    // derived cache: dropping it makes the next turn rebuild it from what is
    // actually left, which is the only state the guest may hear about.
    await redisClient.del(key.replace(/^history:/, "conv_summary:")).catch(() => undefined);
    removedTotal += removed;
  }
  return removedTotal;
}

export async function scanKeys(pattern: string): Promise<string[]> {
  await connectRedis();
  const keys: string[] = [];
  for await (const chunk of redisClient.scanIterator({ MATCH: pattern, COUNT: 100 })) {
    if (Array.isArray(chunk)) keys.push(...chunk.map(String));
    else keys.push(String(chunk));
  }
  return keys;
}

const SHIFT_NOTE_DEFAULT_TTL_SECONDS = 24 * 60 * 60;

/**
 * Parses whatever expiry format the DLE site sends into a TTL.
 *
 * The hidden bug: a Unix timestamp in SECONDS ("1785400000") goes through
 * Date.parse as garbage (NaN in V8), so every note with an epoch expiry
 * silently lived the default 24h instead of its real lifetime. Numeric strings
 * are now detected explicitly: >=1e12 is treated as milliseconds, >=1e9 as
 * seconds; anything else falls back to Date.parse; unreadable values fall back
 * to the 24h default.
 *
 * A timestamp that is already in the past returns 0: the operator meant the note
 * to be over, and defaulting it to a full day kept a stale restriction alive for
 * 24 hours (audit, 2026-08-12). Only an unreadable expiry gets the default.
 */
export function resolveShiftNoteTtlSeconds(expiresAtString?: string, nowMs = Date.now()): number {
  const raw = String(expiresAtString || "").trim();
  if (!raw) return SHIFT_NOTE_DEFAULT_TTL_SECONDS;
  let expiresAtMs = 0;
  if (/^\d{10,16}$/.test(raw)) {
    const numeric = Number(raw);
    expiresAtMs = numeric >= 1e12 ? numeric : numeric * 1000;
  } else {
    const parsed = Date.parse(raw);
    if (Number.isFinite(parsed)) expiresAtMs = parsed;
  }
  if (!Number.isFinite(expiresAtMs) || expiresAtMs <= 0) return SHIFT_NOTE_DEFAULT_TTL_SECONDS;
  if (expiresAtMs <= nowMs) return 0;
  return Math.max(60, Math.ceil((expiresAtMs - nowMs) / 1000));
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

    const ttlSeconds = resolveShiftNoteTtlSeconds(expiresAtString);
    // An expiry already in the past means the note is over before it arrives.
    // Storing it would restrict the menu for a shift that has ended.
    if (ttlSeconds <= 0) return false;

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
): Promise<number> {
  return safeRedis(0, async () => {
    const safeNoteId = String(noteId || "").trim();
    const expectedText = String(text || "").trim().toLowerCase();
    const deletedIds: string[] = [];
    const deleteKey = async (key: string) => {
      if (await redisClient.del(key)) deletedIds.push(key.split(":").pop() || "");
    };
    // A delete must name its target: the note id, or failing that the exact text
    // of one note. Nothing else is removed. The previous fallback wiped every
    // note of the instance when neither was supplied, so one malformed webhook
    // erased a whole shift and the agent kept answering from stale memory.
    if (safeNoteId && safeNoteId !== "0") await deleteKey(`shift_note:${instanceId}:${safeNoteId}`);
    if (!deletedIds.length && expectedText) {
      const keys = await scanKeys(`shift_note:${instanceId}:*`);
      for (const key of keys) {
        const stored = parseShiftNoteRecord((await redisClient.get(key).catch(() => "")) || "");
        if (stored.text.toLowerCase().trim() === expectedText) await deleteKey(key);
      }
    }
    await purgeShiftNoteIdsFromHistory(instanceId, deletedIds);
    // The count is what lets the webhook stop answering "note removed" when it
    // removed nothing at all (audit, 2026-08-12).
    return deletedIds.length;
  });
}

export async function getActiveShiftNotes(instanceId: string): Promise<Array<{ noteId: string; text: string; expiresAt?: number }>> {
  return safeRedis([], async () => {
    const keys = await scanKeys(`shift_note:${instanceId}:*`);
    const notes = [];
    for (const key of keys) {
      const note = parseShiftNoteRecord((await redisClient.get(key)) || "");
      if (!note.text || note.expired || note.plain) {
        const noteId = key.split(":").pop() || "";
        await redisClient.del(key).catch(() => undefined);
        // An explicit delete purges the note's trace from history and the rolling
        // summary; expiry used to drop only the key, so the summary kept telling
        // the next turn that drinks were unavailable for another 30 days.
        if (noteId) await purgeShiftNoteIdsFromHistory(instanceId, [noteId]).catch(() => undefined);
        continue;
      }
      notes.push({ noteId: key.split(":").pop() || "", text: note.text, expiresAt: note.expiresAt || undefined });
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
