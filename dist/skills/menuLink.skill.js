import { createTool } from "@voltagent/core";
import { z } from "zod";
import { markKitchenCheckoutStarted, markMagicLinkSent } from "../services/redis.service.js";
import { classifyKitchenSalesPolicy } from "../services/kitchenPolicy.service.js";
/**
 * Why the link is being withheld. Three different situations used to share one
 * answer: telling a guest whose link could not be issued that "the previous one
 * still works" leaves them waiting for a message that will never arrive, and it
 * hid a rotated hub secret for days. Kept pure so it can be tested without
 * booting the agent.
 */
export function classifyMenuLinkRefusal(ctx) {
    const hasActiveOrder = Boolean(ctx.activeOrder);
    const runtimeAvailable = Boolean(ctx.hardRealtimeContext?.runtime_available);
    const allowed = Boolean(ctx.explicitMenuLinkIntent) && (runtimeAvailable || hasActiveOrder) && Boolean(ctx.magicLink);
    if (allowed)
        return null;
    if (!runtimeAvailable && !hasActiveOrder)
        return "runtime_unavailable";
    if (ctx.magicLinkFailed)
        return "link_issue_failed";
    if (Boolean(ctx.explicitMenuLinkIntent) && !ctx.magicLink && !ctx.magicLinkAlreadySent)
        return "link_issue_failed";
    return "link_already_sent";
}
function refusalMessage(reason, language) {
    const kk = language === "kk";
    if (reason === "runtime_unavailable") {
        return kk
            ? "Ас үйдің ағымдағы күйін тексере алмадым, сондықтан жаңа тапсырысты қазір бастай алмаймын. Сәлден кейін қайта көріңіз."
            : "Не удалось проверить текущее состояние кухни, поэтому сейчас нельзя начать новый заказ. Попробуйте немного позже.";
    }
    if (reason === "link_issue_failed") {
        return kk
            ? "Сілтемені дайындай алмадым, техникалық ақаулық болды. Бірер минуттан кейін қайта сұраңыз."
            : "Не удалось подготовить ссылку из-за технической ошибки. Попросите её ещё раз через пару минут.";
    }
    return kk ? "Алдыңғы сілтемемен тапсырыс бере аласыз." : "Можете оформить заказ по предыдущей ссылке.";
}
export function createSendMenuLinkSkill(ctx) {
    return createTool({
        name: "sendMenuLink",
        description: "Return the personal menu link only when the newest customer message explicitly asks to order, open the menu/catalog/cart, or receive/resend that link. A photo, feedback, joke, complaint, or an incidental word such as 'send' is not sufficient intent.",
        parameters: z.object({
            reason: z.string().describe("Why the link is being sent"),
        }),
        execute: async () => {
            const refusal = classifyMenuLinkRefusal(ctx);
            if (refusal) {
                return { allowed: false, link: null, reason: refusal, message: refusalMessage(refusal, ctx.language) };
            }
            await markMagicLinkSent(ctx.instanceId, ctx.phone).catch(() => false);
            // Remember the kitchen as it is right now. If it changes while the guest is
            // choosing, the gate reopens and tells them; if nothing changed, they are
            // left alone to finish the order.
            const policyAtLinkTime = classifyKitchenSalesPolicy(ctx.runtimeStatus);
            await markKitchenCheckoutStarted(ctx.instanceId, ctx.phone, policyAtLinkTime.fingerprint).catch(() => false);
            return {
                allowed: true,
                link: ctx.magicLink,
                message: null,
                validity: "1 month",
            };
        },
    });
}
