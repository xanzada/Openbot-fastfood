import type { FastFoodContext } from "../context/types.js";
import { classifyKitchenSalesPolicyForContext } from "../services/kitchenPolicy.service.js";
import { getKitchenCheckoutFingerprint, markKitchenCheckoutStarted, markMagicLinkSent } from "../services/redis.service.js";
import { ensureCustomerAccessLink } from "../services/checkoutIntent.service.js";
import { isLikelyComplaintText, isLikelyOperatorRequestText } from "../services/complaintRouting.service.js";
import { linkInLastBotReply } from "../utils/linkRecency.js";

/**
 * "Мәзірді жіберемін" with no link behind it.
 *
 * The single complaint the owner reported on 2026-08-28: the bot says it is sending
 * the menu and nothing arrives. The model is not lying on purpose - it decided
 * correctly that the guest wants to order, wrote the natural sentence, and then either
 * skipped the tool or the tool refused for a reason the model did not relay. Either
 * way the guest is left waiting for a message that never comes, which reads as a
 * broken bot and ends the order.
 *
 * So a promise is treated as a commitment: if the restaurant can sell right now, the
 * link is issued and delivered, and the sentence becomes true. Only when the
 * restaurant genuinely cannot sell is the sentence removed.
 */
const LINK_PROMISE_RE = new RegExp([
  // «Мәзірді жіберемін», «Сілтемені қазір жіберемін», «Отправлю ссылку», «Ссылку скину»
  String.raw`сілтемені?\s*(?:қазір\s*)?(?:жіберемін|жібердім|жіберіп\s*жатырмын|беремін)`,
  String.raw`мәзірді?\s*(?:қазір\s*)?(?:жіберемін|жібердім|жіберіп\s*жатырмын|беремін)`,
  String.raw`мәзір\s*жібер(?:емін|дім)`,
  String.raw`(?:қазір|дереу)\s*жіберемін`,
  String.raw`(?:отправ(?:лю|ляю|ил|ила)|скин(?:у|ул)|пришл[юё]|высылаю|высл(?:ал|ала))\s*(?:вам\s*)?(?:сейчас\s*)?(?:ссылк\p{L}*|мен[юь]|каталог)`,
  String.raw`(?:ссылк\p{L}*|мен[юь])\s*(?:уже\s*)?(?:отправ(?:лю|ил|ила|лена)|скин(?:у|ул)|пришл[юё])`,
  // Pointing at the link as if it is right there (2026-10-04, «Төмендегі сілтеме
  // арқылы пицца мен донерді таңдап…» with nothing below it).
  String.raw`төмендегі\s+(?:\p{L}+\s+)?сілтеме`,
  String.raw`сілтеме(?:міз|ні)?\s+арқылы`,
  String.raw`сілтемеден`,
  String.raw`сілтемеге\s+(?:кіріп|өтіп|басып)`,
  String.raw`сілтемені\s+(?:басып|ашып)`,
  String.raw`мәзір\s+сілтемесі`,
  String.raw`ссылк\p{L}*\s+ниже`,
  String.raw`ниже\s+(?:по\s+)?ссылк`,
  String.raw`по\s+ссылке`,
  String.raw`ссылк\p{L}*\s+(?:придёт|придет|будет)\s+(?:ниже|следующим)`,
].map((part) => `(?:${part})`).join("|"), "iu");

export function promisesMenuLink(text: string) {
  return LINK_PROMISE_RE.test(String(text || ""));
}

export function stripMenuLinkPromise(text: string) {
  return String(text || "")
    .split(/(?<=[.!?\u2026])\s+|\n+/)
    .filter((sentence) => sentence.trim() && !LINK_PROMISE_RE.test(sentence))
    .join(" ")
    .replace(/\s{2,}/g, " ")
    .trim();
}

export type LinkPromiseOutcome =
  | { action: "none" }
  | { action: "granted" }
  | { action: "stripped"; text: string; reason: string };

/**
 * Make the reply and reality agree, preferring to keep the promise.
 *
 * Called after validation, so it sees the text the guest would actually receive.
 * Never throws: a failure here must not cost the guest their answer.
 */
export async function honorMenuLinkPromise(ctx: FastFoodContext, finalText: string): Promise<LinkPromiseOutcome> {
  if (!promisesMenuLink(finalText)) return { action: "none" };
  // The tool already granted it - the transport will deliver, nothing to fix.
  if (ctx.magicLinkGranted && ctx.magicLink) return { action: "none" };
  // A complaint or a request for a human is never an order: drop the sentence.
  const guestText = String(ctx.text || "");
  if (guestText && (isLikelyComplaintText(guestText) || isLikelyOperatorRequestText(guestText))) {
    return { action: "stripped", text: stripMenuLinkPromise(finalText), reason: "not_an_order_turn" };
  }
  // A generic follow-up must not resend the link the bot JUST sent. "Just" is
  // the previous bot reply, not a 30-day flag: a link from two days ago is long
  // scrolled away and «төмендегі сілтеме» must really be below (2026-10-04).
  // An explicit request still passes because preload marks that intent, and if
  // dropping the sentence would leave nothing to say, the promise is kept.
  if (!ctx.explicitMenuLinkIntent && linkInLastBotReply(ctx.chatHistory)) {
    const kept = stripMenuLinkPromise(finalText);
    if (kept) return { action: "stripped", text: kept, reason: "link_already_sent" };
  }

  const policy = classifyKitchenSalesPolicyForContext(ctx.runtimeStatus, ctx.activeShiftNotes);
  const runtimeAvailable = Boolean(ctx.hardRealtimeContext?.runtime_available);
  const hasActiveOrder = Boolean(ctx.activeOrder);
  const acceptedFingerprint = await getKitchenCheckoutFingerprint(ctx.instanceId, ctx.phone).catch(() => null);
  const consentAccepted = acceptedFingerprint === policy.fingerprint;

  // The same operational gates the skill applies, in the same order - a promise must
  // never smuggle a link past a closed kitchen or an unanswered wait consent.
  const blocked = (!runtimeAvailable && !hasActiveOrder)
    ? "runtime_unavailable"
    : policy.blocksAllSales
      ? "kitchen_closed"
      : (policy.requiresConsent && !consentAccepted)
        ? "wait_consent_required"
        : "";

  if (!blocked) {
    const link = await ensureCustomerAccessLink(ctx).catch(() => null);
    if (link) {
      ctx.explicitMenuLinkIntent = true;
      ctx.magicLinkGranted = true;
      await markMagicLinkSent(ctx.instanceId, ctx.phone).catch(() => false);
      await markKitchenCheckoutStarted(ctx.instanceId, ctx.phone, policy.fingerprint).catch(() => false);
      return { action: "granted" };
    }
  }

  return {
    action: "stripped",
    text: stripMenuLinkPromise(finalText),
    reason: blocked || "link_issue_failed",
  };
}
