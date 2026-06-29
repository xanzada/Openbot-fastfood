import { detectLang } from "../utils/language.js";
import { buildMagicLink, hasExplicitMenuLinkIntent } from "../utils/magicLink.js";
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

  const safeConfig = config || {};
  const language = detectLang(text, storedLang);
  const domain = safeConfig.domain || "";

  const [runtimeStatus, activeOrder, shporContext] = await Promise.all([
    domain
      ? getRuntimeStatus(instanceId, domain, { forceFresh: true }).catch(() => null)
      : Promise.resolve(null),
    domain
      ? getOrderStatus(instanceId, phone, domain).catch(() => null)
      : Promise.resolve(null),
    getShporContext(instanceId, text).catch(() => []),
  ]);

  await saveUserLang(instanceId, phone, language).catch(() => undefined);

  const hardRealtimeContext = {
    source: runtimeStatus?.source || "dle_spa_settings",
    fetched_at: runtimeStatus?.fetched_at || new Date().toISOString(),
    kitchen_status: runtimeStatus?.kitchen_status || null,
    wait_time: Number(runtimeStatus?.wait_time || runtimeStatus?.kitchen_status?.wait_time || 0) || 0,
    delivery: runtimeStatus?.delivery ?? runtimeStatus?.kitchen_status?.delivery ?? null,
    pickup: runtimeStatus?.pickup ?? runtimeStatus?.kitchen_status?.pickup ?? null,
    is_emergency: Boolean(runtimeStatus?.is_emergency || runtimeStatus?.kitchen_status?.is_emergency),
    reset_at: Number(runtimeStatus?.reset_at || runtimeStatus?.kitchen_status?.reset_at || 0) || 0,
    active_shift_notes: activeShiftNotes,
    stale: Boolean(runtimeStatus?.stale || runtimeStatus?.is_stale || runtimeStatus?.stale_runtime_backup),
  };

  return {
    instanceId,
    phone,
    text,
    language,
    config: safeConfig,
    runtimeStatus,
    hardRealtimeContext,
    activeOrder,
    chatHistory,
    activeShiftNotes,
    mediaContext: input.mediaContext || null,
    shporContext,
    magicLinkAlreadySent,
    explicitMenuLinkIntent: hasExplicitMenuLinkIntent(text),
    magicLink: buildMagicLink(domain, phone),
  };
}
