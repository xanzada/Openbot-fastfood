import type { FastFoodContext } from "../context/types.js";
import { classifyKitchenSalesPolicyForContext } from "../services/kitchenPolicy.service.js";
import { getKitchenCheckoutFingerprint, markKitchenCheckoutStarted, markMagicLinkSent } from "../services/redis.service.js";
import { ensureCustomerAccessLink } from "../services/checkoutIntent.service.js";

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
const LINK_PROMISE_RE =
  /(сілтемені?\s*(?:қазір\s*)?(?:жіберемін|жібердім|жіберіп\s*жатырмын|беремін)|мәзірді?\s*(?:қазір\s*)?(?:жіберемін|жібердім|жіберіп\s*жатырмын|беремін)|мәзір\s*жібер(?:емін|дім)|(?:қазір|дереу)\s*жіберемін|(?:отправ(?:лю|ляю|ил|ила)|скин(?:у|ул)|пришл[юё]|высыла ю|высылаю|высл(?:ал|ала))\s*(?:вам\s*)?(?:сейчас\s*)?(?:ссылк\p{L}*|мен[юь]|каталог)|(?:ссылк\p{L}*|мен[юь])\s*(?:уже\s*)?(?:отправ(?:лю|ил|ила|лена)|скин(?:у|ул)|пришл[юё]))/iu;

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
