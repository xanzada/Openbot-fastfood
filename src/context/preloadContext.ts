import crypto from "node:crypto";
import { detectLanguageDecision, isLanguageBearingCustomerText } from "../utils/language.js";
import { generateSecureMenuUrl, hasExplicitMenuLinkIntent, normalizeMenuDomain } from "../utils/magicLink.js";
import { getOrderStatus, getRuntimeStatus } from "../services/dle.service.js";
import { getRestaurantConfig, getShporContext } from "../services/nocodb.service.js";
import {
  connectRedis,
  getActiveShiftNotes,
  getChatHistory,
  getSiteLanguageHint,
  getUserLang,
  hasMagicLinkBeenSent,
  saveUserLang,
} from "../services/redis.service.js";
import type { FastFoodContext } from "./types.js";

export interface InboundMessage {
  instanceId: string;
  phone: string;
  text: string;
  languageCandidateText?: string;
  mediaContext?: Record<string, any> | null;
  senderMeta?: Record<string, any>;
}

export interface ContextHealth {
  ok: boolean;
  redis: boolean;
  runtime: boolean;
  config: boolean;
  order: boolean;
  notes: boolean;
  shpor: boolean;
}

function firstValue(...values: unknown[]) {
  for (const value of values) {
    if (value !== undefined && value !== null && String(value).trim() !== "") return String(value).trim();
  }
  return "";
}

export async function preloadContext(input: InboundMessage): Promise<FastFoodContext> {
  await connectRedis();

  const instanceId = String(input.instanceId || "").trim();
  const phone = String(input.phone || "").replace(/\D/g, "");
  const text = String(input.text || "").trim();

  if (!instanceId) throw new Error("instanceId is required");
  if (!phone) throw new Error("phone is required");
  if (!text) throw new Error("text is required");

  const [config, storedLang, siteLanguageHint, chatHistory, activeShiftNotes, magicLinkAlreadySent] =
    await Promise.all([
      getRestaurantConfig(instanceId),
      getUserLang(instanceId, phone).catch(() => null),
      getSiteLanguageHint(instanceId, phone).catch(() => null),
      getChatHistory(instanceId, phone).catch(() => []),
      getActiveShiftNotes(instanceId).catch(() => []),
      hasMagicLinkBeenSent(instanceId, phone).catch(() => false),
    ]);

  const safeConfig = { ...(config || {}) };
  const activeShiftNotesFingerprint = activeShiftNotes.length
    ? crypto.createHash("sha256").update(activeShiftNotes.map((note) => `${String(note?.text || "").trim()}|${Number(note?.expiresAt || 0) || 0}`).sort().join("\n")).digest("hex")
    : "";
  const languageCandidateText = String(input.languageCandidateText ?? text).trim();
  let language: "kk" | "ru" = storedLang || siteLanguageHint || "kk";
  let languageDetector: "redis_lock" | "gemini" | "fallback" | "site_hint" = storedLang ? "redis_lock" : siteLanguageHint ? "site_hint" : "fallback";
  let languageLocked = Boolean(storedLang);
  if (!storedLang && isLanguageBearingCustomerText(languageCandidateText)) {
    const decision = await detectLanguageDecision(languageCandidateText);
    language = decision.language;
    languageDetector = decision.detector;
    // Only a real classification earns the 24-hour lock. The regex fallback
    // answers Russian for any text without Kazakh letters, and locking that
    // kept answering a Kazakh guest in Russian for a whole day. When the
    // classifier could not decide, this turn still uses its guess but the next
    // message gets another chance to classify.
    if (decision.lockable) {
      const claimed = await saveUserLang(instanceId, phone, language).catch(() => false);
      if (claimed) languageLocked = true;
      else {
        const concurrentLock = await getUserLang(instanceId, phone).catch(() => null);
        if (concurrentLock) { language = concurrentLock; languageDetector = "redis_lock"; languageLocked = true; }
      }
    } else {
      const concurrentLock = await getUserLang(instanceId, phone).catch(() => null);
      if (concurrentLock) { language = concurrentLock; languageDetector = "redis_lock"; languageLocked = true; }
    }
  }
  const domain = normalizeMenuDomain(safeConfig.domain || "") || "";
  if (domain) safeConfig.domain = domain;

  const [runtimeStatus, activeOrder, shporContext] = await Promise.all([
    getRuntimeStatus(instanceId, domain, { forceFresh: true }).catch(() => null),
    domain
      ? getOrderStatus(instanceId, phone, domain).catch(() => null)
      : Promise.resolve(null),
    getShporContext(instanceId, text).catch(() => []),
  ]);

  const runtimeAvailable = Boolean(runtimeStatus);
  const runtimeWaitTime = Number(
    runtimeStatus?.kitchen_status?.wait_time ??
    runtimeStatus?.wait_time ??
    runtimeStatus?.fetched_settings?.wait_time ??
    0
  ) || 0;
  const runtimeEmergency = Boolean(
    runtimeStatus?.kitchen_status?.is_emergency ??
    runtimeStatus?.is_emergency ??
    runtimeStatus?.fetched_settings?.is_emergency
  );
  const fetchedSettings = {
    wait_time: runtimeWaitTime,
    is_emergency: runtimeEmergency,
    source:
      runtimeStatus?.kitchen_status?.source ||
      runtimeStatus?.fetched_settings?.source ||
      runtimeStatus?.source ||
      "missing_settings.kitchen_status",
  };

  const hardRealtimeContext = {
    source: fetchedSettings.source,
    fetched_at: runtimeStatus?.fetched_at || new Date().toISOString(),
    kitchen_status: runtimeStatus?.kitchen_status
      ? {
          ...runtimeStatus.kitchen_status,
          wait_time: fetchedSettings.wait_time,
          is_emergency: fetchedSettings.is_emergency,
        }
      : null,
    wait_time: fetchedSettings.wait_time,
    delivery: runtimeStatus?.delivery ?? runtimeStatus?.kitchen_status?.delivery ?? null,
    pickup: runtimeStatus?.pickup ?? runtimeStatus?.kitchen_status?.pickup ?? null,
    is_emergency: fetchedSettings.is_emergency,
    reset_at: Number(runtimeStatus?.reset_at || runtimeStatus?.kitchen_status?.reset_at || 0) || 0,
    payment_details: Array.isArray(runtimeStatus?.payment_details) ? runtimeStatus.payment_details : Array.isArray(runtimeStatus?.kitchen_status?.payment_details) ? runtimeStatus.kitchen_status.payment_details : [],
    active_shift_notes: activeShiftNotes,
    stale: Boolean(runtimeStatus?.stale || runtimeStatus?.is_stale || runtimeStatus?.stale_runtime_backup),
    runtime_available: runtimeAvailable,
    redis_available: true,
  };

  return {
    instanceId,
    phone,
    text,
    senderMeta: input.senderMeta || {},
    language,
    languagePolicy: {
      cached: Boolean(storedLang),
      locked: languageLocked,
      detector: languageDetector,
      output: language === "ru" ? "pure_ru_only" : "pure_kk_only",
      rule:
        language === "ru"
          ? "Reply only in Russian. Do not mix Kazakh words into Russian sentences."
          : "Reply only in Kazakh. Do not mix Russian words into Kazakh sentences.",
    },
    config: safeConfig,
    runtimeStatus,
    fetchedSettings,
    hardRealtimeContext,
    activeOrder,
    chatHistory,
    activeShiftNotes,
    activeShiftNotesFingerprint,
    mediaContext: input.mediaContext || null,
    shporContext,
    magicLinkAlreadySent,
    explicitMenuLinkIntent: hasExplicitMenuLinkIntent(text),
    magicLink: generateSecureMenuUrl(
      domain,
      phone,
      firstValue(
        safeConfig.crm_secret_token,
        safeConfig.crmSecretToken,
        safeConfig.secret_token,
        safeConfig.secretToken,
        safeConfig.secret_key,
        safeConfig.secretKey
      )
    ),
  };
}
