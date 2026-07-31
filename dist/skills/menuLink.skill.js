import { createTool } from "@voltagent/core";
import { z } from "zod";
import { markKitchenCheckoutStarted, markMagicLinkSent } from "../services/redis.service.js";
import { classifyKitchenSalesPolicy } from "../services/kitchenPolicy.service.js";
export function createSendMenuLinkSkill(ctx) {
    return createTool({
        name: "sendMenuLink",
        description: "Generate and return the customer's personal authenticated menu link. MUST be called when the customer wants to order, see the menu, browse items, or asks for a link. If the link was already sent but the customer explicitly asks to order/menu/link again, call this tool anyway and resend the link. After calling, include the returned 'link' value in your response text.",
        parameters: z.object({
            reason: z.string().describe("Why the link is being sent"),
        }),
        execute: async ({ reason }) => {
            const hasActiveOrder = Boolean(ctx.activeOrder);
            const runtimeAvailable = Boolean(ctx.hardRealtimeContext?.runtime_available);
            const allowed = (!ctx.magicLinkAlreadySent || ctx.explicitMenuLinkIntent) && (runtimeAvailable || hasActiveOrder);
            if (!allowed || !ctx.magicLink) {
                return {
                    allowed: false,
                    link: null,
                    reason: !runtimeAvailable && !hasActiveOrder ? "runtime_unavailable" : "link_already_sent",
                    message: !runtimeAvailable && !hasActiveOrder
                        ? (ctx.language === "kk" ? "Ас үйдің ағымдағы күйін тексере алмадым, сондықтан жаңа тапсырысты қазір бастай алмаймын. Сәлден кейін қайта көріңіз." : "Не удалось проверить текущее состояние кухни, поэтому сейчас нельзя начать новый заказ. Попробуйте немного позже.")
                        : (ctx.language === "kk" ? "Алдыңғы сілтемемен тапсырыс бере аласыз." : "Можете оформить заказ по предыдущей ссылке."),
                };
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
