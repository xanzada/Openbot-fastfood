import crypto from "node:crypto";
import { detectLanguageDecision, isLanguageBearingCustomerText, lastCustomerLanguage } from "../utils/language.js";
import { hasExplicitMenuLinkIntent, normalizeMenuDomain } from "../utils/magicLink.js";
import { getMenuContext, getOrderStatus, getRuntimeStatus } from "../services/dle.service.js";
import { issueCustomerAccessLink } from "../services/alemiApi.service.js";
import { getRestaurantConfig, getShporContext } from "../services/platformConfig.service.js";
import {
  connectRedis,
  getActiveShiftNotes,
  getChatHistory,
  getSiteLanguageHint,
  getUserLang,
  hasMagicLinkBeenSent,
  replaceUserLang,
  saveUserLang,
} from "../services/redis.service.js";
import {
  getConversationSummary,
  getCustomerProfile,
  getTurnTrace,
} from "../services/customerMemory.service.js";
import { getActiveGoal } from "../services/goalTracker.service.js";
import { orderMentionedByItems, pickConversationOrder } from "../services/customerOrder.service.js";
import { lastDiscussedOrderNumber } from "../utils/orderIntent.js";
import { isLikelyComplaintText, isLikelyOperatorRequestText } from "../services/complaintRouting.service.js";
import { resolveOrganicLanguage, shouldSwitchLockedLanguage, textCarriesDecisiveLanguageSignal } from "../services/languagePolicy.service.js";
import type { FastFoodContext } from "./types.js";

/**
 * The menu used to reach the agent only when the model happened to call
 * searchMenu. When it did not, the turn ran with no menu at all and the model
 * filled the hole with a guess: real dishes were announced as "temporarily
 * unavailable". Availability is a fact, not a tool call, so a compact snapshot
 * of the live menu now rides in the context of every turn. It stays small:
 * name, price, category and a short composition, which is all an answer about
 * price, existence or ingredients needs.
 */
function buildMenuSnapshot(menu: any) {
  const items = Array.isArray(menu?.items) ? menu.items : [];
  if (!items.length) return null;
  return {
    source: String(menu?.source || ""),
    count: items.length,
    items: items.slice(0, 60).map((item: any) => ({
      name: String(item?.name || "").trim(),
      price: item?.price ?? null,
      category: String(item?.category_name || item?.category || "").trim(),
      composition: String(item?.composition || item?.description || "").trim().slice(0, 160),
      // Only the exception is carried: a sold-out dish must not be offered, and
      // saying "available: true" 60 times would spend context on the default.
      ...(item?.available === false ? { available: false } : {}),
    })).filter((item: any) => item.name),
  };
}

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
  const redisAvailable = await connectRedis().then(() => true).catch(() => false);

  const instanceId = String(input.instanceId || "").trim();
  const phone = String(input.phone || "").replace(/\D/g, "");
  const text = String(input.text || "").trim();

  if (!instanceId) throw new Error("instanceId is required");
  if (!phone) throw new Error("phone is required");
  if (!text) throw new Error("text is required");

  const [config, storedLang, siteLanguageHint, chatHistory, cachedShiftNotes, magicLinkAlreadySent] =
    await Promise.all([
      getRestaurantConfig(instanceId),
      getUserLang(instanceId, phone).catch(() => null),
      getSiteLanguageHint(instanceId, phone).catch(() => null),
      getChatHistory(instanceId, phone).catch(() => []),
      getActiveShiftNotes(instanceId).catch(() => []),
      hasMagicLinkBeenSent(instanceId, phone).catch(() => false),
    ]);

  const safeConfig = { ...(config || {}) };
  const languageCandidateText = String(input.languageCandidateText ?? text).trim();
  let language: "kk" | "ru" = storedLang || siteLanguageHint || "kk";
  let languageDetector: "redis_lock" | "gemini" | "fallback" | "site_hint" = storedLang ? "redis_lock" : siteLanguageHint ? "site_hint" : "fallback";
  let languageLocked = Boolean(storedLang);
  // The 24-hour language lock belongs to guests who arrived through the site:
  // the site already told us their language. A guest who wrote straight to
  // WhatsApp gets their language resolved again on every message instead.
  const siteOriginated = Boolean(siteLanguageHint);
  // A signal-free message ("👍", "ок", a bare number) keeps the language the
  // guest last actually used - see lastCustomerLanguage.
  const priorCustomerLanguage = lastCustomerLanguage(chatHistory);
  if (siteOriginated && storedLang && isLanguageBearingCustomerText(languageCandidateText)) {
    const decision = await detectLanguageDecision(languageCandidateText);
    const previousLanguage = priorCustomerLanguage;
    const decisiveNow = textCarriesDecisiveLanguageSignal(languageCandidateText, decision.language);
    if (decision.lockable && shouldSwitchLockedLanguage(storedLang, previousLanguage, decision.language, decisiveNow)) {
      const switched = await replaceUserLang(instanceId, phone, decision.language).catch(() => false);
      if (switched) {
        language = decision.language;
        languageDetector = decision.detector;
      }
    }
  } else if (siteOriginated && !storedLang && isLanguageBearingCustomerText(languageCandidateText)) {
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
  } else {
    const decision = isLanguageBearingCustomerText(languageCandidateText)
      ? await detectLanguageDecision(languageCandidateText)
      : null;
    const priorLanguage = storedLang || priorCustomerLanguage;
    const resolved = resolveOrganicLanguage({
      detected: decision?.lockable ? decision.language : null,
      priorLanguage,
      contactName: firstValue(
        input.senderMeta?.pushName,
        input.senderMeta?.contactName,
        input.senderMeta?.contactShortName,
        input.senderMeta?.contactPushName
      ),
      siteLanguageHint,
    });
    language = resolved.language;
    languageDetector =
      resolved.source === "message" ? (decision?.detector || "gemini")
      : resolved.source === "history" ? "redis_lock"
      : resolved.source === "site_hint" ? "site_hint"
      : "fallback";
    languageLocked = false;
  }
  const domain = normalizeMenuDomain(safeConfig.domain || "") || "";
  if (domain) safeConfig.domain = domain;

  // Long-term memory is read in the same parallel batch as the live lookups, so
  // it adds no measurable latency. Every read degrades to null on failure:
  // memory enriches the answer, it must never be able to block one.
  const [runtimeStatus, activeOrder, shporContext, customerProfile, conversationSummary, lastTurnTrace, activeGoal, liveMenu] =
    await Promise.all([
      getRuntimeStatus(instanceId, domain, { forceFresh: true }).catch(() => null),
      getOrderStatus(instanceId, phone, domain).catch(() => null),
      getShporContext(instanceId, text).catch(() => []),
      getCustomerProfile(instanceId, phone).catch(() => null),
      getConversationSummary(instanceId, phone).catch(() => null),
      getTurnTrace(instanceId, phone).catch(() => null),
      getActiveGoal(instanceId, phone).catch(() => null),
      getMenuContext(instanceId, domain, language).catch(() => null),
    ]);

  const menuSnapshot = buildMenuSnapshot(liveMenu);
  // runtime.status.get is the authoritative recovery snapshot. Webhooks and the
  // Redis copy keep the fast path, but a missed event or a bot deployment must
  // not leave the AI without the current shift notes for even one turn.
  const activeShiftNotes = Array.isArray(runtimeStatus?.shift_notes)
    ? runtimeStatus.shift_notes
    : cachedShiftNotes;
  const activeShiftNotesFingerprint = activeShiftNotes.length
    ? crypto.createHash("sha256").update(activeShiftNotes.map((note: any) => `${String(note?.text || "").trim()}|${Number(note?.expiresAt || 0) || 0}`).sort().join("\n")).digest("hex")
    : "";

  // The site calls the oldest unfinished order "active", but a guest who has
  // spent the whole chat asking about one order means that order when they say
  // "қашан келеді?". Pinning the discussed order here keeps the model and the
  // deterministic status route looking at the same one, so the bot never
  // answers about an order nobody mentioned.
  const discussedOrderNumber = lastDiscussedOrderNumber(chatHistory);
  const numberPinnedOrder = discussedOrderNumber ? pickConversationOrder(activeOrder, discussedOrderNumber) : null;
  // A dish the guest names right now outranks a number repeated from history:
  // if the bot once answered about the wrong order, the old number keeps
  // echoing back through its own replies, while "the one with the Caesar"
  // always points at what the person in front of us actually means.
  const mentionPinnedOrder = orderMentionedByItems(activeOrder, text);
  const discussedOrderRecord = mentionPinnedOrder || numberPinnedOrder;
  const focusedActiveOrder = discussedOrderRecord && activeOrder
    ? { ...activeOrder, order: discussedOrderRecord, active_order: discussedOrderRecord, order_id: discussedOrderRecord.id, status: discussedOrderRecord.status, items: discussedOrderRecord.items, total_price: discussedOrderRecord.total_price, address: discussedOrderRecord.address, comment: discussedOrderRecord.comment, is_pickup: discussedOrderRecord.is_pickup, ai_comment: discussedOrderRecord.ai_comment }
    : activeOrder;

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
    redis_available: redisAvailable,
  };
  // A furious "Я заказ сделал час назад, верните деньги" contains "заказ ... сдел",
  // so the link intent fired and the entire reply to a refund demand was a menu
  // link (live round, 2026-08-12). A complaint or a request for a human is never
  // an order intent: no link is issued on that turn, which also lets
  // finalValidator strip one if the model writes it anyway.
  const explicitMenuLinkIntent = hasExplicitMenuLinkIntent(text)
    && !isLikelyComplaintText(text)
    && !isLikelyOperatorRequestText(text);
  let magicLinkFailed = false;
  const magicLink = explicitMenuLinkIntent
    ? await issueCustomerAccessLink({
        instanceId,
        phone,
        locale: language,
        config: safeConfig,
      }).catch((error) => {
        // A silent null here once hid a rotated hub secret for days: the guest was
        // told the previous link still worked while no link had ever been issued.
        magicLinkFailed = true;
        console.warn(`[MAGIC LINK] issue failed instance=${instanceId} reason=${String(error?.message || error).slice(0, 200)}`);
        return null;
      })
    : null;

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
    activeOrder: focusedActiveOrder,
    chatHistory,
    menuSnapshot,
    activeShiftNotes,
    activeShiftNotesFingerprint,
    mediaContext: input.mediaContext || null,
    shporContext,
    magicLinkAlreadySent,
    customerProfile,
    conversationSummary,
    lastTurnTrace,
    activeGoal,
    thinking: null,
    proactiveSignals: null,
    explicitMenuLinkIntent,
    magicLink,
    magicLinkFailed,
    // The link is prepared, not promised. Only the sendMenuLink skill may flip
    // this to true, which is what lets the agent decide whether the guest
    // actually needs the URL on this turn.
    magicLinkGranted: false,
  };
}
