import { createTool } from "@voltagent/core";
import { z } from "zod";
import {
  getKitchenCheckoutFingerprint,
  markKitchenCheckoutStarted,
  markMagicLinkSent,
} from "../services/redis.service.js";
import { classifyKitchenSalesPolicyForContext, type KitchenSalesPolicy } from "../services/kitchenPolicy.service.js";
import { ensureCustomerAccessLink } from "../services/checkoutIntent.service.js";
import type { FastFoodContext } from "../context/types.js";

// No calendar limit on resends (product decision, 2026-08-14): the agent
// itself decides when the guest truly needs the link - asked for it, reported
// the previous one broken, or plainly cannot proceed without it. Spam is
// prevented structurally: the transport appends the URL at most once per reply
// and the validator strips any link this skill did not grant this turn.

/**
 * Why the link is being withheld — and the answer is now ALWAYS an operational
 * reason, never "you did not say the magic word".
 *
 * The agent calling this tool IS the intent signal. Requiring a keyword regex
 * (explicitMenuLinkIntent) to have fired first meant the model decided the guest
 * wanted to order, said so out loud, and then the tool refused with reason
 * "link_not_needed" whose message is null - so the reply promised a menu and nothing
 * was ever delivered. "2 донер жасап қойшы" is the plainest possible order and
 * matched no pattern (owner report, 2026-08-28).
 *
 * What remains here are facts about the restaurant, which the model cannot see and
 * must not overrule: a closed kitchen, an unconfirmed long wait, an unreachable hub.
 * Kept pure so it can be tested without booting the agent.
 */
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
  if (policy?.blocksAllSales) return "kitchen_closed" as const;
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
      ? "Қазір тапсырыс қабылдамаймыз, сондықтан сілтемені жіберудің мәні жоқ. Ашылған кезде жазыңыз, бәрін рәсімдеймін."
      : "Сейчас заказы не принимаем, поэтому ссылку отправлять смысла нет. Напишите, когда откроемся, и я всё оформлю.";
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
    description: "Return the guest's personal ordering link. Call it the moment YOU judge the guest is moving to order or wants to browse the catalog - they name dishes or quantities ('2 донер жасап қойшы'), ask to order, ask for the menu/cart/link, report the previous link broken, or the conversation plainly cannot move forward without it. You are the judgment here: there is no keyword list, and the tool no longer second-guesses whether the guest 'really' asked. It only refuses for reasons about the restaurant - kitchen closed, an unconfirmed long wait, or a technical failure issuing the link - and each of those comes back with a message to relay. Plain questions (prices, dishes, hours, delivery) are answered with searchMenu/getBusinessInfo first; the link may follow in the same reply if they are ordering. There is NO daily or per-conversation limit. If the guest says the earlier link does not open or expired, set previousLinkBroken=true. The link is tied to the guest's phone and stays valid for a month; never mention validity unless asked. Never paste the URL into your text yourself - the system delivers it as its own separate message right after your reply. NEVER say you are sending the menu unless this tool returned allowed=true.",
    parameters: z.object({
      reason: z.string().describe("Why the link is being sent"),
      previousLinkBroken: z
        .boolean()
        .optional()
        .describe("True only when the guest says the earlier link does not work, expired, or was deleted"),
    }),
    execute: async ({ previousLinkBroken }: { previousLinkBroken?: boolean }) => {
      // previousLinkBroken stays in the schema so the model can flag a broken
      // report; it no longer gates anything, because every genuine request now
      // takes the normal grant path (no calendar rationing, 2026-08-14).
      void previousLinkBroken;
      // Calling this tool IS the decision that the guest is ordering. Recording it
      // keeps the rest of the turn consistent: finalValidator uses the same flag to
      // decide whether a URL in the text was authorised, and it used to strip the
      // link the tool had just granted whenever the keyword regex had not fired.
      ctx.explicitMenuLinkIntent = true;
      const policy = classifyKitchenSalesPolicyForContext(ctx.runtimeStatus, ctx.activeShiftNotes);
      const acceptedFingerprint = await getKitchenCheckoutFingerprint(ctx.instanceId, ctx.phone).catch(() => null);
      const consentAccepted = acceptedFingerprint === policy.fingerprint;
      // Mint on demand. preloadContext only pre-warms the link when the wording is
      // unmistakable, so on every other order the tool used to find null here and
      // report "not needed" - the reply promised a menu that never arrived.
      if (!ctx.magicLink && !policy.blocksAllSales && (!policy.requiresConsent || consentAccepted)) {
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
        note: "The link is delivered to the guest as its own separate message right after your reply - never paste the URL into your text, and never say orders cannot be accepted or links are down: the link IS working.",
        validity: "1 month",
      };
    },
  });
}
