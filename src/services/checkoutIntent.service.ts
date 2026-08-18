import type { FastFoodContext } from "../context/types.js";
import { issueCustomerAccessLink, upsertCustomerLead } from "./alemiApi.service.js";
import { isLikelyComplaintText, isLikelyOperatorRequestText } from "./complaintRouting.service.js";
import { hasExplicitMenuLinkIntent } from "../utils/magicLink.js";

type CheckoutIntentDeps = {
  issueAccessLink?: typeof issueCustomerAccessLink;
  upsertLead?: typeof upsertCustomerLead;
};

/**
 * Rehydrates checkout state when the real customer text appears after preload
 * (most importantly after a voice note is transcribed). The model never owns
 * this decision: order intent deterministically prepares the tenant-scoped,
 * phone-bound Hub link before any agent step can run.
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
  if (ctx.magicLink) return true;

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
    if (!link) return false;
    void upsertLead({ instanceId: ctx.instanceId, phone: ctx.phone, config: ctx.config }).catch(() => false);
    return true;
  } catch (error: any) {
    ctx.magicLink = null;
    ctx.magicLinkFailed = true;
    console.warn(`[MAGIC LINK] transcript refresh failed instance=${ctx.instanceId} reason=${String(error?.message || error).slice(0, 200)}`);
    return false;
  }
}

