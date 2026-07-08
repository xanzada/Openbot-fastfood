import { createTool } from "@voltagent/core";
import { z } from "zod";
import { markMagicLinkSent } from "../services/redis.service.js";
export function createSendMenuLinkSkill(ctx) {
    return createTool({
        name: "sendMenuLink",
        description: "Send a menu magic link to the customer. Use ONLY when the customer explicitly asks or needs it.",
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
