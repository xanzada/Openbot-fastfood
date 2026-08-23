import crypto from "node:crypto";
import { connectRedis, redisClient } from "./redis.service.js";
import { getRestaurantConfig } from "./platformConfig.service.js";
import { envNumber } from "../utils/envNumber.js";

const INSTANCE_RE = /^[a-zA-Z0-9_-]{2,64}$/;
const PHONE_RE = /^(\d{10,15}|\d+@lid)$/;
const SPAM_WINDOW_SECONDS = 60;
const SPAM_LIMIT = envNumber(process.env.OPENBOT_SPAM_LIMIT_PER_MINUTE, 15, { min: 1 });
const MUTE_SECONDS = envNumber(process.env.OPENBOT_SPAM_MUTE_SECONDS, 900, { min: 1 });
const DUPLICATE_TEXT_SECONDS = 5;
// The fragment buffer must outlive a full reply generation, otherwise a part
// that arrives while the previous answer is still being written expires before
// the leader can fold it in - the guest's second message simply vanished.
const INBOUND_BUFFER_SECONDS = envNumber(process.env.OPENBOT_INBOUND_BUFFER_TTL_SECONDS, 60, { min: 5 });
const INBOUND_BUFFER_DELAY_MS = envNumber(process.env.OPENBOT_INBOUND_BUFFER_MS, 2400, { min: 600 });
const INBOUND_BUFFER_MAX_ITEMS = 8;
const INBOUND_BUFFER_MAX_CHARS = 2000;
const PROCESSING_LOCK_SECONDS = 180;
const DONE_SECONDS = 86400;
const MEDIA_CONTEXT_SECONDS = 60;
const OPERATOR_MUTE_MAX_SECONDS = envNumber(process.env.OPERATOR_MUTE_MAX_SECONDS, 300, { min: 1 });
export const OPERATOR_ACTIVE_SECONDS = envNumber(process.env.OPERATOR_ACTIVE_SECONDS, 40, { min: 1 });
export const MAX_IMAGE_BYTES = envNumber(process.env.OPENBOT_MAX_IMAGE_BYTES || process.env.OPENBOT_MAX_MEDIA_BYTES, 5 * 1024 * 1024, { min: 1024 });
export const MAX_DOCUMENT_BYTES = envNumber(process.env.OPENBOT_MAX_DOCUMENT_BYTES || process.env.OPENBOT_MAX_MEDIA_BYTES, 5 * 1024 * 1024, { min: 1024 });
export const MAX_AUDIO_BYTES = envNumber(process.env.OPENBOT_MAX_AUDIO_BYTES, 8 * 1024 * 1024, { min: 1024 });
export const MAX_VOICE_SECONDS = envNumber(process.env.OPENBOT_MAX_VOICE_SECONDS, 180, { min: 1 });
const MEDIA_AI_LIMIT_PER_5_MINUTES = envNumber(process.env.OPENBOT_MEDIA_AI_LIMIT_PER_5_MINUTES, 6, { min: 1 });
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
  /**
   * The id the dedupe actually keyed on. Equal to messageId when the gateway sent one,
   * and a derived hash when it did not. Callers must mark THIS done, not the raw
   * messageId, or an id-less message takes a processing lock nobody ever releases.
   */
  dedupeId?: string;
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
  const message = eventData.message || body?.message || {};
  const anyMedia =
    message.imageMessage || message.documentMessage || message.audioMessage || message.videoMessage ||
    body?.imageMessage || body?.documentMessage || body?.audioMessage || body?.videoMessage ||
    body?.media || eventData.media || {};
  return {
    pushName: eventData.pushName || body?.pushName || "",
    contactName: eventData.contactName || body?.contactName || eventData.contact?.name || body?.contact?.name || "",
    contactShortName: eventData.contact?.shortName || body?.contact?.shortName || "",
    contactPushName: eventData.contact?.pushName || eventData.contact?.pushname || body?.contact?.pushName || body?.contact?.pushname || "",
    isMyContact: Boolean(eventData.isMyContact || body?.isMyContact || eventData.contact?.isMyContact || body?.contact?.isMyContact),
    // derivedInboundId hashes these to tell two uncaptioned photos apart. They were never
    // populated, so mediaMark was always empty: the first captionless photo set msg_done for
    // 24h and every later one was dropped as duplicate_done. A guest paying in two transfers
    // lost their second receipt (regression of ea32304, found 2026-08-23).
    mediaId: String(anyMedia?.id ?? anyMedia?.mediaId ?? anyMedia?.mediaKey ?? "").trim(),
    mediaSha256: String(anyMedia?.fileSha256 ?? anyMedia?.sha256 ?? anyMedia?.fileEncSha256 ?? "").trim(),
    mediaUrl: String(anyMedia?.url ?? anyMedia?.directPath ?? anyMedia?.mediaUrl ?? "").trim(),
    messageTimestamp: String(
      eventData.messageTimestamp ?? body?.messageTimestamp ?? eventData.timestamp ?? body?.timestamp ?? ""
    ).trim(),
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

// Test mode used to admit exactly one number, the tenant's `dev_phone`. The
// owner testing from their own handset was silently dropped as
// `test_mode_blocked`, which looks identical to a dead bot. Extra numbers can
// now be allow-listed per tenant (`test_phones`) or per deployment
// (TEST_MODE_ALLOWED_PHONES) without opening the bot to everyone.
function digitsOf(value: unknown) {
  return String(value ?? "").replace(/\D/g, "");
}

function normalizeChatPhone(value: unknown) {
  const raw = String(value ?? "").trim();
  if (/^\d+@lid$/i.test(raw)) return raw.toLowerCase();
  return digitsOf(raw);
}

function phoneListOf(value: unknown): string[] {
  // Split on separators only, never on whitespace: "+7 776 915 6184" is one
  // number written the way a human writes it, not four numbers.
  const raw = Array.isArray(value) ? value : String(value ?? "").split(/[,;|]+/);
  return raw.map((entry) => normalizeChatPhone(entry)).filter((entry) => PHONE_RE.test(entry));
}

export function testModeAllowedPhones(
  config: Record<string, any> | null | undefined,
  env: Record<string, string | undefined> = process.env
) {
  return new Set([
    ...phoneListOf(config?.dev_phone),
    ...phoneListOf(config?.test_phones ?? config?.testPhones),
    ...phoneListOf(env.TEST_MODE_ALLOWED_PHONES),
  ]);
}

export function shouldIgnoreSavedContacts(env: Record<string, string | undefined> = process.env) {
  return String(env.BOT_IGNORE_SAVED_CONTACTS ?? "true").trim().toLowerCase() !== "false";
}

async function getTestModeAllowedPhones(instanceId: string) {
  const config = await getRestaurantConfig(instanceId).catch(() => null);
  return testModeAllowedPhones(config);
}

export async function setOperatorAutoMute(instanceId: string, phone: string): Promise<void> {
  const safeInstanceId = String(instanceId || "").trim();
  const safePhone = normalizeChatPhone(phone);
  if (!safeInstanceId || !safePhone) return;
  await connectRedis();
  await redisClient
    .multi()
    .setEx(`mute:${safeInstanceId}:${safePhone}`, OPERATOR_MUTE_MAX_SECONDS, "muted_by_agent")
    .setEx(`operator_active:${safeInstanceId}:${safePhone}`, OPERATOR_ACTIVE_SECONDS, "openbot_from_me")
    .exec();
}

/**
 * A stable dedupe id for a payload the gateway sent without one.
 *
 * The guard keyed everything off messageId, so an id-less replay slipped past both the
 * done-marker and the processing lock. Hashing the tenant, the phone and the payload
 * gives the same key for the same message and a different key for a different one -
 * which is exactly what the missing id was supposed to provide.
 *
 * Media is included via its own metadata when present: two photos sent back to back with
 * no caption must not collapse into one.
 */
// The historyLabel a media turn carries when the guest sent no caption. Two different
// photos both arrive as this string, which is why they need a media discriminator.
const MEDIA_PLACEHOLDER_RE = /^\[(?:media sent|photo sent|voice message|document sent|фото|медиа)[^\]]*\]$/i;

export function derivedInboundId(
  instanceId: string,
  phone: string,
  text: string,
  senderMeta?: Record<string, any>
): string {
  const mediaMark = [
    senderMeta?.mediaId,
    senderMeta?.mediaSha256,
    senderMeta?.mediaUrl,
    senderMeta?.timestamp,
    senderMeta?.messageTimestamp,
  ]
    .map((value) => String(value ?? "").trim())
    .filter(Boolean)
    .join("|");
  const body = String(text || "").trim().toLowerCase();
  // Neither text nor any media discriminator: hashing this would make every such payload
  // collide, so it gets no key at all and the older per-message protections apply.
  if (!body && !mediaMark) return "";
  // Media present but the gateway gave us nothing stable to hash. Collapsing two different
  // photos into one id loses the second one, so an unidentifiable media payload is treated
  // as un-dedupable rather than as a repeat (found 2026-08-23).
  if (!mediaMark && MEDIA_PLACEHOLDER_RE.test(body)) return "";
  return `derived:${sha1(`${instanceId}|${phone}|${body}|${mediaMark}`)}`;
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
  const phone = normalizeChatPhone(input.phone);
  const text = String(input.text || "").trim();
  const messageId = String(input.messageId || "").trim();

  if (input.fromMe) return { blocked: true, reason: "fromMe" };
  if (input.isGroup) return { blocked: true, reason: "group_message" };
  if (!INSTANCE_RE.test(instanceId)) return { blocked: true, reason: "bad_instance" };
  if (!PHONE_RE.test(phone)) return { blocked: true, reason: "bad_phone" };

  if (process.env.TEST_MODE_ENABLED === "true") {
    const allowed = await getTestModeAllowedPhones(instanceId);
    if (!allowed.size || !allowed.has(phone)) {
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
  const ignoreSavedContacts = shouldIgnoreSavedContacts();
  if (hasPrivateKeyword(privateNames)) return { blocked: true, reason: "private_contact_keyword" };
  if (ignoreSavedContacts && Boolean(input.senderMeta?.isMyContact)) return { blocked: true, reason: "private_saved_contact" };

  try {
    await connectRedis();

    // A payload with no id used to skip BOTH the done-marker and the processing lock, so
    // a gateway replay more than DUPLICATE_TEXT_SECONDS later was processed a second time
    // in full: second reply, second media analysis, second receipt. The 5-second text
    // hash was the only thing standing there (found 2026-08-23). A derived id closes it:
    // same tenant, same phone, same payload means the same message, and two genuinely
    // different messages hash differently. Derived before the first early return, so
    // every branch below marks the same key the lock was taken under.
    const dedupeId = messageId || derivedInboundId(instanceId, phone, text, input.senderMeta);

    const operatorActive = await getFreshOperatorActive(instanceId, phone);
    if (operatorActive) {
      await markInboundDone(instanceId, dedupeId);
      return { blocked: true, reason: "operator_active", source: "operator_override", dedupeId };
    }

    if (dedupeId) {
      if (await redisClient.get(`msg_done:${instanceId}:${dedupeId}`)) {
        return { blocked: true, reason: "duplicate_done", dedupeId };
      }
      const lock = await redisClient.set(`msg_processing:${instanceId}:${dedupeId}`, "1", {
        NX: true,
        EX: PROCESSING_LOCK_SECONDS,
      });
      if (!lock) return { blocked: true, reason: "duplicate_processing", dedupeId };
    }

    const operatorMute = await getFreshOperatorMute(instanceId, phone);
    if (operatorMute) {
      await markInboundDone(instanceId, dedupeId);
      return { blocked: true, reason: "muted", source: "operator_override", dedupeId };
    }

    if (await redisClient.get(`mute:${instanceId}:${phone}`)) {
      await markInboundDone(instanceId, dedupeId);
      return { blocked: true, reason: "muted", dedupeId };
    }

    if (text) {
      const duplicateKey = `anti_dup:${instanceId}:${phone}`;
      const textHash = sha1(text.toLowerCase());
      const previousHash = await redisClient.get(duplicateKey);
      if (previousHash === textHash) {
        await markInboundDone(instanceId, dedupeId);
        return { blocked: true, reason: "duplicate_text", dedupeId };
      }
      await redisClient.setEx(duplicateKey, DUPLICATE_TEXT_SECONDS, textHash);
    }

    const spamKey = `spam:${instanceId}:${phone}`;
    const count = await redisClient.incr(spamKey);
    if (count === 1) await redisClient.expire(spamKey, SPAM_WINDOW_SECONDS);
    if (count > SPAM_LIMIT) {
      await redisClient.setEx(`mute:${instanceId}:${phone}`, MUTE_SECONDS, "spam_blocked");
      await markInboundDone(instanceId, dedupeId);
      return { blocked: true, reason: "spam_limit_exceeded", dedupeId };
    }

    return { blocked: false, dedupeId };
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

export async function bufferInboundText(input: { instanceId: string; phone: string; messageId: string; text: string }): Promise<{ leader: boolean; text: string; parts: number; items: string[] }> {
  const instanceId = String(input.instanceId || "").trim();
  const phone = normalizeChatPhone(input.phone);
  const text = String(input.text || "").trim().slice(0, INBOUND_BUFFER_MAX_CHARS);
  const token = String(input.messageId || crypto.randomUUID()).slice(0, 160);
  if (!instanceId || !phone || !text) return { leader: true, text, parts: text ? 1 : 0, items: text ? [text] : [] };
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
    if ((await redisClient.get(latestKey)) !== token) return { leader: false, text: "", parts: 0, items: [] };
    const rows = await redisClient.lRange(listKey, 0, -1);
    await redisClient.del([listKey, latestKey]);
    const parts = rows.map((row) => { try { return String(JSON.parse(row)?.text || "").trim(); } catch { return ""; } }).filter(Boolean);
    return { leader: true, text: parts.join(" ").slice(0, INBOUND_BUFFER_MAX_CHARS), parts: parts.length, items: parts.slice(0, INBOUND_BUFFER_MAX_ITEMS) };
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
    if (!latest || latest.latestToken !== token) return { leader: false, text: "", parts: 0, items: [] };
    localInboundBuffers.delete(key);
    const localParts = latest.items.map((item) => String(item?.text || "").trim()).filter(Boolean);
    return {
      leader: true,
      text: localParts.join(" ").slice(0, INBOUND_BUFFER_MAX_CHARS),
      parts: localParts.length,
      items: localParts.slice(0, INBOUND_BUFFER_MAX_ITEMS),
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

/**
 * Turn-level single-flight lock per (tenant, customer).
 *
 * The per-messageId lock only stops the SAME message being processed twice;
 * it never stopped TWO different batches of one customer's split messages from
 * being answered in parallel - which is exactly how a guest who wrote "сәлем"
 * then "пицца бар ма" got two replies. One conversation = one turn at a time.
 */
// 90s was shorter than a worst-case turn, so a slow turn outlived its own lock: the next
// message acquired the "free" lock and the guest got two replies - precisely what this
// lock exists to stop (found 2026-08-23). The bound is now derived from the budgets that
// actually govern a turn, so raising one of them cannot silently un-protect the lock:
//   the wait for a previous turn (45s, the route's own loop)
// + the buffer settle (INBOUND_BUFFER_DELAY_MS)
// + the agent's own ceiling (REGEN_BUDGET_MS, which already includes the critic)
// + the outbound send sequence, which retries per chunk on a 10s axios timeout
// + headroom, because none of these is a hard kill
const TURN_WAIT_CEILING_MS = 45_000;
const TURN_SEND_CEILING_MS = 60_000;
const TURN_LOCK_FALLBACK_TTL_MS = Math.max(
  90_000,
  TURN_WAIT_CEILING_MS
    + INBOUND_BUFFER_DELAY_MS
    + envNumber(process.env.REGEN_BUDGET_MS, 38_000, { min: 1_000 })
    + TURN_SEND_CEILING_MS
);
const localTurnLocks = new Map<string, { owner: string; expiresAt: number }>();

export async function acquireTurnLock(instanceId: string, phone: string, ttlMs = TURN_LOCK_FALLBACK_TTL_MS): Promise<string | null> {
  const owner = crypto.randomUUID();
  const key = `turn_lock:${instanceId}:${phone}`;
  try {
    await connectRedis();
    const claimed = await redisClient.set(key, owner, { NX: true, PX: Math.max(5_000, ttlMs) });
    return claimed ? owner : null;
  } catch {
    const now = Date.now();
    const local = localTurnLocks.get(key);
    if (local && local.expiresAt > now) return null;
    localTurnLocks.set(key, { owner, expiresAt: now + Math.max(5_000, ttlMs) });
    return owner;
  }
}

// Compare-and-delete in one step. A GET followed by a DEL leaves a window where the lock
// expires and the NEXT turn acquires it after the comparison has already passed - so this
// turn deletes a lock it no longer owns and the next turn runs unprotected (found
// 2026-08-23). One guest, two replies, from the code meant to prevent exactly that.
const RELEASE_TURN_LOCK_LUA =
  "if redis.call('get', KEYS[1]) == ARGV[1] then return redis.call('del', KEYS[1]) else return 0 end";

export async function releaseTurnLock(instanceId: string, phone: string, owner: string): Promise<void> {
  const key = `turn_lock:${instanceId}:${phone}`;
  try {
    await connectRedis();
    try {
      await redisClient.eval(RELEASE_TURN_LOCK_LUA, { keys: [key], arguments: [owner] });
      return;
    } catch (scriptError: any) {
      // A Redis build or proxy that refuses EVAL must not leave the lock held for its
      // whole TTL, so fall back to the previous read-then-delete. It carries the same race
      // it always did, which is strictly better than not releasing at all.
      console.warn(`[OPENBOT:GUARD] turn lock EVAL unavailable, using compare-then-delete:`, scriptError?.message || scriptError);
      const current = await redisClient.get(key);
      if (current === owner) await redisClient.del(key);
      return;
    }
  } catch {
    const local = localTurnLocks.get(key);
    if (local?.owner === owner) localTurnLocks.delete(key);
  }
}

/**
 * Non-blocking sweep of the fragment buffer. After a reply is sent, anything
 * left in the buffer belongs to the SAME burst of messages - deleting it is
 * what stops a leftover part from becoming a second answer a minute later.
 * Returns the leftover parts so a lock-holding leader can still fold them into
 * its own turn instead of dropping them.
 */
export async function drainInboundBuffer(instanceId: string, phone: string): Promise<string[]> {
  const listKey = `inbound_buffer:${instanceId}:${phone}`;
  const latestKey = `inbound_buffer_latest:${instanceId}:${phone}`;
  try {
    await connectRedis();
    const rows = await redisClient.lRange(listKey, 0, -1);
    await redisClient.del([listKey, latestKey]);
    return rows
      .map((row) => {
        try {
          return String(JSON.parse(row)?.text || "").trim();
        } catch {
          return "";
        }
      })
      .filter(Boolean);
  } catch {
    const key = localKey(instanceId, phone);
    const current = localInboundBuffers.get(key);
    if (!current) return [];
    localInboundBuffers.delete(key);
    return current.items.map((item) => String(item?.text || "").trim()).filter(Boolean);
  }
}

/**
 * Put a guest message BACK into the fragment buffer without waiting on it.
 *
 * Used when a turn is already in flight for this conversation: dropping the
 * part meant the guest's second message was never seen at all. Requeued parts
 * are picked up by the next leader (or folded in by the finishing turn), so
 * nothing the guest wrote is silently lost.
 */
export async function requeueInboundText(input: { instanceId: string; phone: string; messageId: string; text: string }): Promise<boolean> {
  const instanceId = String(input.instanceId || "").trim();
  const phone = normalizeChatPhone(input.phone);
  const text = String(input.text || "").trim().slice(0, INBOUND_BUFFER_MAX_CHARS);
  const token = String(input.messageId || crypto.randomUUID()).slice(0, 160);
  if (!instanceId || !phone || !text) return false;
  try {
    await connectRedis();
    const listKey = `inbound_buffer:${instanceId}:${phone}`;
    const latestKey = `inbound_buffer_latest:${instanceId}:${phone}`;
    // The latest-token marker is what makes a part visible to a future leader. Without
    // it the requeued message sat in a list nobody was waiting on, and the finishing
    // turn's sweep deleted it unanswered - "nothing the guest wrote is silently lost"
    // was not true (found 2026-08-23).
    await redisClient.multi()
      .rPush(listKey, JSON.stringify({ token, text }))
      .lTrim(listKey, -INBOUND_BUFFER_MAX_ITEMS, -1)
      .expire(listKey, INBOUND_BUFFER_SECONDS)
      .set(latestKey, token, { EX: INBOUND_BUFFER_SECONDS })
      .exec();
    return true;
  } catch {
    const now = Date.now();
    const key = localKey(instanceId, phone);
    const current = localInboundBuffers.get(key) || { items: [], latestToken: "", expiresAt: 0 };
    current.items.push({ token, text });
    current.items = current.items.slice(-INBOUND_BUFFER_MAX_ITEMS);
    // Same reason as the Redis path: the fallback must leave a token behind too.
    current.latestToken = token;
    current.expiresAt = now + INBOUND_BUFFER_SECONDS * 1000;
    localInboundBuffers.set(key, current);
    return true;
  }
}

/**
 * Outbound duplicate guard. Incoming dedupe only watched the customer side;
 * nothing watched OUR side, so two parallel turns could send the guest the
 * same answer twice. The normalized hash of the last reply is remembered for a
 * short window and an identical resend is skipped.
 */
const OUTBOUND_DUP_SECONDS = 60;
const localOutboundClaims = new Map<string, number>();

export function normalizeReplyText(text: string): string {
  return String(text || "").toLowerCase().replace(/\s+/g, " ").trim().slice(0, 600);
}

export async function claimOutboundReply(instanceId: string, phone: string, text: string, turnKey = ""): Promise<boolean> {
  const normalized = normalizeReplyText(text);
  if (!normalized) return true;
  const key = `outbound_dup:${instanceId}:${phone}`;
  // The guard must stop the SAME turn being answered twice (retried webhook,
  // parallel batch) - never a NEW guest message that happens to deserve the
  // same answer. Without the turn in the hash, a guest who asked the very same
  // question again within 60s got total silence instead of a reply.
  const hash = sha1(`${String(turnKey || "").trim()}|${normalized}`);
  try {
    await connectRedis();
    const claimed = await redisClient.set(key, hash, { NX: true, EX: OUTBOUND_DUP_SECONDS });
    if (claimed) return true;
    const previous = await redisClient.get(key);
    if (previous !== hash) {
      await redisClient.set(key, hash, { EX: OUTBOUND_DUP_SECONDS });
      return true;
    }
    return false;
  } catch {
    const now = Date.now();
    const localKeyFull = `${key}:${hash}`;
    const expiresAt = localOutboundClaims.get(localKeyFull);
    if (expiresAt && expiresAt > now) return false;
    localOutboundClaims.set(localKeyFull, now + OUTBOUND_DUP_SECONDS * 1000);
    return true;
  }
}
