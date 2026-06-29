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
const MAX_MEDIA_BYTES = Number(process.env.OPENBOT_MAX_MEDIA_BYTES || 15 * 1024 * 1024);
const ALLOWED_MEDIA_MIME = /^(image\/(jpeg|png|webp)|application\/pdf|video\/mp4)$/i;

export interface InboundMediaContext {
  hasMedia: boolean;
  kind: "image" | "document" | "video" | "audio" | "unknown";
  mimeType: string;
  sizeBytes: number;
  valid: boolean;
  reason?: string;
  caption?: string;
  messageId?: string;
}

export interface GuardResult {
  blocked: boolean;
  reason?: string;
}

function sha1(value = "") {
  return crypto.createHash("sha1").update(value).digest("hex");
}

function nestedMessage(body: any) {
  return body?.data?.message || body?.messageData?.message || body?.message || {};
}

function firstString(...values: any[]) {
  for (const value of values) {
    if (typeof value === "string" && value.trim()) return value.trim();
  }
  return "";
}

function firstNumber(...values: any[]) {
  for (const value of values) {
    const num = Number(value);
    if (Number.isFinite(num) && num > 0) return num;
  }
  return 0;
}

export function extractMessageId(body: any): string {
  const raw =
    body?.messageId ||
    body?.id ||
    body?.data?.key?.id ||
    body?.key?.id ||
    body?.message?.key?.id ||
    "";
  return String(raw || "").trim().slice(0, 160);
}

export function extractInboundText(body: any): string {
  const msg = nestedMessage(body);
  return firstString(
    body?.text,
    body?.body,
    typeof body?.message === "string" ? body.message : "",
    body?.caption,
    msg?.conversation,
    msg?.extendedTextMessage?.text,
    msg?.imageMessage?.caption,
    msg?.videoMessage?.caption,
    msg?.documentMessage?.caption
  );
}

export function extractInboundMedia(body: any): InboundMediaContext | null {
  const msg = nestedMessage(body);
  const image = msg?.imageMessage || body?.imageMessage || body?.media?.imageMessage;
  const document = msg?.documentMessage || body?.documentMessage || body?.media?.documentMessage;
  const video = msg?.videoMessage || body?.videoMessage || body?.media?.videoMessage;
  const audio = msg?.audioMessage || body?.audioMessage || body?.media?.audioMessage;
  const rawMedia = image || document || video || audio || body?.media || null;
  const hasMedia = Boolean(body?.hasMedia || body?.media || image || document || video || audio);
  if (!hasMedia) return null;

  const kind: InboundMediaContext["kind"] = image
    ? "image"
    : document
      ? "document"
      : video
        ? "video"
        : audio
          ? "audio"
          : "unknown";
  const mimeType = firstString(body?.mimeType, body?.mediaType, rawMedia?.mimetype, rawMedia?.mimeType);
  const sizeBytes = firstNumber(body?.fileLength, body?.sizeBytes, body?.mediaSize, rawMedia?.fileLength, rawMedia?.sizeBytes);
  const caption = firstString(body?.caption, rawMedia?.caption);
  const reason =
    kind === "audio"
      ? "audio_not_supported"
      : !mimeType
        ? "missing_mime_type"
        : !ALLOWED_MEDIA_MIME.test(mimeType)
          ? "unsupported_mime_type"
          : sizeBytes > MAX_MEDIA_BYTES
            ? "media_too_large"
            : "";

  return {
    hasMedia: true,
    kind,
    mimeType,
    sizeBytes,
    valid: !reason,
    reason: reason || undefined,
    caption,
    messageId: extractMessageId(body) || undefined,
  };
}

export async function guardIncomingMessage(input: {
  instanceId: string;
  phone: string;
  text: string;
  messageId?: string;
  fromMe?: boolean;
}): Promise<GuardResult> {
  const instanceId = String(input.instanceId || "").trim();
  const phone = String(input.phone || "").replace(/\D/g, "");
  const text = String(input.text || "").trim();
  const messageId = String(input.messageId || "").trim();

  if (input.fromMe) return { blocked: true, reason: "fromMe" };
  if (!INSTANCE_RE.test(instanceId)) return { blocked: true, reason: "bad_instance" };
  if (!PHONE_RE.test(phone)) return { blocked: true, reason: "bad_phone" };

  await connectRedis();

  if (messageId) {
    if (await redisClient.get(`msg_done:${instanceId}:${messageId}`)) {
      return { blocked: true, reason: "duplicate_done" };
    }
    const lock = await redisClient.set(`msg_processing:${instanceId}:${messageId}`, "1", {
      NX: true,
      EX: PROCESSING_LOCK_SECONDS,
    });
    if (!lock) return { blocked: true, reason: "duplicate_processing" };
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
  if (count === 1) await redisClient.expire(spamKey, SPAM_WINDOW_SECONDS);
  if (count > SPAM_LIMIT) {
    await redisClient.setEx(`mute:${instanceId}:${phone}`, MUTE_SECONDS, "spam_blocked");
    await markInboundDone(instanceId, messageId);
    return { blocked: true, reason: "spam_limit_exceeded" };
  }

  return { blocked: false };
}

export async function markInboundDone(instanceId: string, messageId?: string): Promise<void> {
  const safeMessageId = String(messageId || "").trim();
  if (!safeMessageId) return;
  await connectRedis();
  await redisClient
    .multi()
    .setEx(`msg_done:${instanceId}:${safeMessageId}`, DONE_SECONDS, "1")
    .del(`msg_processing:${instanceId}:${safeMessageId}`)
    .exec();
}

export async function clearInboundProcessing(instanceId: string, messageId?: string): Promise<void> {
  const safeMessageId = String(messageId || "").trim();
  if (!safeMessageId) return;
  await connectRedis();
  await redisClient.del(`msg_processing:${instanceId}:${safeMessageId}`);
}

export async function saveMediaContext(
  instanceId: string,
  phone: string,
  mediaContext: InboundMediaContext
): Promise<void> {
  if (!mediaContext.valid) return;
  await connectRedis();
  await redisClient.setEx(
    `media_context:${instanceId}:${phone}`,
    MEDIA_CONTEXT_SECONDS,
    JSON.stringify({ ...mediaContext, savedAt: Date.now() })
  );
}

export async function clearMediaContext(instanceId: string, phone: string): Promise<void> {
  await connectRedis();
  await redisClient.del(`media_context:${instanceId}:${phone}`);
}
