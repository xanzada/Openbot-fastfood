import { createTool } from "@voltagent/core";
import { z } from "zod";
import { markMagicLinkSent } from "../services/redis.service.js";
export function createSendMenuLinkSkill(ctx) {
    return createTool({
        name: "sendMenuLink",
        description: "Generate and return the customer's personal authenticated menu link. MUST be called when the customer wants to order, see the menu, browse items, or asks for a link. If the link was already sent but the customer explicitly asks to order/menu/link again, call this tool anyway and resend the link. After calling, include the returned 'link' value in your response text.",
        parameters: z.object({
            reason: z.string().describe("Why the link is being sent"),
        }),
        execute: async ({ reason }) => {
            const allowed = !ctx.magicLinkAlreadySent || ctx.explicitMenuLinkIntent;
            if (!allowed || !ctx.magicLink) {
                return {
                    allowed: false,
                    link: null,
                    message: ctx.language === "kk"
                        ? "Алдыңғы сілтемемен тапсырыс бере аласыз."
                        : "Можете оформить заказ по предыдущей ссылке.",
                };
            }
            await markMagicLinkSent(ctx.instanceId, ctx.phone).catch(() => false);
            return {
                allowed: true,
                link: ctx.magicLink,
                message: null,
                validity: "1 month",
            };
        },
    });
}
