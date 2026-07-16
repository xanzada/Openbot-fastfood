import crypto from "node:crypto";
import { connectRedis, redisClient } from "./redis.service.js";
const INSTANCE_RE = /^[a-zA-Z0-9_-]{2,64}$/;
const PHONE_RE = /^\d{10,15}$/;
const SPAM_WINDOW_SECONDS = 60;
const SPAM_LIMIT = Number(process.env.OPENBOT_SPAM_LIMIT_PER_MINUTE || 15);
const MUTE_SECONDS = Number(process.env.OPENBOT_SPAM_MUTE_SECONDS || 900);
const DUPLICATE_TEXT_SECONDS = 5;
const PROCESSING_LOCK_SECONDS = 180;
const DONE_SECONDS = 86400;
const MEDIA_CONTEXT_SECONDS = 60;
const OPERATOR_MUTE_MAX_SECONDS = Number(process.env.OPERATOR_MUTE_MAX_SECONDS || 300);
const OPERATOR_ACTIVE_SECONDS = Number(process.env.OPERATOR_ACTIVE_SECONDS || 60);
const MAX_MEDIA_BYTES = Number(process.env.OPENBOT_MAX_MEDIA_BYTES || 5 * 1024 * 1024);
const ALLOWED_MEDIA_MIME = /^(image\/(jpeg|jpg|png|webp)|application\/pdf|video\/mp4|audio\/(ogg|opus|mpeg|mp3|wav|x-wav|webm|mp4|m4a|aac|flac))(?:;.*)?$/i;
const PRIVATE_CONTACT_KEYWORDS = (process.env.PRIVATE_CONTACT_KEYWORDS || [
    "мама",
    "мам",
    "папа",
    "пап",
    "ана",
    "әке",
    "аке",
    "апа",
    "ата",
    "әже",
    "аже",
    "нағашы",
    "нагашы",
    "аға",
    "ага",
    "әпке",
    "апке",
    "тәте",
    "тате",
    "көке",
    "коке",
    "брат",
    "сестра",
    "жена",
    "муж",
    "дос",
    "бауырым",
    "карындас",
    "қарындас",
    "сіңлі",
    "синли",
].join(","))
    .split(",")
    .map((item) => item.trim().toLowerCase())
    .filter(Boolean);
function sha1(value = "") {
    return crypto.createHash("sha1").update(value).digest("hex");
}
function nestedMessage(body) {
    return body?.data?.message || body?.messageData?.message || body?.message || {};
}
function actualMessage(body) {
    const msg = nestedMessage(body);
    return msg?.ephemeralMessage?.message || msg || {};
}
function firstString(...values) {
    for (const value of values) {
        if (typeof value === "string" && value.trim())
            return value.trim();
    }
    return "";
}
function firstNumber(...values) {
    for (const value of values) {
        const num = Number(value);
        if (Number.isFinite(num) && num > 0)
            return num;
        if (value && typeof value.toNumber === "function") {
            const converted = Number(value.toNumber());
            if (Number.isFinite(converted) && converted > 0)
                return converted;
        }
    }
    return 0;
}
function getDeclaredMediaBytes(mediaMessage) {
    return firstNumber(mediaMessage?.fileLength, mediaMessage?.fileSize, mediaMessage?.size);
}
function normalizeMimeBase(mimeType = "") {
    return String(mimeType || "").split(";")[0].trim().toLowerCase();
}
function normalizeContactText(value) {
    return String(value || "").toLowerCase().replace(/\s+/g, " ").trim();
}
function tokenizeContactText(value) {
    return normalizeContactText(value).split(/[^\p{L}\p{N}]+/u).filter(Boolean);
}
function hasPrivateKeyword(values) {
    const contactTokens = values.flatMap(tokenizeContactText);
    if (!contactTokens.length)
        return false;
    const tokenText = ` ${contactTokens.join(" ")} `;
    return PRIVATE_CONTACT_KEYWORDS.some((keyword) => {
        const keywordTokens = tokenizeContactText(keyword);
        if (!keywordTokens.length)
            return false;
        return tokenText.includes(` ${keywordTokens.join(" ")} `);
    });
}
function envBool(name, fallback = false) {
    const value = String(process.env[name] ?? "").trim().toLowerCase();
    if (!value)
        return fallback;
    return ["1", "true", "yes", "on"].includes(value);
}
function getTestModeAllowedPhone() {
    return String(process.env.TEST_MODE_ALLOWED_PHONE || "").replace(/\D/g, "");
}
function defaultMimeForKind(kind, rawMedia) {
    if (kind === "image")
        return firstString(rawMedia?.mimetype, rawMedia?.mimeType) || "image/jpeg";
    if (kind === "audio")
        return firstString(rawMedia?.mimetype, rawMedia?.mimeType) || "audio/ogg";
    if (kind === "video")
        return firstString(rawMedia?.mimetype, rawMedia?.mimeType) || "video/mp4";
    if (kind === "document")
        return firstString(rawMedia?.mimetype, rawMedia?.mimeType);
    return firstString(rawMedia?.mimetype, rawMedia?.mimeType);
}
export function extractMessageId(body) {
    const raw = body?.messageId ||
        body?.id ||
        body?.data?.key?.id ||
        body?.key?.id ||
        body?.message?.key?.id ||
        "";
    return String(raw || "").trim().slice(0, 160);
}
export function extractInboundText(body) {
    const msg = actualMessage(body);
    return firstString(body?.text, body?.body, typeof body?.message === "string" ? body.message : "", body?.caption, msg?.conversation, msg?.extendedTextMessage?.text, msg?.imageMessage?.caption, msg?.videoMessage?.caption, msg?.documentMessage?.caption);
}
export function extractSenderMeta(body) {
    const eventData = body?.data || body || {};
    return {
        pushName: eventData.pushName || body?.pushName || "",
        contactName: eventData.contactName || body?.contactName || eventData.contact?.name || body?.contact?.name || "",
        contactShortName: eventData.contact?.shortName || body?.contact?.shortName || "",
        contactPushName: eventData.contact?.pushName || eventData.contact?.pushname || body?.contact?.pushName || body?.contact?.pushname || "",
        isMyContact: Boolean(eventData.isMyContact || body?.isMyContact || eventData.contact?.isMyContact || body?.contact?.isMyContact),
    };
}
export function extractInboundMedia(body) {
    const msg = actualMessage(body);
    const image = msg?.imageMessage || body?.imageMessage || body?.media?.imageMessage;
    const document = msg?.documentMessage || body?.documentMessage || body?.media?.documentMessage;
    const video = msg?.videoMessage || body?.videoMessage || body?.media?.videoMessage;
    const audio = msg?.audioMessage || body?.audioMessage || body?.media?.audioMessage || (body?.type === "audio" ? body?.media || body : null);
    const ptv = msg?.ptvMessage || body?.ptvMessage || body?.media?.ptvMessage;
    const rawMedia = image || document || video || audio || ptv || body?.media || null;
    const hasMedia = Boolean(body?.hasMedia || body?.media || image || document || video || audio || ptv);
    if (!hasMedia)
        return null;
    const kind = image
        ? "image"
        : document
            ? "document"
            : video || ptv
                ? "video"
                : audio
                    ? "audio"
                    : "unknown";
    const mimeType = firstString(body?.mimeType, body?.mediaType, defaultMimeForKind(kind, rawMedia));
    const mimeBase = normalizeMimeBase(mimeType);
    const sizeBytes = firstNumber(body?.fileLength, body?.sizeBytes, body?.mediaSize) || getDeclaredMediaBytes(rawMedia);
    const caption = firstString(body?.caption, rawMedia?.caption);
    const flags = [];
    if (!mimeBase)
        flags.push("missing_mime_type");
    if (kind === "document" && mimeBase !== "application/pdf")
        flags.push("unsupported_document");
    if (mimeBase && !ALLOWED_MEDIA_MIME.test(mimeType))
        flags.push("unsupported_mime_type");
    if (sizeBytes > MAX_MEDIA_BYTES)
        flags.push("media_too_large");
    if (kind === "audio" &&
        ![
            "audio/ogg",
            "audio/opus",
            "audio/mpeg",
            "audio/mp3",
            "audio/wav",
            "audio/x-wav",
            "audio/webm",
            "audio/mp4",
            "audio/m4a",
            "audio/aac",
            "audio/flac",
        ].includes(mimeBase)) {
        flags.push("unsupported_audio_mime");
    }
    if (kind === "unknown")
        flags.push("unknown_media_type");
    const historyLabel = kind === "audio"
        ? "[Audio sent]"
        : kind === "image"
            ? "[Photo sent]"
            : kind === "document"
                ? "[Document sent]"
                : kind === "video"
                    ? "[Video sent]"
                    : "[Media sent]";
    return {
        hasMedia: true,
        kind,
        mimeType,
        sizeBytes,
        valid: flags.length === 0,
        reason: flags[0] || undefined,
        flags,
        caption,
        messageId: extractMessageId(body) || undefined,
        mediaType: mimeType,
        historyLabel,
    };
}
function cleanDataUrlBase64(value = "", fallbackMimeType = "application/octet-stream") {
    const raw = String(value || "").trim();
    if (!raw)
        return null;
    if (raw.includes(";base64,")) {
        const [prefix, data] = raw.split(";base64,");
        const mimeType = prefix.replace(/^data:/i, "") || fallbackMimeType;
        return { dataUrl: raw, base64: data || "", mimeType };
    }
    if (/^[A-Za-z0-9+/=\s]+$/.test(raw) && raw.length > 80) {
        const cleanBase64 = raw.replace(/\s+/g, "");
        return {
            dataUrl: `data:${fallbackMimeType};base64,${cleanBase64}`,
            base64: cleanBase64,
            mimeType: fallbackMimeType,
        };
    }
    return null;
}
function mediaDownloadUrl(body) {
    return firstString(body?.mediaUrl, body?.downloadUrl, body?.url, body?.media?.url, body?.media?.downloadUrl, body?.media?.mediaUrl, body?.data?.mediaUrl, body?.data?.downloadUrl, body?.data?.media?.url, body?.message?.mediaUrl, body?.message?.downloadUrl);
}
function directMediaBase64(body) {
    return firstString(body?.base64, body?.dataUrl, body?.media?.base64, body?.media?.data, body?.media?.dataUrl, body?.data?.base64, body?.data?.media?.base64, body?.message?.base64);
}
function whatsproHeaders() {
    const headers = {};
    if (process.env.WHATSPRO_API_TOKEN) {
        headers.authorization = `Bearer ${process.env.WHATSPRO_API_TOKEN}`;
        headers["x-api-key"] = process.env.WHATSPRO_API_TOKEN;
    }
    return headers;
}
export async function getBase64Media(body, mediaContext = extractInboundMedia(body)) {
    const mimeType = mediaContext?.mimeType || firstString(body?.mimeType, body?.mediaType) || "application/octet-stream";
    const direct = cleanDataUrlBase64(directMediaBase64(body), mimeType);
    if (direct?.base64)
        return direct;
    const url = mediaDownloadUrl(body);
    if (!url)
        return null;
    try {
        const response = await fetch(url, { headers: whatsproHeaders() });
        if (!response.ok)
            throw new Error(`MEDIA_HTTP_${response.status}`);
        const arrayBuffer = await response.arrayBuffer();
        if (arrayBuffer.byteLength > MAX_MEDIA_BYTES)
            throw new Error("MEDIA_TOO_LARGE");
        const responseMimeType = response.headers.get("content-type")?.split(";")[0] || mimeType;
        const base64 = Buffer.from(arrayBuffer).toString("base64");
        return {
            dataUrl: `data:${responseMimeType};base64,${base64}`,
            base64,
            mimeType: responseMimeType,
        };
    }
    catch (error) {
        console.error("[DOWNLOAD MEDIA ERROR]:", error?.message || error);
        return null;
    }
}
export async function hydrateInboundMedia(body, mediaContext) {
    if (!mediaContext)
        return null;
    const downloaded = await getBase64Media(body, mediaContext);
    if (!downloaded?.base64)
        return mediaContext;
    return {
        ...mediaContext,
        mimeType: downloaded.mimeType || mediaContext.mimeType,
        mediaType: downloaded.mimeType || mediaContext.mediaType,
        sizeBytes: Math.floor(downloaded.base64.length * 0.75),
        base64: downloaded.dataUrl,
        dataUrl: downloaded.dataUrl,
    };
}
async function getFreshOperatorMute(instanceId, phone) {
    if (!redisClient.isOpen)
        return "";
    const key = `mute:${instanceId}:${phone}`;
    const value = String((await redisClient.get(key).catch(() => "")) || "");
    if (!/^(muted|muted_by_agent)$/.test(value))
        return "";
    const ttl = await redisClient.ttl(key).catch(() => -2);
    if (ttl < 0 || ttl > OPERATOR_MUTE_MAX_SECONDS) {
        await redisClient.del(key).catch(() => undefined);
        console.warn(`[OPERATOR MUTE] stale mute cleared: ${key}, ttl=${ttl}`);
        return "";
    }
    return value;
}
async function getFreshOperatorActive(instanceId, phone) {
    if (!redisClient.isOpen)
        return "";
    const key = `operator_active:${instanceId}:${phone}`;
    const value = String((await redisClient.get(key).catch(() => "")) || "");
    if (!value)
        return "";
    const ttl = await redisClient.ttl(key).catch(() => -2);
    if (ttl < 0 || ttl > Math.max(OPERATOR_ACTIVE_SECONDS, OPERATOR_MUTE_MAX_SECONDS)) {
        await redisClient.del(key).catch(() => undefined);
        console.warn(`[OPERATOR ACTIVE] stale lock cleared: ${key}, ttl=${ttl}`);
        return "";
    }
    return value;
}
export async function setOperatorAutoMute(instanceId, phone) {
    const safeInstanceId = String(instanceId || "").trim();
    const safePhone = String(phone || "").replace(/\D/g, "");
    if (!safeInstanceId || !safePhone)
        return;
    await connectRedis();
    await redisClient
        .multi()
        .setEx(`mute:${safeInstanceId}:${safePhone}`, OPERATOR_MUTE_MAX_SECONDS, "muted_by_agent")
        .setEx(`operator_active:${safeInstanceId}:${safePhone}`, OPERATOR_ACTIVE_SECONDS, "openbot_from_me")
        .exec();
}
export async function guardIncomingMessage(input) {
    const instanceId = String(input.instanceId || "").trim();
    const phone = String(input.phone || "").replace(/\D/g, "");
    const text = String(input.text || "").trim();
    const messageId = String(input.messageId || "").trim();
    if (input.fromMe)
        return { blocked: true, reason: "fromMe" };
    if (input.isGroup)
        return { blocked: true, reason: "group_message" };
    if (!INSTANCE_RE.test(instanceId))
        return { blocked: true, reason: "bad_instance" };
    if (!PHONE_RE.test(phone))
        return { blocked: true, reason: "bad_phone" };
    if (envBool("TEST_MODE_ENABLED", false)) {
        const allowedPhone = getTestModeAllowedPhone();
        if (!allowedPhone || phone !== allowedPhone) {
            return { blocked: true, reason: "test_mode_blocked" };
        }
    }
    const privateNames = [
        input.senderMeta?.contactName,
        input.senderMeta?.contactShortName,
        input.senderMeta?.contactPushName,
        input.senderMeta?.pushName,
        text,
    ].filter(Boolean);
    const ignoreSavedContacts = String(process.env.BOT_IGNORE_SAVED_CONTACTS || "false").trim().toLowerCase() === "true";
    if (hasPrivateKeyword(privateNames))
        return { blocked: true, reason: "private_contact_keyword" };
    if (ignoreSavedContacts && Boolean(input.senderMeta?.isMyContact))
        return { blocked: true, reason: "private_saved_contact" };
    await connectRedis();
    const operatorActive = await getFreshOperatorActive(instanceId, phone);
    if (operatorActive) {
        await markInboundDone(instanceId, messageId);
        return { blocked: true, reason: "operator_active", source: "operator_override" };
    }
    if (messageId) {
        if (await redisClient.get(`msg_done:${instanceId}:${messageId}`)) {
            return { blocked: true, reason: "duplicate_done" };
        }
        const lock = await redisClient.set(`msg_processing:${instanceId}:${messageId}`, "1", {
            NX: true,
            EX: PROCESSING_LOCK_SECONDS,
        });
        if (!lock)
            return { blocked: true, reason: "duplicate_processing" };
    }
    const operatorMute = await getFreshOperatorMute(instanceId, phone);
    if (operatorMute) {
        await markInboundDone(instanceId, messageId);
        return { blocked: true, reason: "muted", source: "operator_override" };
    }
    if (await redisClient.get(`mute:${instanceId}:${phone}`)) {
        await markInboundDone(instanceId, messageId);
        return { blocked: true, reason: "muted" };
    }
    if (text) {
        const duplicateKey = `anti_dup:${instanceId}:${phone}`;
        const textHash = sha1(text.toLowerCase());
        const previousHash = await redisClient.get(duplicateKey);
        if (previousHash === textHash) {
            await markInboundDone(instanceId, messageId);
            return { blocked: true, reason: "duplicate_text" };
        }
        await redisClient.setEx(duplicateKey, DUPLICATE_TEXT_SECONDS, textHash);
    }
    const spamKey = `spam:${instanceId}:${phone}`;
    const count = await redisClient.incr(spamKey);
    if (count === 1)
        await redisClient.expire(spamKey, SPAM_WINDOW_SECONDS);
    if (count > SPAM_LIMIT) {
        await redisClient.setEx(`mute:${instanceId}:${phone}`, MUTE_SECONDS, "spam_blocked");
        await markInboundDone(instanceId, messageId);
        return { blocked: true, reason: "spam_limit_exceeded" };
    }
    return { blocked: false };
}
export async function markInboundDone(instanceId, messageId) {
    const safeMessageId = String(messageId || "").trim();
    if (!safeMessageId)
        return;
    await connectRedis();
    await redisClient
        .multi()
        .setEx(`msg_done:${instanceId}:${safeMessageId}`, DONE_SECONDS, "1")
        .del(`msg_processing:${instanceId}:${safeMessageId}`)
        .exec();
}
export async function clearInboundProcessing(instanceId, messageId) {
    const safeMessageId = String(messageId || "").trim();
    if (!safeMessageId)
        return;
    await connectRedis();
    await redisClient.del(`msg_processing:${instanceId}:${safeMessageId}`);
}
export async function saveMediaContext(instanceId, phone, mediaContext) {
    await connectRedis();
    await redisClient.setEx(`media_context:${instanceId}:${phone}`, MEDIA_CONTEXT_SECONDS, JSON.stringify({ ...mediaContext, savedAt: Date.now() }));
}
export async function clearMediaContext(instanceId, phone) {
    await connectRedis();
    await redisClient.del(`media_context:${instanceId}:${phone}`);
}
