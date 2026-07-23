import crypto from "node:crypto";
import { createClient } from "redis";
export const redisClient = createClient({
    url: process.env.REDIS_URL || "redis://localhost:6379",
});
let redisReady = null;
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
    }
    catch {
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
export async function connectRedis() {
    if (redisClient.isOpen)
        return;
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
export async function pingRedis() {
    await connectRedis();
    return redisClient.ping();
}
async function safeRedis(fallback, fn) {
    try {
        await connectRedis();
        return await fn();
    }
    catch {
        return fallback;
    }
}
function historyKey(instanceId, phone) {
    return `history:${instanceId}:${phone}`;
}
function magicLinkKey(instanceId, phone) {
    return `has_sent_link:${instanceId}:${phone}`;
}
const CHAT_HISTORY_TTL_SECONDS = 604800;
const CHAT_HISTORY_MAX_ITEMS = 120;
const MAGIC_LINK_SENT_TTL_SECONDS = 2592000;
export const USER_LANG_TTL_SECONDS = 21600;
const RECEIPT_FINGERPRINT_TTL_SECONDS = 7 * 24 * 60 * 60;
const COMPLAINT_MEDIA_TTL_SECONDS = 300;
const DAILY_LOG_TTL_SECONDS = 172800;
const KITCHEN_STATUS_TTL_SECONDS = 604800;
function kitchenStatusKey(instanceId) {
    return `${instanceId}:kitchen_status`;
}
function toBool(value, fallback = false) {
    if (typeof value === "boolean")
        return value;
    if (typeof value === "number")
        return value !== 0;
    if (typeof value === "string") {
        const normalized = value.trim().toLowerCase();
        if (["1", "true", "yes", "on"].includes(normalized))
            return true;
        if (["0", "false", "no", "off"].includes(normalized))
            return false;
    }
    return fallback;
}
function parseJsonArray(value) {
    if (Array.isArray(value))
        return value;
    if (typeof value !== "string" || !value.trim())
        return [];
    try {
        const parsed = JSON.parse(value);
        return Array.isArray(parsed) ? parsed : [];
    }
    catch {
        return [];
    }
}
function normalizePaymentDetails(value) {
    return parseJsonArray(value)
        .map((item) => {
        const source = item && typeof item === "object" ? item : {};
        return {
            label: String(source.label || source.name || source.title || "Реквизит").trim().slice(0, 60),
            value: String(source.value || source.number || source.url || source.link || "").trim().slice(0, 250),
            source: source.source ? String(source.source).trim().slice(0, 40) : undefined,
        };
    })
        .filter((item) => item.value)
        .slice(0, 6);
}
function normalizeKitchenWaitTime(value) {
    const waitTime = Math.min(720, Math.max(0, Math.floor(Number(value ?? 0) || 0)));
    return waitTime <= 40 ? 0 : waitTime;
}
function normalizeKitchenStatus(value = {}, previousPaymentDetails = []) {
    const paymentDetails = normalizePaymentDetails(value.payment_details).length
        ? normalizePaymentDetails(value.payment_details)
        : previousPaymentDetails;
    const hoursValid = Math.min(24, Math.max(0, Number(value.hours_valid || value.hoursValid || 0) || 0));
    const preserveReset = toBool(value.preserve_reset ?? value.preserveReset, false);
    const now = Math.floor(Date.now() / 1000);
    const resetAt = preserveReset
        ? Math.min(now + 86400, Math.max(0, Number(value.reset_at || value.resetAt || 0) || 0))
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
export async function getChatHistory(instanceId, phone) {
    return safeRedis([], async () => {
        const raw = await redisClient.lRange(historyKey(instanceId, phone), 0, -1);
        return raw
            .map((item) => {
            try {
                return JSON.parse(item);
            }
            catch {
                return null;
            }
        })
            .filter(Boolean);
    });
}
export async function saveToHistory(instanceId, phone, role, text, meta = {}) {
    if (!text)
        return;
    await safeRedis(undefined, async () => {
        const key = historyKey(instanceId, phone);
        const ttlBefore = await redisClient.ttl(key);
        const entry = JSON.stringify({ role, text, createdAt: Date.now(), ...meta });
        await redisClient.multi().rPush(key, entry).lTrim(key, -CHAT_HISTORY_MAX_ITEMS, -1).exec();
        if (ttlBefore < 0)
            await redisClient.expire(key, CHAT_HISTORY_TTL_SECONDS);
    });
}
export function languageKey(instanceId, phone) {
    return `lang:${instanceId}:${phone}`;
}
export function receiptFingerprintKey(instanceId, fingerprint) {
    return `receipt_seen:${instanceId}:${fingerprint}`;
}
export function languageSetOptions() {
    return { EX: USER_LANG_TTL_SECONDS, NX: true };
}
export async function getUserLang(instanceId, phone) {
    return safeRedis(null, async () => {
        const value = await redisClient.get(languageKey(instanceId, phone));
        return value === "kk" || value === "ru" ? value : null;
    });
}
export async function saveUserLang(instanceId, phone, lang) {
    return safeRedis(false, async () => {
        const result = await redisClient.set(languageKey(instanceId, phone), lang, languageSetOptions());
        return result === "OK";
    });
}
export async function claimReceiptFingerprint(instanceId, fingerprint) {
    return safeRedis(false, async () => {
        const result = await redisClient.set(receiptFingerprintKey(instanceId, fingerprint), "1", {
            EX: RECEIPT_FINGERPRINT_TTL_SECONDS,
            NX: true,
        });
        return result === "OK";
    });
}
export async function releaseReceiptFingerprint(instanceId, fingerprint) {
    await safeRedis(undefined, async () => {
        await redisClient.del(receiptFingerprintKey(instanceId, fingerprint));
    });
}
export async function saveComplaintMedia(instanceId, phone, base64, mimeType) {
    if (!base64)
        return;
    await safeRedis(undefined, async () => {
        const key = `complaint_media:${instanceId}:${phone}`;
        await redisClient.setEx(key, COMPLAINT_MEDIA_TTL_SECONDS, JSON.stringify({ base64, mimeType }));
    });
}
export async function getComplaintMedia(instanceId, phone) {
    return safeRedis(null, async () => {
        try {
            const data = await redisClient.get(`complaint_media:${instanceId}:${phone}`);
            return data ? JSON.parse(data) : null;
        }
        catch (error) {
            console.warn(`[REDIS] getComplaintMedia read failed (${phone}):`, error?.message || error);
            return null;
        }
    });
}
export async function clearComplaintMedia(instanceId, phone) {
    await safeRedis(undefined, async () => {
        await redisClient.del(`complaint_media:${instanceId}:${phone}`);
    });
}
export async function saveDailyLog(instanceId, logData) {
    await safeRedis(undefined, async () => {
        const key = `daily_logs:${instanceId}`;
        try {
            await redisClient.rPush(key, JSON.stringify(logData));
            await redisClient.expire(key, DAILY_LOG_TTL_SECONDS);
        }
        catch (error) {
            console.error(`[REDIS] Daily log save failed (${instanceId}):`, error?.message || error);
        }
    });
}
export async function saveKitchenStatus(instanceId, value) {
    const previous = await getKitchenStatus(instanceId).catch(() => null);
    const status = normalizeKitchenStatus(value, previous?.payment_details || []);
    await safeRedis(undefined, async () => {
        await redisClient.setEx(kitchenStatusKey(instanceId), KITCHEN_STATUS_TTL_SECONDS, JSON.stringify(status));
    });
    return status;
}
export async function getKitchenStatus(instanceId) {
    return safeRedis(null, async () => {
        const raw = await redisClient.get(kitchenStatusKey(instanceId));
        if (!raw)
            return null;
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
export async function hasMagicLinkBeenSent(instanceId, phone) {
    return safeRedis(false, async () => Boolean(await redisClient.get(magicLinkKey(instanceId, phone))));
}
export async function markMagicLinkSent(instanceId, phone) {
    return safeRedis(false, async () => {
        await redisClient.setEx(magicLinkKey(instanceId, phone), MAGIC_LINK_SENT_TTL_SECONDS, String(Date.now()));
        return true;
    });
}
function parseShiftNoteRecord(raw = "") {
    const text = String(raw || "").trim();
    if (!text)
        return { text: "", plain: false, expired: false, expiresAt: 0 };
    try {
        const parsed = JSON.parse(text);
        const expiresAt = Number(parsed?.expiresAt || parsed?.expires_at || 0);
        return {
            text: String(parsed?.text || "").trim(),
            plain: false,
            expired: Boolean(expiresAt && expiresAt <= Date.now()),
            expiresAt,
        };
    }
    catch {
        return { text, plain: true, expired: false, expiresAt: 0 };
    }
}
function normalizeShiftNoteText(value) {
    return String(value || "")
        .toLowerCase()
        .replace(/[\r\n\t]+/g, " ")
        .replace(/\s+/g, " ")
        .trim();
}
function shiftNoteTextMatches(currentText, expectedText) {
    const current = normalizeShiftNoteText(currentText);
    const expected = normalizeShiftNoteText(expectedText);
    if (!current || !expected)
        return false;
    if (current === expected)
        return true;
    return (expected.length >= 8 && current.includes(expected)) || (current.length >= 8 && expected.includes(current));
}
const SHIFT_NOTE_DERIVED_RE = /(уақытша|уакытша|қабылдай алмай|кабылдай алмай|кідіріс|кедіріс|кешігу|задерж|временно|не можем принять|нет в наличии|ас үй|ас уй|кухн|минут|мин|суши|ролл|донер|пицц|свет|жарық|жарык|демалыс|курьер)/iu;
function isDerivedShiftNoteHistory(historyText, noteText) {
    const history = normalizeShiftNoteText(historyText);
    const note = normalizeShiftNoteText(noteText);
    if (!history || !note)
        return false;
    if (shiftNoteTextMatches(history, note))
        return true;
    if (!SHIFT_NOTE_DERIVED_RE.test(history))
        return false;
    const noteTokens = note
        .split(/[^\p{L}\p{N}]+/u)
        .filter((token) => token.length >= 3 && !/^(мин|минут|бар|жок|жоқ|нет|есть|қазір|казир|сейчас)$/iu.test(token));
    return !noteTokens.length || noteTokens.some((token) => history.includes(token));
}
async function purgeShiftNoteTextFromHistory(instanceId, noteText) {
    if (!normalizeShiftNoteText(noteText))
        return 0;
    let removedTotal = 0;
    const keys = await scanKeys(`history:${instanceId}:*`);
    for (const key of keys) {
        const ttlBefore = await redisClient.ttl(key).catch(() => -1);
        const rawHistory = await redisClient.lRange(key, 0, -1).catch(() => []);
        const kept = [];
        let removedFromKey = 0;
        for (const raw of rawHistory) {
            try {
                const parsed = JSON.parse(raw);
                if (isDerivedShiftNoteHistory(parsed?.text, noteText)) {
                    removedFromKey += 1;
                    continue;
                }
            }
            catch {
                // Keep malformed entries rather than risking customer history loss.
            }
            kept.push(raw);
        }
        if (!removedFromKey)
            continue;
        const multi = redisClient.multi().del(key);
        for (const item of kept) {
            multi.rPush(key, item);
        }
        await multi.exec();
        if (kept.length && ttlBefore > 0)
            await redisClient.expire(key, ttlBefore);
        removedTotal += removedFromKey;
    }
    return removedTotal;
}
async function scanKeys(pattern) {
    await connectRedis();
    const keys = [];
    for await (const chunk of redisClient.scanIterator({ MATCH: pattern, COUNT: 100 })) {
        if (Array.isArray(chunk))
            keys.push(...chunk.map(String));
        else
            keys.push(String(chunk));
    }
    return keys;
}
export async function saveShiftNote(instanceId, noteId, text, expiresAtString) {
    const noteText = String(text || "").trim();
    if (!noteText)
        return false;
    return safeRedis(false, async () => {
        const safeNoteId = String(noteId || "").trim() ||
            `fallback_${crypto.createHash("sha1").update(`${instanceId}|${noteText}|${expiresAtString || ""}`).digest("hex").slice(0, 16)}`;
        let ttlSeconds = 24 * 60 * 60;
        const expiresAt = expiresAtString ? Date.parse(expiresAtString) : 0;
        if (Number.isFinite(expiresAt) && expiresAt > Date.now()) {
            ttlSeconds = Math.max(60, Math.ceil((expiresAt - Date.now()) / 1000));
        }
        await redisClient.setEx(`shift_note:${instanceId}:${safeNoteId}`, ttlSeconds, JSON.stringify({ text: noteText, createdAt: Date.now(), expiresAt: Date.now() + ttlSeconds * 1000 }));
        return true;
    });
}
export async function deleteShiftNote(instanceId, noteId, text = "") {
    await safeRedis(undefined, async () => {
        const safeNoteId = String(noteId || "").trim();
        const expectedText = String(text || "").trim();
        const deletedKeys = [];
        const purgeTexts = new Set();
        if (expectedText)
            purgeTexts.add(expectedText);
        if (safeNoteId && safeNoteId !== "0") {
            const key = `shift_note:${instanceId}:${safeNoteId}`;
            const stored = parseShiftNoteRecord((await redisClient.get(key).catch(() => "")) || "");
            if (stored.text)
                purgeTexts.add(stored.text);
            if (await redisClient.del(key))
                deletedKeys.push(key);
        }
        if (!deletedKeys.length) {
            const keys = await scanKeys(`shift_note:${instanceId}:*`);
            if (expectedText) {
                for (const key of keys) {
                    const stored = parseShiftNoteRecord((await redisClient.get(key).catch(() => "")) || "");
                    if (!shiftNoteTextMatches(stored.text, expectedText))
                        continue;
                    if (stored.text)
                        purgeTexts.add(stored.text);
                    await redisClient.del(key);
                    deletedKeys.push(key);
                }
            }
            else if (!safeNoteId || safeNoteId === "0") {
                for (const key of keys) {
                    const stored = parseShiftNoteRecord((await redisClient.get(key).catch(() => "")) || "");
                    if (stored.text)
                        purgeTexts.add(stored.text);
                    await redisClient.del(key);
                    deletedKeys.push(key);
                }
            }
        }
        for (const purgeText of purgeTexts) {
            await purgeShiftNoteTextFromHistory(instanceId, purgeText);
        }
    });
}
export async function getActiveShiftNotes(instanceId) {
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
export async function getJsonCache(key) {
    return safeRedis(null, async () => {
        const raw = await redisClient.get(key);
        return raw ? JSON.parse(raw) : null;
    });
}
export async function setJsonCache(key, ttlSeconds, value) {
    await safeRedis(undefined, async () => {
        await redisClient.setEx(key, ttlSeconds, JSON.stringify(value));
    });
}
export async function deleteCache(key) {
    await safeRedis(undefined, async () => {
        await redisClient.del(key);
    });
}
