import { detectLangWithFallback } from "../utils/language.js";
import { generateSecureMenuUrl, hasExplicitMenuLinkIntent, normalizeMenuDomain } from "../utils/magicLink.js";
import { getOrderStatus, getRuntimeStatus } from "../services/dle.service.js";
import { getRestaurantConfig, getShporContext } from "../services/nocodb.service.js";
import {
  connectRedis,
  getActiveShiftNotes,
  getChatHistory,
  getUserLang,
  hasMagicLinkBeenSent,
  saveUserLang,
} from "../services/redis.service.js";
import type { FastFoodContext } from "./types.js";

export interface InboundMessage {
  instanceId: string;
  phone: string;
  text: string;
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

export async function preloadContext(input: InboundMessage): Promise<FastFoodContext> {
  await connectRedis();

  const instanceId = String(input.instanceId || "").trim();
  const phone = String(input.phone || "").replace(/\D/g, "");
  const text = String(input.text || "").trim();

  if (!instanceId) throw new Error("instanceId is required");
  if (!phone) throw new Error("phone is required");
  if (!text) throw new Error("text is required");

  const [config, storedLang, chatHistory, activeShiftNotes, magicLinkAlreadySent] =
    await Promise.all([
      getRestaurantConfig(instanceId),
      getUserLang(instanceId, phone).catch(() => null),
      getChatHistory(instanceId, phone).catch(() => []),
      getActiveShiftNotes(instanceId).catch(() => []),
      hasMagicLinkBeenSent(instanceId, phone).catch(() => false),
    ]);

  const safeConfig = { ...(config || {}) };
  const language = await detectLangWithFallback(text, storedLang);
  const domain = normalizeMenuDomain(safeConfig.domain || "") || "";
  if (domain) safeConfig.domain = domain;

  const [runtimeStatus, activeOrder, shporContext] = await Promise.all([
    getRuntimeStatus(instanceId, domain, { forceFresh: true }).catch(() => null),
    domain
      ? getOrderStatus(instanceId, phone, domain).catch(() => null)
      : Promise.resolve(null),
    getShporContext(instanceId, text).catch(() => []),
  ]);

  await saveUserLang(instanceId, phone, language).catch(() => undefined);

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
    payment_details: Array.isArray(runtimeStatus?.payment_details) ? runtimeStatus.payment_details : [],
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
    mediaContext: input.mediaContext || null,
    shporContext,
    magicLinkAlreadySent,
    explicitMenuLinkIntent: hasExplicitMenuLinkIntent(text),
    magicLink: generateSecureMenuUrl(domain, phone),
  };
}
