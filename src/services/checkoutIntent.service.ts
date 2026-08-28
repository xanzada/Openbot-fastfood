import type { FastFoodContext } from "../context/types.js";
import { issueCustomerAccessLink, upsertCustomerLead } from "./alemiApi.service.js";
import { isLikelyComplaintText, isLikelyOperatorRequestText } from "./complaintRouting.service.js";
import { hasExplicitMenuLinkIntent } from "../utils/magicLink.js";

type CheckoutIntentDeps = {
  issueAccessLink?: typeof issueCustomerAccessLink;
  upsertLead?: typeof upsertCustomerLead;
};

/**
 * Mint the guest's ordering link, with no opinion about whether they deserve one.
 *
 * The judgment call belongs to the agent. This function exists so the keyword
 * pre-warm below and the sendMenuLink skill share ONE issuing path: the skill used
 * to find ctx.magicLink === null whenever the guest's phrasing missed the regex, and
 * a tool that cannot produce a link answers "link_not_needed" with no message - so
 * the model said "мәзірді жіберемін" and nothing was ever sent (owner report,
 * 2026-08-28: "меню жіберемін деп айтады, жібермейді").
 *
 * Idempotent per turn: an already-issued link is returned as-is, and a failure is
 * remembered in ctx so the skill can tell an outage from a decision.
 */
export async function ensureCustomerAccessLink(
  ctx: FastFoodContext,
  deps: CheckoutIntentDeps = {},
): Promise<string | null> {
  if (ctx.magicLink) return ctx.magicLink;
  // A failure already recorded this turn is not retried: the hub is either down or
  // refusing this tenant's secret, and a second call only adds latency the guest waits for.
  if (ctx.magicLinkFailed) return null;

  const issueAccessLink = deps.issueAccessLink || issueCustomerAccessLink;
  const upsertLead = deps.upsertLead || upsertCustomerLead;
  try {
    const link = await issueAccessLink({
      instanceId: ctx.instanceId,
      phone: ctx.phone,
      locale: ctx.language,
      config: ctx.config,
    });
    ctx.magicLink = link;
    ctx.magicLinkFailed = !link;
    if (!link) return null;
    // The hub must know the guest's number the moment an ordering link exists.
    // Fire-and-forget: CRM bookkeeping never delays the guest's reply.
    void upsertLead({ instanceId: ctx.instanceId, phone: ctx.phone, config: ctx.config }).catch(() => false);
    return link;
  } catch (error: any) {
    ctx.magicLink = null;
    ctx.magicLinkFailed = true;
    console.warn(`[MAGIC LINK] issue failed instance=${ctx.instanceId} reason=${String(error?.message || error).slice(0, 200)}`);
    return null;
  }
}

/**
 * Rehydrates checkout state when the real customer text appears after preload
 * (most importantly after a voice note is transcribed).
 *
 * This is a LATENCY optimisation, not a permission check: when the wording is
 * unmistakable the link is minted before the agent starts, so the reply does not wait
 * on a hub round-trip. A miss here costs nothing - the sendMenuLink skill mints on
 * demand through the same path.
 */
export async function refreshCheckoutContextForText(
  ctx: FastFoodContext,
  text: string,
  deps: CheckoutIntentDeps = {},
): Promise<boolean> {
  const value = String(text || "").trim();
  const explicit = hasExplicitMenuLinkIntent(value)
    && !isLikelyComplaintText(value)
    && !isLikelyOperatorRequestText(value);
  if (!explicit) return false;

  ctx.explicitMenuLinkIntent = true;
  return Boolean(await ensureCustomerAccessLink(ctx, deps));
}

