import crypto from "node:crypto";
import { connectRedis, redisClient } from "./redis.service.js";
import { getRestaurantConfig } from "./platformConfig.service.js";

const INSTANCE_RE = /^[a-zA-Z0-9_-]{2,64}$/;
const PHONE_RE = /^\d{10,15}$/;
const SPAM_WINDOW_SECONDS = 60;
const SPAM_LIMIT = Number(process.env.OPENBOT_SPAM_LIMIT_PER_MINUTE || 15);
const MUTE_SECONDS = Number(process.env.OPENBOT_SPAM_MUTE_SECONDS || 900);
const DUPLICATE_TEXT_SECONDS = 5;
const INBOUND_BUFFER_SECONDS = 5;
const INBOUND_BUFFER_DELAY_MS = Math.max(600, Number(process.env.OPENBOT_INBOUND_BUFFER_MS || 2400));
const INBOUND_BUFFER_MAX_ITEMS = 8;
const INBOUND_BUFFER_MAX_CHARS = 2000;
const PROCESSING_LOCK_SECONDS = 180;
const DONE_SECONDS = 86400;
const MEDIA_CONTEXT_SECONDS = 60;
const OPERATOR_MUTE_MAX_SECONDS = Number(process.env.OPERATOR_MUTE_MAX_SECONDS || 300);
const OPERATOR_ACTIVE_SECONDS = Number(process.env.OPERATOR_ACTIVE_SECONDS || 60);
export const MAX_IMAGE_BYTES = Number(process.env.OPENBOT_MAX_IMAGE_BYTES || process.env.OPENBOT_MAX_MEDIA_BYTES || 5 * 1024 * 1024);
export const MAX_DOCUMENT_BYTES = Number(process.env.OPENBOT_MAX_DOCUMENT_BYTES || process.env.OPENBOT_MAX_MEDIA_BYTES || 5 * 1024 * 1024);
export const MAX_AUDIO_BYTES = Number(process.env.OPENBOT_MAX_AUDIO_BYTES || 8 * 1024 * 1024);
export const MAX_VOICE_SECONDS = Number(process.env.OPENBOT_MAX_VOICE_SECONDS || 180);
const MEDIA_AI_LIMIT_PER_5_MINUTES = Number(process.env.OPENBOT_MEDIA_AI_LIMIT_PER_5_MINUTES || 6);
const ALLOWED_MEDIA_MIME = /^(image\/(jpeg|jpg|png|webp)|application\/pdf|video\/mp4|audio\/(ogg|opus|mpeg|mp3|wav|x-wav|webm|mp4|m4a|aac|flac))(?:;.*)?$/i;
const PRIVATE_CONTACT_KEYWORDS = (process.env.PRIVATE_CONTACT_KEYWORDS || "")
  .split(",")
  .map((item) => item.trim().toLowerCase())
  .filter(Boolean);

const localDone = new Map<string, number>();
const localProcessing = new Map<string, number>();
const localDuplicateText = new Map<string, { hash: string; expiresAt: number }>();
const localSpam = new Map<string, { count: number; windowEndsAt: number; mutedUntil: number }>();
const localMediaQuota = new Map<string, { count: number; windowEndsAt: number }>();
const localInboundBuffers = new Map<string, {
  items: Array<{ token: string; text: string }>;
  latestToken: string;
  expiresAt: number;
}>();

function localKey(instanceId: string, value: string) {
  return `${instanceId}:${value}`;
}

function pruneLocalGuardState(now = Date.now()) {
  for (const [key, expiresAt] of localDone) if (expiresAt <= now) localDone.delete(key);
  for (const [key, expiresAt] of localProcessing) if (expiresAt <= now) localProcessing.delete(key);
  for (const [key, item] of localDuplicateText) if (item.expiresAt <= now) localDuplicateText.delete(key);
  for (const [key, item] of localSpam) {
    if (item.windowEndsAt <= now && item.mutedUntil <= now) localSpam.delete(key);
  }
  for (const [key, item] of localMediaQuota) if (item.windowEndsAt <= now) localMediaQuota.delete(key);
  for (const [key, item] of localInboundBuffers) if (item.expiresAt <= now) localInboundBuffers.delete(key);
}

function guardIncomingMessageInMemory(instanceId: string, phone: string, text: string, messageId: string): GuardResult {
  const now = Date.now();
  pruneLocalGuardState(now);
  const messageKey = messageId ? localKey(instanceId, messageId) : "";
  if (messageKey && localDone.has(messageKey)) return { blocked: true, reason: "duplicate_done_local" };
  if (messageKey && localProcessing.has(messageKey)) return { blocked: true, reason: "duplicate_processing_local" };
  if (messageKey) localProcessing.set(messageKey, now + PROCESSING_LOCK_SECONDS * 1000);

  const customerKey = localKey(instanceId, phone);
  const spam = localSpam.get(customerKey);
  if (spam?.mutedUntil && spam.mutedUntil > now) return { blocked: true, reason: "spam_muted_local" };

  if (text) {
    const textHash = sha1(text.toLowerCase());
    const previous = localDuplicateText.get(customerKey);
    if (previous?.hash === textHash && previous.expiresAt > now) {
      if (messageKey) {
        localProcessing.delete(messageKey);
        localDone.set(messageKey, now + DONE_SECONDS * 1000);
      }
      return { blocked: true, reason: "duplicate_text_local" };
    }
    localDuplicateText.set(customerKey, {
      hash: textHash,
      expiresAt: now + DUPLICATE_TEXT_SECONDS * 1000,
    });
  }

  const activeSpam = spam?.windowEndsAt && spam.windowEndsAt > now
    ? spam
    : { count: 0, windowEndsAt: now + SPAM_WINDOW_SECONDS * 1000, mutedUntil: 0 };
  activeSpam.count += 1;
  if (activeSpam.count > SPAM_LIMIT) activeSpam.mutedUntil = now + MUTE_SECONDS * 1000;
  localSpam.set(customerKey, activeSpam);
  if (activeSpam.mutedUntil > now) {
    if (messageKey) {
      localProcessing.delete(messageKey);
      localDone.set(messageKey, now + DONE_SECONDS * 1000);
    }
    return { blocked: true, reason: "spam_limit_exceeded_local" };
  }
  return { blocked: false, source: "redis_fail_open" };
}

export interface InboundMediaContext {
  hasMedia: boolean;
  kind: "image" | "document" | "video" | "audio" | "sticker" | "unknown";
  mimeType: string;
  sizeBytes: number;
  valid: boolean;
  reason?: string;
  flags: string[];
  caption?: string;
  messageId?: string;
  base64?: string;
  dataUrl?: string;
  mediaType?: string;
  analysis?: Record<string, any>;
  historyLabel: string;
  durationSeconds?: number;
  isVoiceNote?: boolean;
}

export interface GuardResult {
  blocked: boolean;
  reason?: string;
  source?: string;
}

function sha1(value = "") {
  return crypto.createHash("sha1").update(value).digest("hex");
}

function nestedMessage(body: any) {
  return body?.data?.message || body?.messageData?.message || body?.message || {};
}

function actualMessage(body: any) {
  const msg = nestedMessage(body);
  return msg?.ephemeralMessage?.message || msg || {};
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
    if (value && typeof value.toNumber === "function") {
      const converted = Number(value.toNumber());
      if (Number.isFinite(converted) && converted > 0) return converted;
    }
  }
  return 0;
}

function getDeclaredMediaBytes(mediaMessage: any) {
  return firstNumber(mediaMessage?.fileLength, mediaMessage?.fileSize, mediaMessage?.size);
}

function normalizeMimeBase(mimeType = "") {
  return String(mimeType || "").split(";")[0].trim().toLowerCase();
}

function maxBytesForKind(kind: InboundMediaContext["kind"]) {
  if (kind === "audio") return MAX_AUDIO_BYTES;
  if (kind === "document") return MAX_DOCUMENT_BYTES;
  return MAX_IMAGE_BYTES;
}

function mediaSignatureMatches(mimeType: string, base64: string) {
  try {
    const data = String(base64 || "").replace(/^data:[^;]+;base64,/i, "");
    const b = Buffer.from(data.slice(0, 64), "base64");
    const hex = b.toString("hex");
    const ascii = b.toString("ascii");
    const mime = normalizeMimeBase(mimeType);
    if (["image/jpeg","image/jpg"].includes(mime)) return hex.startsWith("ffd8ff");
    if (mime === "image/png") return hex.startsWith("89504e470d0a1a0a");
    if (mime === "image/webp") return ascii.startsWith("RIFF") && ascii.slice(8,12) === "WEBP";
    if (mime === "application/pdf") return ascii.startsWith("%PDF-");
    if (["audio/ogg","audio/opus"].includes(mime)) return ascii.startsWith("OggS");
    if (["audio/wav","audio/x-wav"].includes(mime)) return ascii.startsWith("RIFF") && ascii.slice(8,12) === "WAVE";
    if (["audio/mpeg","audio/mp3"].includes(mime)) return ascii.startsWith("ID3") || (b[0]===0xff && (b[1]&0xe0)===0xe0);
    if (["audio/webm"].includes(mime)) return hex.startsWith("1a45dfa3");
    if (["audio/mp4","audio/m4a"].includes(mime)) return ascii.slice(4,8) === "ftyp";
    if (mime === "audio/flac") return ascii.startsWith("fLaC");
    if (mime === "audio/aac") return b[0]===0xff && (b[1]&0xf6)===0xf0;
    return false;
  } catch { return false; }
}

function normalizeContactText(value: unknown) {
  return String(value || "").toLowerCase().replace(/\s+/g, " ").trim();
}

function tokenizeContactText(value: unknown) {
  return normalizeContactText(value).split(/[^\p{L}\p{N}]+/u).filter(Boolean);
}

function hasPrivateKeyword(values: unknown[]) {
  const contactTokens = values.flatMap(tokenizeContactText);
  if (!contactTokens.length) return false;

  const tokenText = ` ${contactTokens.join(" ")} `;
  return PRIVATE_CONTACT_KEYWORDS.some((keyword) => {
    const keywordTokens = tokenizeContactText(keyword);
    if (!keywordTokens.length) return false;
    return tokenText.includes(` ${keywordTokens.join(" ")} `);
  });
}

function defaultMimeForKind(kind: InboundMediaContext["kind"], rawMedia: any) {
  if (kind === "image") return firstString(rawMedia?.mimetype, rawMedia?.mimeType) || "image/jpeg";
  if (kind === "audio") return firstString(rawMedia?.mimetype, rawMedia?.mimeType) || "audio/ogg";
  if (kind === "video") return firstString(rawMedia?.mimetype, rawMedia?.mimeType) || "video/mp4";
  if (kind === "document") return firstString(rawMedia?.mimetype, rawMedia?.mimeType);
  return firstString(rawMedia?.mimetype, rawMedia?.mimeType);
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
  const msg = actualMessage(body);
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

export function extractSenderMeta(body: any) {
  const eventData = body?.data || body || {};
  return {
    pushName: eventData.pushName || body?.pushName || "",
    contactName: eventData.contactName || body?.contactName || eventData.contact?.name || body?.contact?.name || "",
    contactShortName: eventData.contact?.shortName || body?.contact?.shortName || "",
    contactPushName: eventData.contact?.pushName || eventData.contact?.pushname || body?.contact?.pushName || body?.contact?.pushname || "",
    isMyContact: Boolean(eventData.isMyContact || body?.isMyContact || eventData.contact?.isMyContact || body?.contact?.isMyContact),
  };
}

export function extractInboundMedia(body: any): InboundMediaContext | null {
  const msg = actualMessage(body);
  const messageType = String(body?.type || body?.mediaKind || body?.data?.type || "").trim().toLowerCase();
  const image = msg?.imageMessage || body?.imageMessage || body?.media?.imageMessage || (messageType === "image" ? body?.media || body : null);
  const document = msg?.documentMessage || body?.documentMessage || body?.media?.documentMessage || (messageType === "document" ? body?.media || body : null);
  const video = msg?.videoMessage || body?.videoMessage || body?.media?.videoMessage || (messageType === "video" ? body?.media || body : null);
  const audio = msg?.audioMessage || body?.audioMessage || body?.media?.audioMessage || (["audio", "ptt"].includes(messageType) ? body?.media || body : null);
  const sticker = msg?.stickerMessage || body?.stickerMessage || body?.media?.stickerMessage || (messageType === "sticker" ? body?.media || body : null);
  const ptv = msg?.ptvMessage || body?.ptvMessage || body?.media?.ptvMessage;
  const rawMedia = image || document || video || audio || sticker || ptv || body?.media || null;
  const hasMedia = Boolean(body?.hasMedia || body?.media || image || document || video || audio || sticker || ptv);
  if (!hasMedia) return null;

  const kind: InboundMediaContext["kind"] = image
    ? "image"
    : document
      ? "document"
      : video || ptv
        ? "video"
        : audio
          ? "audio"
          : sticker
            ? "sticker"
          : "unknown";
  const mimeType = firstString(body?.mimeType, body?.mediaType, defaultMimeForKind(kind, rawMedia));
  const mimeBase = normalizeMimeBase(mimeType);
  const sizeBytes =
    firstNumber(body?.fileLength, body?.sizeBytes, body?.mediaSize) || getDeclaredMediaBytes(rawMedia);
  const caption = firstString(body?.caption, rawMedia?.caption);
  const durationSeconds = firstNumber(body?.duration, body?.seconds, rawMedia?.seconds, rawMedia?.duration);
  const isVoiceNote = kind === "audio" && Boolean(
    messageType === "ptt" ||
    String(body?.mediaKind || body?.data?.mediaKind || "").toLowerCase() === "ptt" ||
    (rawMedia?.ptt ?? body?.ptt ?? body?.isPtt ?? body?.isVoiceNote ?? false)
  );
  const flags: string[] = [];

  if (kind !== "sticker" && !mimeBase) flags.push("missing_mime_type");
  if (kind === "document" && mimeBase !== "application/pdf") flags.push("unsupported_document");
  if (mimeBase && !ALLOWED_MEDIA_MIME.test(mimeType)) flags.push("unsupported_mime_type");
  if (kind !== "sticker" && kind !== "video" && sizeBytes > maxBytesForKind(kind)) flags.push("media_too_large");
  if (kind === "video") flags.push("video_unsupported");
  if (kind === "audio" && !isVoiceNote) flags.push("music_audio_not_supported");
  if (kind === "audio" && durationSeconds > MAX_VOICE_SECONDS) flags.push("voice_too_long");
  if (
    kind === "audio" &&
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
    ].includes(mimeBase)
  ) {
    flags.push("unsupported_audio_mime");
  }
  if (kind === "unknown") flags.push("unknown_media_type");

  const historyLabel =
    kind === "audio"
      ? "[Audio sent]"
      : kind === "image"
        ? "[Photo sent]"
        : kind === "document"
          ? "[Document sent]"
          : kind === "video"
            ? "[Video sent]"
            : kind === "sticker"
              ? "[Sticker sent]"
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
    durationSeconds: durationSeconds || undefined,
    isVoiceNote,
  };
}

export function safeMediaMetadata(mediaContext: InboundMediaContext | null | undefined) {
  if (!mediaContext) return null;
  return {
    hasMedia: true,
    kind: mediaContext.kind,
    mimeType: mediaContext.mimeType,
    sizeBytes: mediaContext.sizeBytes,
    valid: mediaContext.valid,
    reason: mediaContext.reason,
    flags: mediaContext.flags.slice(0, 8),
    caption: String(mediaContext.caption || "").slice(0, 500),
    messageId: mediaContext.messageId,
    durationSeconds: mediaContext.durationSeconds,
    isVoiceNote: mediaContext.isVoiceNote,
    analysis: mediaContext.analysis ? {
      type: String(mediaContext.analysis.type || "").slice(0, 40),
      analysis: String(mediaContext.analysis.analysis || "").slice(0, 1000),
      admin_summary: String(mediaContext.analysis.admin_summary || "").slice(0, 1000),
    } : undefined,
    historyLabel: mediaContext.historyLabel,
  };
}

export function detectOggOpusDurationSeconds(base64Value = "") {
  try {
    const raw = String(base64Value || "").includes(",") ? String(base64Value).split(",").pop() || "" : String(base64Value || "");
    const buffer = Buffer.from(raw, "base64");
    if (buffer.length < 27 || buffer.subarray(0, 4).toString("ascii") !== "OggS") return 0;
    let offset = 0;
    let maxGranule = 0n;
    while (offset + 27 <= buffer.length && buffer.subarray(offset, offset + 4).toString("ascii") === "OggS") {
      const segmentCount = buffer[offset + 26];
      if (offset + 27 + segmentCount > buffer.length) break;
      let bodyLength = 0;
      for (let index = 0; index < segmentCount; index += 1) bodyLength += buffer[offset + 27 + index];
      const pageLength = 27 + segmentCount + bodyLength;
      if (offset + pageLength > buffer.length) break;
      const granule = buffer.readBigUInt64LE(offset + 6);
      if (granule !== 0xffffffffffffffffn && granule > maxGranule) maxGranule = granule;
      offset += pageLength;
    }
    return maxGranule > 0n ? Number(maxGranule) / 48000 : 0;
  } catch {
    return 0;
  }
}

function cleanDataUrlBase64(value = "", fallbackMimeType = "application/octet-stream") {
  const raw = String(value || "").trim();
  if (!raw) return null;
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

function mediaDownloadUrl(body: any) {
  return firstString(
    body?.mediaUrl,
    body?.downloadUrl,
    body?.url,
    body?.media?.url,
    body?.media?.downloadUrl,
    body?.media?.mediaUrl,
    body?.data?.mediaUrl,
    body?.data?.downloadUrl,
    body?.data?.media?.url,
    body?.message?.mediaUrl,
    body?.message?.downloadUrl
  );
}

function directMediaBase64(body: any) {
  return firstString(
    body?.base64,
    body?.dataUrl,
    body?.mediaData,
    body?.media?.base64,
    body?.media?.data,
    body?.media?.dataUrl,
    body?.data?.base64,
    body?.data?.mediaData,
    body?.data?.media?.base64,
    body?.message?.base64
  );
}

function webhookInstanceId(body: any) {
  return firstString(
    body?.instance,
    body?.instanceId,
    body?.instance_id,
    body?.restaurant_id,
    body?.restaurant_instance,
    body?.data?.instance,
    body?.data?.instanceId
  );
}

async function whatsproHeaders(instanceId = "") {
  const headers: Record<string, string> = {};
  const config = instanceId ? await getRestaurantConfig(instanceId).catch(() => null) : null;
  const token = firstString(
    config?.whatspro_api_token,
    config?.whatsproApiToken
  );
  if (token) {
    headers.authorization = `Bearer ${token}`;
    headers["x-api-key"] = token;
  }
  // The media URL already carries the instance in its path, but say it here too
  // so a per-restaurant token works whatever shape the URL arrives in.
  if (instanceId) headers["x-chat-instance"] = instanceId;
  return headers;
}

export async function getBase64Media(body: any, mediaContext: InboundMediaContext | null = extractInboundMedia(body)) {
  const mimeType = mediaContext?.mimeType || firstString(body?.mimeType, body?.mediaType) || "application/octet-stream";
  const direct = cleanDataUrlBase64(directMediaBase64(body), mimeType);
  const maxBytes = maxBytesForKind(mediaContext?.kind || "unknown");
  if (direct?.base64) {
    const estimatedBytes = Math.floor(direct.base64.length * 0.75);
    if (estimatedBytes > maxBytes) return { error: "media_too_large" as const };
    return direct;
  }

  const url = mediaDownloadUrl(body);
  if (!url) return null;

  try {
    const response = await fetch(url, { headers: await whatsproHeaders(webhookInstanceId(body)) });
    if (!response.ok) throw new Error(`MEDIA_HTTP_${response.status}`);
    const contentLength = Number(response.headers.get("content-length") || 0);
    if (contentLength > maxBytes) throw new Error("MEDIA_TOO_LARGE");

    const arrayBuffer = await response.arrayBuffer();
    if (arrayBuffer.byteLength > maxBytes) throw new Error("MEDIA_TOO_LARGE");
    const responseMimeType = response.headers.get("content-type")?.split(";")[0] || mimeType;
    const base64 = Buffer.from(arrayBuffer).toString("base64");
    return {
      dataUrl: `data:${responseMimeType};base64,${base64}`,
      base64,
      mimeType: responseMimeType,
    };
  } catch (error: any) {
    console.error("[DOWNLOAD MEDIA ERROR]:", error?.message || error);
    return { error: error?.message === "MEDIA_TOO_LARGE" ? "media_too_large" as const : "media_download_failed" as const };
  }
}

// WhatsApp often delivers Kaspi PDF receipts as a documentMessage with no
// mimetype. extractInboundMedia can only flag that as missing_mime_type (plus
// unsupported_document, which is a consequence of the same unknown mime), so
// both are re-decided from the download's content-type below. Every other flag
// still rejects before we spend a download.
const MIME_RECOVERABLE_FLAGS = new Set(["missing_mime_type", "unsupported_document"]);

function isMimeRecoverable(mediaContext: InboundMediaContext) {
  return mediaContext.flags.includes("missing_mime_type")
    && mediaContext.flags.every((flag) => MIME_RECOVERABLE_FLAGS.has(flag));
}

export async function hydrateInboundMedia(body: any, mediaContext: InboundMediaContext | null): Promise<InboundMediaContext | null> {
  if (!mediaContext) return null;
  if (!mediaContext.valid && !isMimeRecoverable(mediaContext)) return mediaContext;
  if (mediaContext.kind === "sticker" || mediaContext.kind === "video") return mediaContext;
  const downloaded = await getBase64Media(body, mediaContext);
  if (!downloaded) return { ...mediaContext, valid: false, reason: "media_download_failed", flags: [...mediaContext.flags, "media_download_failed"] };
  if ("error" in downloaded) return { ...mediaContext, valid: false, reason: downloaded.error, flags: Array.from(new Set([...mediaContext.flags, downloaded.error])) };
  if (!downloaded.base64) return { ...mediaContext, valid: false, reason: "media_download_failed", flags: [...mediaContext.flags, "media_download_failed"] };
  const downloadedMime = normalizeMimeBase(downloaded.mimeType || mediaContext.mimeType);
  if (!ALLOWED_MEDIA_MIME.test(downloadedMime)) return { ...mediaContext, valid: false, reason: "unsupported_mime_type", flags: [...mediaContext.flags, "unsupported_mime_type"] };
  if (!mediaSignatureMatches(downloadedMime, downloaded.base64)) return { ...mediaContext, valid: false, reason: "media_signature_mismatch", flags: Array.from(new Set([...mediaContext.flags, "media_signature_mismatch"])) };
  if (mediaContext.kind === "audio" && mediaContext.isVoiceNote && !mediaContext.durationSeconds && !["audio/ogg","audio/opus"].includes(downloadedMime)) return { ...mediaContext, valid: false, reason: "voice_duration_unverified", flags: Array.from(new Set([...mediaContext.flags, "voice_duration_unverified"])) };
  const measuredDuration = mediaContext.kind === "audio" && mediaContext.isVoiceNote && !mediaContext.durationSeconds
    ? detectOggOpusDurationSeconds(downloaded.base64)
    : Number(mediaContext.durationSeconds || 0);
  if (mediaContext.kind === "audio" && mediaContext.isVoiceNote && measuredDuration > MAX_VOICE_SECONDS) {
    return {
      ...mediaContext,
      valid: false,
      reason: "voice_too_long",
      flags: Array.from(new Set([...mediaContext.flags, "voice_too_long"])),
      durationSeconds: Math.ceil(measuredDuration),
    };
  }
  return {
    ...mediaContext,
    mimeType: downloaded.mimeType || mediaContext.mimeType,
    mediaType: downloaded.mimeType || mediaContext.mediaType,
    sizeBytes: Math.floor(downloaded.base64.length * 0.75),
    base64: downloaded.dataUrl,
    dataUrl: downloaded.dataUrl,
    durationSeconds: measuredDuration || mediaContext.durationSeconds,
    // The download answered what the mime actually is, so the mime-only flags
    // are settled. A no-op for media that arrived valid: its flags are empty.
    flags: mediaContext.flags.filter((flag) => !MIME_RECOVERABLE_FLAGS.has(flag)),
    valid: true,
    reason: undefined,
  };
}

async function getFreshOperatorMute(instanceId: string, phone: string) {
  if (!redisClient.isOpen) return "";

  const key = `mute:${instanceId}:${phone}`;
  const value = String((await redisClient.get(key).catch(() => "")) || "");
  if (!/^(muted|muted_by_agent)$/.test(value)) return "";

  const ttl = await redisClient.ttl(key).catch(() => -2);
  if (ttl < 0 || ttl > OPERATOR_MUTE_MAX_SECONDS) {
    await redisClient.del(key).catch(() => undefined);
    console.warn(`[OPERATOR MUTE] stale mute cleared: ${key}, ttl=${ttl}`);
    return "";
  }

  return value;
}

async function getFreshOperatorActive(instanceId: string, phone: string) {
  if (!redisClient.isOpen) return "";

  const key = `operator_active:${instanceId}:${phone}`;
  const value = String((await redisClient.get(key).catch(() => "")) || "");
  if (!value) return "";

  const ttl = await redisClient.ttl(key).catch(() => -2);
  if (ttl < 0 || ttl > Math.max(OPERATOR_ACTIVE_SECONDS, OPERATOR_MUTE_MAX_SECONDS)) {
    await redisClient.del(key).catch(() => undefined);
    console.warn(`[OPERATOR ACTIVE] stale lock cleared: ${key}, ttl=${ttl}`);
    return "";
  }

  return value;
}

async function getTestModeDevPhone(instanceId: string) {
  const config = await getRestaurantConfig(instanceId).catch(() => null);
  return String(config?.dev_phone || "").replace(/\D/g, "");
}

export async function setOperatorAutoMute(instanceId: string, phone: string): Promise<void> {
  const safeInstanceId = String(instanceId || "").trim();
  const safePhone = String(phone || "").replace(/\D/g, "");
  if (!safeInstanceId || !safePhone) return;
  await connectRedis();
  await redisClient
    .multi()
    .setEx(`mute:${safeInstanceId}:${safePhone}`, OPERATOR_MUTE_MAX_SECONDS, "muted_by_agent")
    .setEx(`operator_active:${safeInstanceId}:${safePhone}`, OPERATOR_ACTIVE_SECONDS, "openbot_from_me")
    .exec();
}

export async function guardIncomingMessage(input: {
  instanceId: string;
  phone: string;
  text: string;
  messageId?: string;
  fromMe?: boolean;
  isGroup?: boolean;
  senderMeta?: Record<string, any>;
}): Promise<GuardResult> {
  const instanceId = String(input.instanceId || "").trim();
  const phone = String(input.phone || "").replace(/\D/g, "");
  const text = String(input.text || "").trim();
  const messageId = String(input.messageId || "").trim();

  if (input.fromMe) return { blocked: true, reason: "fromMe" };
  if (input.isGroup) return { blocked: true, reason: "group_message" };
  if (!INSTANCE_RE.test(instanceId)) return { blocked: true, reason: "bad_instance" };
  if (!PHONE_RE.test(phone)) return { blocked: true, reason: "bad_phone" };

  if (process.env.TEST_MODE_ENABLED === "true") {
    const devPhone = await getTestModeDevPhone(instanceId);
    if (!devPhone || phone !== devPhone) {
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
  if (hasPrivateKeyword(privateNames)) return { blocked: true, reason: "private_contact_keyword" };
  if (ignoreSavedContacts && Boolean(input.senderMeta?.isMyContact)) return { blocked: true, reason: "private_saved_contact" };

  try {
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
      if (!lock) return { blocked: true, reason: "duplicate_processing" };
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
    if (count === 1) await redisClient.expire(spamKey, SPAM_WINDOW_SECONDS);
    if (count > SPAM_LIMIT) {
      await redisClient.setEx(`mute:${instanceId}:${phone}`, MUTE_SECONDS, "spam_blocked");
      await markInboundDone(instanceId, messageId);
      return { blocked: true, reason: "spam_limit_exceeded" };
    }

    return { blocked: false };
  } catch (error: any) {
    console.warn(`[OPENBOT:GUARD] Redis unavailable, using tenant-local memory guard instance=${instanceId}:`, error?.message || error);
    return guardIncomingMessageInMemory(instanceId, phone, text, messageId);
  }
}

export async function markInboundDone(instanceId: string, messageId?: string): Promise<void> {
  const safeMessageId = String(messageId || "").trim();
  if (!safeMessageId) return;
  const key = localKey(instanceId, safeMessageId);
  localProcessing.delete(key);
  localDone.set(key, Date.now() + DONE_SECONDS * 1000);
  try {
    await connectRedis();
    await redisClient
      .multi()
      .setEx(`msg_done:${instanceId}:${safeMessageId}`, DONE_SECONDS, "1")
      .del(`msg_processing:${instanceId}:${safeMessageId}`)
      .exec();
  } catch {
    // The local marker keeps WAL replays idempotent until Redis reconnects.
  }
}

export async function clearInboundProcessing(instanceId: string, messageId?: string): Promise<void> {
  const safeMessageId = String(messageId || "").trim();
  if (!safeMessageId) return;
  localProcessing.delete(localKey(instanceId, safeMessageId));
  try {
    await connectRedis();
    await redisClient.del(`msg_processing:${instanceId}:${safeMessageId}`);
  } catch {
    // Best effort: a Redis processing lock has its own short TTL.
  }
}

export async function saveMediaContext(
  instanceId: string,
  phone: string,
  mediaContext: InboundMediaContext
): Promise<void> {
  try {
    await connectRedis();
    await redisClient.setEx(
      `media_context:${instanceId}:${phone}`,
      MEDIA_CONTEXT_SECONDS,
      JSON.stringify({ ...safeMediaMetadata(mediaContext), savedAt: Date.now() })
    );
  } catch {
    // Media processing can continue from the current request context.
  }
}

export async function bufferInboundText(input: { instanceId: string; phone: string; messageId: string; text: string }): Promise<{ leader: boolean; text: string }> {
  const instanceId = String(input.instanceId || "").trim();
  const phone = String(input.phone || "").replace(/\D/g, "");
  const text = String(input.text || "").trim().slice(0, INBOUND_BUFFER_MAX_CHARS);
  const token = String(input.messageId || crypto.randomUUID()).slice(0, 160);
  if (!instanceId || !phone || !text) return { leader: true, text };
  try {
    await connectRedis();
    const listKey = `inbound_buffer:${instanceId}:${phone}`;
    const latestKey = `inbound_buffer_latest:${instanceId}:${phone}`;
    await redisClient.multi()
      .rPush(listKey, JSON.stringify({ token, text }))
      .lTrim(listKey, -INBOUND_BUFFER_MAX_ITEMS, -1)
      .expire(listKey, INBOUND_BUFFER_SECONDS)
      .set(latestKey, token, { EX: INBOUND_BUFFER_SECONDS })
      .exec();
    await new Promise((resolve) => setTimeout(resolve, INBOUND_BUFFER_DELAY_MS));
    if ((await redisClient.get(latestKey)) !== token) return { leader: false, text: "" };
    const rows = await redisClient.lRange(listKey, 0, -1);
    await redisClient.del([listKey, latestKey]);
    const parts = rows.map((row) => { try { return String(JSON.parse(row)?.text || "").trim(); } catch { return ""; } }).filter(Boolean);
    return { leader: true, text: parts.join(" ").slice(0, INBOUND_BUFFER_MAX_CHARS) };
  } catch {
    const now = Date.now();
    pruneLocalGuardState(now);
    const key = localKey(instanceId, phone);
    const current = localInboundBuffers.get(key) || { items: [], latestToken: "", expiresAt: 0 };
    current.items.push({ token, text });
    current.items = current.items.slice(-INBOUND_BUFFER_MAX_ITEMS);
    current.latestToken = token;
    current.expiresAt = now + INBOUND_BUFFER_SECONDS * 1000;
    localInboundBuffers.set(key, current);
    await new Promise((resolve) => setTimeout(resolve, INBOUND_BUFFER_DELAY_MS));
    const latest = localInboundBuffers.get(key);
    if (!latest || latest.latestToken !== token) return { leader: false, text: "" };
    localInboundBuffers.delete(key);
    return {
      leader: true,
      text: latest.items.map((item) => item.text).filter(Boolean).join(" ").slice(0, INBOUND_BUFFER_MAX_CHARS),
    };
  }
}

export async function claimMediaAiQuota(instanceId: string, phone: string): Promise<boolean> {
  try {
    await connectRedis();
    const key = `media_ai_quota:${instanceId}:${phone}`;
    const count = await redisClient.incr(key);
    if (count === 1) await redisClient.expire(key, 5 * 60);
    return count <= MEDIA_AI_LIMIT_PER_5_MINUTES;
  } catch {
    const key = localKey(instanceId, phone);
    const now = Date.now();
    const current = localMediaQuota.get(key);
    const next = current?.windowEndsAt && current.windowEndsAt > now
      ? { ...current, count: current.count + 1 }
      : { count: 1, windowEndsAt: now + 5 * 60 * 1000 };
    localMediaQuota.set(key, next);
    return next.count <= MEDIA_AI_LIMIT_PER_5_MINUTES;
  }
}

export async function clearMediaContext(instanceId: string, phone: string): Promise<void> {
  try {
    await connectRedis();
    await redisClient.del(`media_context:${instanceId}:${phone}`);
  } catch {
    // Best effort cleanup; the Redis key has a short TTL.
  }
}
