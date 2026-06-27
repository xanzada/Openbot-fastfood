import { createTool } from "@voltagent/core";
import { z } from "zod";
import { markMagicLinkSent } from "../services/redis.service.js";
import type { FastFoodContext } from "../context/types.js";

export function createSendMenuLinkSkill(ctx: FastFoodContext) {
  return createTool({
    name: "sendMenuLink",
    description: "Return a menu magic link only when the policy allows it.",
    parameters: z.object({
      reason: z.string(),
    }),
    execute: async ({ reason }) => {
      const allowed = !ctx.magicLinkAlreadySent || ctx.explicitMenuLinkIntent;
      if (!allowed || !ctx.magicLink) {
        return {
          allowed: false,
          reason: "Link was already sent and customer did not explicitly request it again.",
        };
      }
      await markMagicLinkSent(ctx.instanceId, ctx.phone).catch(() => false);
      return {
        allowed: true,
        reason,
        link: ctx.magicLink,
        validity: "1 month",
      };
    },
  });
}
