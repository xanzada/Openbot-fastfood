import { activeOrderQuestionKind, hasDirectOrderIntent, hasCustomerCheckoutIntent, currentGroundedCatalogCheckoutDecision } from "../utils/orderIntent.js";
import { isBroadMenuCategoryBrowse } from "../utils/menuQuestionContext.js";
import { isPotentialUnseenCatalogRequest } from "../agent/toolPolicy.js";
import { menuLinkDecisionForTurn } from "../utils/magicLink.js";
import { isCurrentPaymentDetailsIntent } from "../utils/paymentIntent.js";
import { complaintHasActionableDetail, isCurrentComplaintRequest, isExplicitCourierContactRequest, isExplicitHumanOperatorRequest, isLikelyComplaintText } from "../services/complaintRouting.service.js";
export { hasDirectOrderIntent } from "../utils/orderIntent.js";

import { createTool } from "@voltagent/core";
import { z } from "zod";
import {
  getKitchenCheckoutFingerprint,
  markKitchenCheckoutStarted,
  markMagicLinkSent,
} from "../services/redis.service.js";
import { classifyKitchenSalesPolicyForContext, detectKitchenConsentAnswer, type KitchenSalesPolicy } from "../services/kitchenPolicy.service.js";
import { ensureCustomerAccessLink } from "../services/checkoutIntent.service.js";
import type { FastFoodContext } from "../context/types.js";

// No calendar limit on resends (product decision, 2026-08-14): the agent
// itself decides when the guest truly needs the link - asked for it, reported
// the previous one broken, or plainly cannot proceed without it. Spam is
// prevented structurally: the transport appends the URL at most once per reply
// and the validator strips any link this skill did not grant this turn.

/** Restaurant gates supplement the customer's actual checkout/link request. */
export function classifyMenuLinkRefusal(
  ctx: Pick<FastFoodContext, "explicitMenuLinkIntent" | "magicLink" | "magicLinkFailed" | "magicLinkAlreadySent" | "activeOrder" | "hardRealtimeContext">,
  policy?: KitchenSalesPolicy | null,
  consentAccepted = false,
) {
  const hasActiveOrder = Boolean(ctx.activeOrder);
  const runtimeAvailable = Boolean(ctx.hardRealtimeContext?.runtime_available);
  // Order of the gates is the order of the guest's reality: is the kitchen even
  // selling, has a promised delay been accepted, and did the link actually mint.
  if (!runtimeAvailable && !hasActiveOrder) return "runtime_unavailable" as const;
  if (policy?.blocksAllSales && policy.mode !== "off_hours") return "kitchen_closed" as const;
  if (policy?.requiresConsent && !consentAccepted) return "wait_consent_required" as const;
  // Reached only when the restaurant is genuinely ready to sell: no link here means
  // issuing it failed, and the guest is told exactly that instead of silence.
  if (!ctx.magicLink) return "link_issue_failed" as const;
  return null;
}

function refusalMessage(reason: ReturnType<typeof classifyMenuLinkRefusal>, language: string, policy?: KitchenSalesPolicy | null) {
  const kk = language === "kk";
  if (reason === "runtime_unavailable") {
    return kk
      ? "Ас үйдің ағымдағы күйін тексере алмадым, сондықтан жаңа тапсырысты қазір бастай алмаймын. Сәлден кейін қайта көріңіз."
      : "Не удалось проверить текущее состояние кухни, поэтому сейчас нельзя начать новый заказ. Попробуйте немного позже.";
  }
  if (reason === "kitchen_closed") {
    return kk
      ? "Қазір тапсырыс қабылдамаймыз, сондықтан сілтемені жіберудің мәні жоқ. Ашылған кезде сайт арқылы тапсырыс бере аласыз."
      : "Сейчас заказы не принимаем, поэтому ссылку отправлять смысла нет. Когда откроемся, сможете оформить заказ на сайте.";
  }
  if (reason === "wait_consent_required") {
    const label = kk ? policy?.waitLabelKk : policy?.waitLabelRu;
    return kk
      ? `Тапсырыс көп, дайындалуы шамамен ${label || "ұзақ"} болады. Күте аласыз ба? «Иә» десеңіз, мәзірді бірден жіберемін.`
      : `Заказов много, приготовление займёт примерно ${label || "дольше обычного"}. Сможете подождать? Скажите «да» — сразу отправлю меню.`;
  }
  if (reason === "link_issue_failed") {
    return kk
      ? "Сілтемені дайындай алмадым, техникалық ақаулық болды. Бірер минуттан кейін қайта сұраңыз."
      : "Не удалось подготовить ссылку из-за технической ошибки. Попросите её ещё раз через пару минут.";
  }
  return null;
}

export function createSendMenuLinkSkill(ctx: FastFoodContext) {
  return createTool({
    name: "sendMenuLink",
    description: "Return the guest's personal ordering link. Call it the moment YOU judge the guest is moving to order or wants to browse the catalog - they name dishes or quantities ('2 донер жасап қойшы'), ask to order, ask for the menu/cart/link, report the previous link broken, or the conversation plainly cannot move forward without it. The customer must actually request ordering, menu browsing, a link or resend; your reason or flags alone cannot authorize a link. It only refuses for reasons about the restaurant - kitchen closed, an unconfirmed long wait, or a technical failure issuing the link - and each of those comes back with a message to relay. Plain questions (prices, dishes, hours, delivery) are answered with searchMenu/getBusinessInfo first; the link may follow in the same reply if they are ordering. There is NO daily or per-conversation limit. If the guest says the earlier link does not open or expired, set previousLinkBroken=true. The link is tied to the guest's phone and stays valid for a month; never mention validity unless asked. Never paste the URL into your text yourself - the system delivers it as its own separate message right after your reply. NEVER say you are sending the menu unless this tool returned allowed=true.",
    parameters: z.object({
      reason: z.string().describe("Why the link is being sent"),
      guestAskedToResend: z
        .boolean()
        .optional()
        .describe("True when the guest asks, in ANY wording, to send/duplicate/show the link again (кері жібер, қайта жібер, тағы жіберші, скинь ещё раз, повтори ссылку, не вижу ссылку). Never true when they did not ask for it."),
      previousLinkBroken: z
        .boolean()
        .optional()
        .describe("True only when the guest says the earlier link does not work, expired, or was deleted"),
    }),
    execute: async ({ previousLinkBroken, guestAskedToResend }: { previousLinkBroken?: boolean; guestAskedToResend?: boolean }) => {
      // previousLinkBroken stays in the schema so the model can flag a broken
      // report; it no longer gates anything, because every genuine request now
      // takes the normal grant path (no calendar rationing, 2026-08-14).
      const text = String(ctx.text || "");
      const policy = classifyKitchenSalesPolicyForContext(ctx.runtimeStatus, ctx.activeShiftNotes);
      const acceptedFingerprint = await getKitchenCheckoutFingerprint(ctx.instanceId, ctx.phone).catch(() => null);
      const consentAccepted = acceptedFingerprint === policy.fingerprint;
      const consentContinuation = consentAccepted && ctx.explicitMenuLinkIntent && detectKitchenConsentAnswer(text) === "yes";
      const immediateServiceIncident = isExplicitHumanOperatorRequest(text) || isExplicitCourierContactRequest(text)
        || isCurrentComplaintRequest(text) || isLikelyComplaintText(text) && complaintHasActionableDetail(text);
      // Keep the skill's authorization identical to the planner: a grounded
      // category consultation is a request to browse the self-ordering menu.
      const menuLinkDecision = menuLinkDecisionForTurn(text);
      const paymentDetailsIntent = isCurrentPaymentDetailsIntent(text, activeOrderQuestionKind(text, ctx.activeOrder));
      const categoryConsultation = menuLinkDecision !== "deny" && menuLinkDecision !== "text_only" && !immediateServiceIncident && !paymentDetailsIntent && isBroadMenuCategoryBrowse(ctx);
      const groundedCheckoutDecision = currentGroundedCatalogCheckoutDecision(ctx);
      const pendingCatalogGrounding = !ctx.menuGrounding
        && isPotentialUnseenCatalogRequest(text)
        && hasCustomerCheckoutIntent(text);
      const checkoutIntent = pendingCatalogGrounding
        ? false
        : groundedCheckoutDecision ?? hasCustomerCheckoutIntent(text);
      if (immediateServiceIncident || paymentDetailsIntent || menuLinkDecision === "deny"
        || !checkoutIntent && !consentContinuation && !categoryConsultation) {
        ctx.magicLinkGranted = false;
        return { allowed: false, link: null, reason: "link_not_requested", message: null,
          note: "Answer the customer's question. No current checkout/link request exists; do not promise or point to a link." };
      }
      ctx.explicitMenuLinkIntent = true;
      // Mint on demand. preloadContext only pre-warms the link when the wording is
      // unmistakable, so on every other order the tool used to find null here and
      // report "not needed" - the reply promised a menu that never arrived.
      if (!ctx.magicLink && (!policy.blocksAllSales || policy.mode === "off_hours") && (!policy.requiresConsent || consentAccepted)) {
        await ensureCustomerAccessLink(ctx).catch(() => null);
      }
      const refusal = classifyMenuLinkRefusal(ctx, policy, consentAccepted);
      if (refusal) {
        return { allowed: false, link: null, reason: refusal, message: refusalMessage(refusal, ctx.language, policy) };
      }
      await markMagicLinkSent(ctx.instanceId, ctx.phone).catch(() => false);
      // Remember the kitchen as it is right now. If it changes while the guest is
      // choosing, the gate reopens and tells them; if nothing changed, they are
      // left alone to finish the order.
      await markKitchenCheckoutStarted(ctx.instanceId, ctx.phone, policy.fingerprint).catch(() => false);
      // The only place that authorises the URL to leave the bot. The transport
      // appends it to whatever the agent wrote instead of replacing the answer.
      ctx.magicLinkGranted = true;
      return {
        allowed: true,
        link: ctx.magicLink,
        message: null,
        note: policy.mode === "off_hours"
          ? "The kitchen is currently in off_hours (outside operating hours). The link is granted for catalog and menu browsing. Politely inform the customer that they can view dishes and prices now, and orders will be accepted when the restaurant opens."
          : "The link is delivered to the guest as its own separate message right after your reply - never paste the URL into your text, and never say orders cannot be accepted or links are down: the link IS working.",
        validity: "1 month",
      };
    },
  });
}
