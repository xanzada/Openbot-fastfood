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
const USER_LANG_TTL_SECONDS = 43200;
const COMPLAINT_MEDIA_TTL_SECONDS = 300;
const DAILY_LOG_TTL_SECONDS = 172800;
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
export async function getUserLang(instanceId, phone) {
    return safeRedis(null, async () => {
        const value = await redisClient.get(`lang:${instanceId}:${phone}`);
        return value === "kk" || value === "ru" ? value : null;
    });
}
export async function saveUserLang(instanceId, phone, lang) {
    await safeRedis(undefined, async () => {
        await redisClient.setEx(`lang:${instanceId}:${phone}`, USER_LANG_TTL_SECONDS, lang);
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
export async function deleteShiftNote(instanceId, noteId, _text = "") {
    await safeRedis(undefined, async () => {
        const safeNoteId = String(noteId || "").trim();
        if (safeNoteId && safeNoteId !== "0") {
            await redisClient.del(`shift_note:${instanceId}:${safeNoteId}`);
        }
        else {
            const keys = await scanKeys(`shift_note:${instanceId}:*`);
            for (const key of keys) {
                await redisClient.del(key);
            }
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
