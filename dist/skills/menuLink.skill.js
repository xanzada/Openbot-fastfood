import { createTool } from "@voltagent/core";
import { z } from "zod";
import { markKitchenCheckoutStarted, markMagicLinkSent } from "../services/redis.service.js";
function createSendMenuLinkSkill(ctx) {
  return createTool({
    name: "sendMenuLink",
    description: "Generate and return the customer's personal authenticated menu link. MUST be called when the customer wants to order, see the menu, browse items, or asks for a link. If the link was already sent but the customer explicitly asks to order/menu/link again, call this tool anyway and resend the link. After calling, include the returned 'link' value in your response text.",
    parameters: z.object({
      reason: z.string().describe("Why the link is being sent")
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
          message: !runtimeAvailable && !hasActiveOrder ? ctx.language === "kk" ? "\u0410\u0441 \u04AF\u0439\u0434\u0456\u04A3 \u0430\u0493\u044B\u043C\u0434\u0430\u0493\u044B \u043A\u04AF\u0439\u0456\u043D \u0442\u0435\u043A\u0441\u0435\u0440\u0435 \u0430\u043B\u043C\u0430\u0434\u044B\u043C, \u0441\u043E\u043D\u0434\u044B\u049B\u0442\u0430\u043D \u0436\u0430\u04A3\u0430 \u0442\u0430\u043F\u0441\u044B\u0440\u044B\u0441\u0442\u044B \u049B\u0430\u0437\u0456\u0440 \u0431\u0430\u0441\u0442\u0430\u0439 \u0430\u043B\u043C\u0430\u0439\u043C\u044B\u043D. \u0421\u04D9\u043B\u0434\u0435\u043D \u043A\u0435\u0439\u0456\u043D \u049B\u0430\u0439\u0442\u0430 \u043A\u04E9\u0440\u0456\u04A3\u0456\u0437." : "\u041D\u0435 \u0443\u0434\u0430\u043B\u043E\u0441\u044C \u043F\u0440\u043E\u0432\u0435\u0440\u0438\u0442\u044C \u0442\u0435\u043A\u0443\u0449\u0435\u0435 \u0441\u043E\u0441\u0442\u043E\u044F\u043D\u0438\u0435 \u043A\u0443\u0445\u043D\u0438, \u043F\u043E\u044D\u0442\u043E\u043C\u0443 \u0441\u0435\u0439\u0447\u0430\u0441 \u043D\u0435\u043B\u044C\u0437\u044F \u043D\u0430\u0447\u0430\u0442\u044C \u043D\u043E\u0432\u044B\u0439 \u0437\u0430\u043A\u0430\u0437. \u041F\u043E\u043F\u0440\u043E\u0431\u0443\u0439\u0442\u0435 \u043D\u0435\u043C\u043D\u043E\u0433\u043E \u043F\u043E\u0437\u0436\u0435." : ctx.language === "kk" ? "\u0410\u043B\u0434\u044B\u04A3\u0493\u044B \u0441\u0456\u043B\u0442\u0435\u043C\u0435\u043C\u0435\u043D \u0442\u0430\u043F\u0441\u044B\u0440\u044B\u0441 \u0431\u0435\u0440\u0435 \u0430\u043B\u0430\u0441\u044B\u0437." : "\u041C\u043E\u0436\u0435\u0442\u0435 \u043E\u0444\u043E\u0440\u043C\u0438\u0442\u044C \u0437\u0430\u043A\u0430\u0437 \u043F\u043E \u043F\u0440\u0435\u0434\u044B\u0434\u0443\u0449\u0435\u0439 \u0441\u0441\u044B\u043B\u043A\u0435."
        };
      }
      await markMagicLinkSent(ctx.instanceId, ctx.phone).catch(() => false);
      await markKitchenCheckoutStarted(ctx.instanceId, ctx.phone).catch(() => false);
      return {
        allowed: true,
        link: ctx.magicLink,
        message: null,
        validity: "1 month"
      };
    }
  });
}
export {
  createSendMenuLinkSkill
};
