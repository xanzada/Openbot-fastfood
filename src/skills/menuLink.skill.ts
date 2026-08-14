import { createTool } from "@voltagent/core";
import { z } from "zod";
import {
  getKitchenCheckoutFingerprint,
  markKitchenCheckoutStarted,
  markMagicLinkSent,
} from "../services/redis.service.js";
import { classifyKitchenSalesPolicy, type KitchenSalesPolicy } from "../services/kitchenPolicy.service.js";
import type { FastFoodContext } from "../context/types.js";

// No calendar limit on resends (product decision, 2026-08-14): the agent
// itself decides when the guest truly needs the link - asked for it, reported
// the previous one broken, or plainly cannot proceed without it. Spam is
// prevented structurally: the transport appends the URL at most once per reply
// and the validator strips any link this skill did not grant this turn.

/**
 * Why the link is being withheld. Three different situations used to share one
 * answer: telling a guest whose link could not be issued that "the previous one
 * still works" leaves them waiting for a message that will never arrive, and it
 * hid a rotated hub secret for days. Kept pure so it can be tested without
 * booting the agent.
 */
export function classifyMenuLinkRefusal(
  ctx: Pick<FastFoodContext, "explicitMenuLinkIntent" | "magicLink" | "magicLinkFailed" | "magicLinkAlreadySent" | "activeOrder" | "hardRealtimeContext">,
  policy?: KitchenSalesPolicy | null,
  consentAccepted = false,
) {
  const hasActiveOrder = Boolean(ctx.activeOrder);
  const runtimeAvailable = Boolean(ctx.hardRealtimeContext?.runtime_available);
  const allowed = Boolean(ctx.explicitMenuLinkIntent) && (runtimeAvailable || hasActiveOrder) && Boolean(ctx.magicLink);
  if (allowed) {
    // The kitchen gate asks about a long wait before an order starts, but a guest
    // who answers it by asking for the link instead walked straight past it: the
    // link went out and marking the checkout as started silenced the gate for
    // good, so the wait was never mentioned again (audit, 2026-08-12). A closed
    // kitchen must not hand out a checkout link at all.
    if (policy?.blocksAllSales) return "kitchen_closed" as const;
    if (policy?.requiresConsent && !consentAccepted) return "wait_consent_required" as const;
    return null;
  }
  if (!runtimeAvailable && !hasActiveOrder) return "runtime_unavailable" as const;
  if (ctx.magicLinkFailed) return "link_issue_failed" as const;
  if (Boolean(ctx.explicitMenuLinkIntent) && !ctx.magicLink) return "link_issue_failed" as const;
  // The tool was called on a turn with no link need in the message at all:
  // answer the actual question and leave the URL out.
  return "link_not_needed" as const;
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
      ? `Тапсырыс көп, дайындалуы шамамен ${label || "ұзақ"} болады. Күте аласыз ба? «Иә» десеңіз, сілтемені бірден жіберемін.`
      : `Заказов много, приготовление займёт примерно ${label || "дольше обычного"}. Сможете подождать? Скажите «да» — сразу отправлю ссылку.`;
  }
  if (reason === "link_issue_failed") {
    return kk
      ? "Сілтемені дайындай алмадым, техникалық ақаулық болды. Бірер минуттан кейін қайта сұраңыз."
      : "Не удалось подготовить ссылку из-за технической ошибки. Попросите её ещё раз через пару минут.";
  }
  // link_not_needed: no guest-facing wording at all - the model answers the
  // actual question and simply leaves the URL out.
  return null;
}

export function createSendMenuLinkSkill(ctx: FastFoodContext) {
  return createTool({
    name: "sendMenuLink",
    description: "Return the guest's personal ordering link ONLY when it is genuinely needed right now: the guest asks to order, to see the menu/catalog/cart, asks for the link, reports the previous link broken, or you can tell the conversation cannot move forward without it. Plain questions (prices, dishes, hours, delivery) are answered with searchMenu/getBusinessInfo - never with a link. There is NO daily or per-conversation limit: whenever the guest truly needs the link again, call this tool again and a fresh one is issued - deciding when it is truly needed is your job, rationing is not. If the guest says the earlier link does not open or expired, set previousLinkBroken=true. The link is tied to the guest's phone and stays valid for a month; never mention validity unless the guest asks. Never paste the URL into your text yourself - the system appends it at most once per reply.",
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
      const policy = classifyKitchenSalesPolicy(ctx.runtimeStatus);
      const acceptedFingerprint = await getKitchenCheckoutFingerprint(ctx.instanceId, ctx.phone).catch(() => null);
      const refusal = classifyMenuLinkRefusal(ctx, policy, acceptedFingerprint === policy.fingerprint);
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
        validity: "1 month",
      };
    },
  });
}
