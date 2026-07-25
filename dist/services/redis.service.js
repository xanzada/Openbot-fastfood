import crypto from "node:crypto";
import { createClient } from "redis";
const redisClient = createClient({
  url: process.env.REDIS_URL || "redis://localhost:6379"
});
let redisReady = null;
let redisConnectLogged = false;
function getRedisTarget() {
  const raw = process.env.REDIS_URL || "redis://localhost:6379";
  try {
    const url = new URL(raw);
    return {
      host: url.hostname || "unknown",
      port: url.port || "6379",
      database: url.pathname?.replace("/", "") || "0",
      configured: Boolean(process.env.REDIS_URL)
    };
  } catch {
    return {
      host: "invalid-url",
      port: "",
      database: "",
      configured: Boolean(process.env.REDIS_URL)
    };
  }
}
redisClient.on("error", (error) => {
  console.error("[REDIS] error:", error?.message || error);
});
async function connectRedis() {
  if (redisClient.isOpen) return;
  if (!redisReady) {
    const target = getRedisTarget();
    if (!redisConnectLogged) {
      console.log(`[OPENBOT:REDIS] connecting host=${target.host} port=${target.port} db=${target.database}`);
      redisConnectLogged = true;
    }
    redisReady = redisClient.connect().then(() => {
      console.log(`[OPENBOT:REDIS] connected host=${target.host} port=${target.port}`);
    }).catch((error) => {
      redisReady = null;
      console.error(`[OPENBOT:REDIS] connect failed host=${target.host} port=${target.port}:`, error?.message || error);
      throw error;
    });
  }
  await redisReady;
}
async function pingRedis() {
  await connectRedis();
  return redisClient.ping();
}
async function safeRedis(fallback, fn) {
  try {
    await connectRedis();
    return await fn();
  } catch {
    return fallback;
  }
}
function historyKey(instanceId, phone) {
  return `history:${instanceId}:${phone}`;
}
function whatsProHistoryKey(instanceId, phone) {
  return `chatwoot:history:${instanceId}:${phone}`;
}
function magicLinkKey(instanceId, phone) {
  return `has_sent_link:${instanceId}:${phone}`;
}
const CHAT_HISTORY_TTL_SECONDS = 604800;
const CHAT_HISTORY_MAX_ITEMS = 120;
const MAGIC_LINK_SENT_TTL_SECONDS = 2592e3;
const USER_LANG_TTL_SECONDS = 24 * 60 * 60;
const SITE_LANG_HINT_TTL_SECONDS = 24 * 60 * 60;
const RECEIPT_FINGERPRINT_TTL_SECONDS = 7 * 24 * 60 * 60;
const COMPLAINT_MEDIA_TTL_SECONDS = 300;
const DAILY_LOG_TTL_SECONDS = 172800;
const KITCHEN_STATUS_TTL_SECONDS = 604800;
function kitchenStatusKey(instanceId) {
  return `${instanceId}:kitchen_status`;
}
const KITCHEN_CONSENT_TTL_SECONDS = 30 * 60;
const KITCHEN_CHECKOUT_GRACE_TTL_SECONDS = 30 * 60;
function kitchenConsentKey(instanceId, phone) {
  return `kitchen_consent:${instanceId}:${phone}`;
}
function kitchenCheckoutGraceKey(instanceId, phone) {
  return `kitchen_checkout_grace:${instanceId}:${phone}`;
}
async function savePendingKitchenConsent(instanceId, phone, policyFingerprint, kind = "delay") {
  return safeRedis(false, async () => {
    const result = await redisClient.set(
      kitchenConsentKey(instanceId, phone),
      JSON.stringify({ policyFingerprint, kind, createdAt: Date.now() }),
      { EX: KITCHEN_CONSENT_TTL_SECONDS }
    );
    return result === "OK";
  });
}
async function getPendingKitchenConsent(instanceId, phone) {
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
async function clearPendingKitchenConsent(instanceId, phone) {
  await safeRedis(void 0, async () => {
    await redisClient.del(kitchenConsentKey(instanceId, phone));
  });
}
async function markKitchenCheckoutStarted(instanceId, phone) {
  return safeRedis(false, async () => {
    const result = await redisClient.set(kitchenCheckoutGraceKey(instanceId, phone), String(Date.now()), { EX: KITCHEN_CHECKOUT_GRACE_TTL_SECONDS });
    return result === "OK";
  });
}
async function hasActiveKitchenCheckout(instanceId, phone) {
  return safeRedis(false, async () => Boolean(await redisClient.get(kitchenCheckoutGraceKey(instanceId, phone))));
}
async function clearKitchenCheckoutState(instanceId, phone) {
  await safeRedis(void 0, async () => {
    await redisClient.del(kitchenCheckoutGraceKey(instanceId, phone), kitchenConsentKey(instanceId, phone));
  });
}
function toBool(value, fallback = false) {
  if (typeof value === "boolean") return value;
  if (typeof value === "number") return value !== 0;
  if (typeof value === "string") {
    const normalized = value.trim().toLowerCase();
    if (["1", "true", "yes", "on"].includes(normalized)) return true;
    if (["0", "false", "no", "off"].includes(normalized)) return false;
  }
  return fallback;
}
function parseJsonArray(value) {
  if (Array.isArray(value)) return value;
  if (typeof value !== "string" || !value.trim()) return [];
  try {
    const parsed = JSON.parse(value);
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}
function normalizePaymentDetails(value) {
  return parseJsonArray(value).map((item) => {
    const source = item && typeof item === "object" ? item : {};
    return {
      label: String(source.label || source.name || source.title || "\u0420\u0435\u043A\u0432\u0438\u0437\u0438\u0442").trim().slice(0, 60),
      value: String(source.value || source.number || source.url || source.link || "").trim().slice(0, 250),
      source: source.source ? String(source.source).trim().slice(0, 40) : void 0
    };
  }).filter((item) => item.value).slice(0, 6);
}
function normalizeKitchenWaitTime(value) {
  const waitTime = Math.min(720, Math.max(0, Math.floor(Number(value ?? 0) || 0)));
  return waitTime <= 40 ? 0 : waitTime;
}
function normalizeKitchenStatus(value = {}, previousPaymentDetails = []) {
  const paymentDetails = normalizePaymentDetails(value.payment_details).length ? normalizePaymentDetails(value.payment_details) : previousPaymentDetails;
  const hoursValid = Math.min(120, Math.max(0, Number(value.hours_valid || value.hoursValid || 0) || 0));
  const preserveReset = toBool(value.preserve_reset ?? value.preserveReset, false);
  const now = Math.floor(Date.now() / 1e3);
  const resetAt = preserveReset ? Math.min(now + 5 * 86400, Math.max(0, Number(value.reset_at || value.resetAt || 0) || 0)) : hoursValid > 0 ? Math.floor(now + hoursValid * 3600) : Math.max(0, Number(value.reset_at || value.resetAt || 0) || 0);
  return {
    wait_time: normalizeKitchenWaitTime(value.wait_time ?? value.waitTime),
    is_emergency: toBool(value.is_emergency ?? value.isEmergency, false),
    delivery: toBool(value.delivery, true),
    pickup: toBool(value.pickup, true),
    reset_at: resetAt,
    payment_details: paymentDetails,
    source: String(value.source || "redis_kitchen_status").trim(),
    synced_at: (/* @__PURE__ */ new Date()).toISOString()
  };
}
function parseHistoryRows(rows, store) {
  return rows.map((item, index) => {
    try {
      const entry = JSON.parse(item);
      return { ...entry, __historyStore: store, __historyIndex: index };
    } catch {
      return null;
    }
  }).filter((entry) => Boolean(entry) && entry.source !== "openbot_operator_case");
}
function historyRole(entry) {
  const role = String(entry?.role || "").trim().toLowerCase();
  const source = String(entry?.source || "").trim().toLowerCase();
  if (role === "operator" || source === "operator_panel" || source === "whatsapp_app") return "operator";
  if (["assistant", "model", "bot", "ai"].includes(role) || entry?.direction === "outgoing" || entry?.fromMe === true) return "assistant";
  if (role === "system") return "system";
  return "user";
}
function mergeConversationHistory(openbotRows, whatsProRows) {
  const combined = [
    ...parseHistoryRows(openbotRows, "openbot"),
    ...parseHistoryRows(whatsProRows, "whatspro")
  ].sort(
    (a, b) => Number(a?.createdAt || a?.timestamp || 0) - Number(b?.createdAt || b?.timestamp || 0) || Number(a?.__historyIndex || 0) - Number(b?.__historyIndex || 0)
  );
  const result = [];
  const ids = /* @__PURE__ */ new Set();
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
      return Boolean(text && text === currentText && createdAt && currentAt && Math.abs(createdAt - currentAt) <= 15e3);
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
async function getChatHistory(instanceId, phone) {
  return safeRedis([], async () => {
    const [openbotRows, whatsProRows] = await Promise.all([
      redisClient.lRange(historyKey(instanceId, phone), 0, -1),
      redisClient.lRange(whatsProHistoryKey(instanceId, phone), 0, -1)
    ]);
    return mergeConversationHistory(openbotRows, whatsProRows);
  });
}
async function saveToHistory(instanceId, phone, role, text, meta = {}) {
  if (!text) return;
  await safeRedis(void 0, async () => {
    const key = historyKey(instanceId, phone);
    const ttlBefore = await redisClient.ttl(key);
    const entry = JSON.stringify({ role, text, createdAt: Date.now(), ...meta });
    await redisClient.multi().rPush(key, entry).lTrim(key, -CHAT_HISTORY_MAX_ITEMS, -1).exec();
    if (ttlBefore < 0) await redisClient.expire(key, CHAT_HISTORY_TTL_SECONDS);
  });
}
function languageKey(instanceId, phone) {
  return `lang:${instanceId}:${phone}`;
}
function siteLanguageHintKey(instanceId, phone) {
  return `site_lang_hint:${instanceId}:${phone}`;
}
function receiptFingerprintKey(instanceId, fingerprint) {
  return `receipt_seen:${instanceId}:${fingerprint}`;
}
function languageSetOptions() {
  return { EX: USER_LANG_TTL_SECONDS, NX: true };
}
async function getUserLang(instanceId, phone) {
  return safeRedis(null, async () => {
    const value = await redisClient.get(languageKey(instanceId, phone));
    return value === "kk" || value === "ru" ? value : null;
  });
}
async function saveUserLang(instanceId, phone, lang) {
  return safeRedis(false, async () => {
    const result = await redisClient.set(languageKey(instanceId, phone), lang, languageSetOptions());
    return result === "OK";
  });
}
async function getSiteLanguageHint(instanceId, phone) {
  return safeRedis(null, async () => {
    const value = await redisClient.get(siteLanguageHintKey(instanceId, phone));
    return value === "kk" || value === "ru" ? value : null;
  });
}
async function saveSiteLanguageHint(instanceId, phone, lang) {
  return safeRedis(false, async () => {
    const result = await redisClient.set(siteLanguageHintKey(instanceId, phone), lang, { EX: SITE_LANG_HINT_TTL_SECONDS });
    return result === "OK";
  });
}
async function claimReceiptFingerprint(instanceId, fingerprint) {
  return safeRedis(false, async () => {
    const result = await redisClient.set(receiptFingerprintKey(instanceId, fingerprint), "1", {
      EX: RECEIPT_FINGERPRINT_TTL_SECONDS,
      NX: true
    });
    return result === "OK";
  });
}
async function releaseReceiptFingerprint(instanceId, fingerprint) {
  await safeRedis(void 0, async () => {
    await redisClient.del(receiptFingerprintKey(instanceId, fingerprint));
  });
}
async function saveComplaintMedia(instanceId, phone, base64, mimeType) {
  if (!base64) return;
  await safeRedis(void 0, async () => {
    const key = `complaint_media:${instanceId}:${phone}`;
    await redisClient.setEx(key, COMPLAINT_MEDIA_TTL_SECONDS, JSON.stringify({ base64, mimeType }));
  });
}
async function getComplaintMedia(instanceId, phone) {
  return safeRedis(null, async () => {
    try {
      const data = await redisClient.get(`complaint_media:${instanceId}:${phone}`);
      return data ? JSON.parse(data) : null;
    } catch (error) {
      console.warn(`[REDIS] getComplaintMedia read failed (${phone}):`, error?.message || error);
      return null;
    }
  });
}
async function clearComplaintMedia(instanceId, phone) {
  await safeRedis(void 0, async () => {
    await redisClient.del(`complaint_media:${instanceId}:${phone}`);
  });
}
async function saveDailyLog(instanceId, logData) {
  await safeRedis(void 0, async () => {
    const key = `daily_logs:${instanceId}`;
    try {
      await redisClient.rPush(key, JSON.stringify(logData));
      await redisClient.expire(key, DAILY_LOG_TTL_SECONDS);
    } catch (error) {
      console.error(`[REDIS] Daily log save failed (${instanceId}):`, error?.message || error);
    }
  });
}
async function saveKitchenStatus(instanceId, value) {
  const previous = await getKitchenStatus(instanceId).catch(() => null);
  const status = normalizeKitchenStatus(value, previous?.payment_details || []);
  await safeRedis(void 0, async () => {
    await redisClient.setEx(kitchenStatusKey(instanceId), KITCHEN_STATUS_TTL_SECONDS, JSON.stringify(status));
  });
  return status;
}
async function getKitchenStatus(instanceId) {
  return safeRedis(null, async () => {
    const raw = await redisClient.get(kitchenStatusKey(instanceId));
    if (!raw) return null;
    const parsed = JSON.parse(raw);
    const current = normalizeKitchenStatus(parsed && typeof parsed === "object" ? parsed : {});
    if (current.reset_at > 0 && current.reset_at <= Math.floor(Date.now() / 1e3)) {
      const reset = normalizeKitchenStatus({
        wait_time: 0,
        is_emergency: false,
        delivery: true,
        pickup: true,
        reset_at: 0,
        payment_details: current.payment_details,
        source: "redis_kitchen_status_reset"
      });
      await redisClient.setEx(kitchenStatusKey(instanceId), KITCHEN_STATUS_TTL_SECONDS, JSON.stringify(reset));
      return reset;
    }
    return current;
  });
}
async function hasMagicLinkBeenSent(instanceId, phone) {
  return safeRedis(false, async () => Boolean(await redisClient.get(magicLinkKey(instanceId, phone))));
}
async function markMagicLinkSent(instanceId, phone) {
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
      expiresAt
    };
  } catch {
    return { text, plain: true, expired: false, expiresAt: 0 };
  }
}
async function purgeShiftNoteIdsFromHistory(instanceId, noteIds) {
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
        return !sourceNoteIds.some((id) => ids.has(id));
      } catch {
        return true;
      }
    });
    const removed = rows.length - kept.length;
    if (!removed) continue;
    const multi = redisClient.multi().del(key);
    kept.forEach((row) => multi.rPush(key, row));
    await multi.exec();
    if (kept.length && ttlBefore > 0) await redisClient.expire(key, ttlBefore);
    removedTotal += removed;
  }
  return removedTotal;
}
async function scanKeys(pattern) {
  await connectRedis();
  const keys = [];
  for await (const chunk of redisClient.scanIterator({ MATCH: pattern, COUNT: 100 })) {
    if (Array.isArray(chunk)) keys.push(...chunk.map(String));
    else keys.push(String(chunk));
  }
  return keys;
}
async function saveShiftNote(instanceId, noteId, text, expiresAtString) {
  const noteText = String(text || "").trim();
  if (!noteText) return false;
  return safeRedis(false, async () => {
    const safeNoteId = String(noteId || "").trim() || `fallback_${crypto.createHash("sha1").update(`${instanceId}|${noteText}|${expiresAtString || ""}`).digest("hex").slice(0, 16)}`;
    let ttlSeconds = 24 * 60 * 60;
    const expiresAt = expiresAtString ? Date.parse(expiresAtString) : 0;
    if (Number.isFinite(expiresAt) && expiresAt > Date.now()) {
      ttlSeconds = Math.max(60, Math.ceil((expiresAt - Date.now()) / 1e3));
    }
    await redisClient.setEx(
      `shift_note:${instanceId}:${safeNoteId}`,
      ttlSeconds,
      JSON.stringify({ text: noteText, createdAt: Date.now(), expiresAt: Date.now() + ttlSeconds * 1e3 })
    );
    return true;
  });
}
async function deleteShiftNote(instanceId, noteId, text = "") {
  await safeRedis(void 0, async () => {
    const safeNoteId = String(noteId || "").trim();
    const expectedText = String(text || "").trim().toLowerCase();
    const deletedIds = [];
    const deleteKey = async (key) => {
      if (await redisClient.del(key)) deletedIds.push(key.split(":").pop() || "");
    };
    if (safeNoteId && safeNoteId !== "0") await deleteKey(`shift_note:${instanceId}:${safeNoteId}`);
    if (!deletedIds.length) {
      const keys = await scanKeys(`shift_note:${instanceId}:*`);
      for (const key of keys) {
        const stored = parseShiftNoteRecord(await redisClient.get(key).catch(() => "") || "");
        const exactMatch = expectedText && stored.text.toLowerCase().trim() === expectedText;
        if (exactMatch || (!safeNoteId || safeNoteId === "0") && !expectedText) await deleteKey(key);
      }
    }
    await purgeShiftNoteIdsFromHistory(instanceId, deletedIds);
  });
}
async function getActiveShiftNotes(instanceId) {
  return safeRedis([], async () => {
    const keys = await scanKeys(`shift_note:${instanceId}:*`);
    const notes = [];
    for (const key of keys) {
      const note = parseShiftNoteRecord(await redisClient.get(key) || "");
      if (!note.text || note.expired || note.plain) {
        await redisClient.del(key).catch(() => void 0);
        continue;
      }
      notes.push({ noteId: key.split(":").pop() || "", text: note.text, expiresAt: note.expiresAt || void 0 });
    }
    return notes;
  });
}
async function getJsonCache(key) {
  return safeRedis(null, async () => {
    const raw = await redisClient.get(key);
    return raw ? JSON.parse(raw) : null;
  });
}
async function setJsonCache(key, ttlSeconds, value) {
  await safeRedis(void 0, async () => {
    await redisClient.setEx(key, ttlSeconds, JSON.stringify(value));
  });
}
async function deleteCache(key) {
  await safeRedis(void 0, async () => {
    await redisClient.del(key);
  });
}
export {
  SITE_LANG_HINT_TTL_SECONDS,
  USER_LANG_TTL_SECONDS,
  claimReceiptFingerprint,
  clearComplaintMedia,
  clearKitchenCheckoutState,
  clearPendingKitchenConsent,
  connectRedis,
  deleteCache,
  deleteShiftNote,
  getActiveShiftNotes,
  getChatHistory,
  getComplaintMedia,
  getJsonCache,
  getKitchenStatus,
  getPendingKitchenConsent,
  getRedisTarget,
  getSiteLanguageHint,
  getUserLang,
  hasActiveKitchenCheckout,
  hasMagicLinkBeenSent,
  languageKey,
  languageSetOptions,
  markKitchenCheckoutStarted,
  markMagicLinkSent,
  pingRedis,
  receiptFingerprintKey,
  redisClient,
  releaseReceiptFingerprint,
  saveComplaintMedia,
  saveDailyLog,
  saveKitchenStatus,
  savePendingKitchenConsent,
  saveShiftNote,
  saveSiteLanguageHint,
  saveToHistory,
  saveUserLang,
  setJsonCache,
  siteLanguageHintKey
};
