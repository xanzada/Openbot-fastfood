import { createTool } from "@voltagent/core";
import { z } from "zod";
import type { FastFoodContext } from "../context/types.js";
import { getRestaurantConfig } from "../services/nocodb.service.js";

function normalizePhone(value = "") {
  return String(value || "").replace(/\D/g, "");
}

function getAdminPhone(config: Record<string, any> = {}) {
  return normalizePhone(config.admin_phone);
}

export function createEscalateToAdminSkill(ctx: FastFoodContext) {
  return createTool({
    name: "escalateToAdmin",
    description: "Escalate a critical or uncertain case to the restaurant admin/operator.",
    parameters: z.object({
      reason: z.string(),
      customerReply: z.string(),
      urgency: z.enum(["low", "normal", "high"]).default("normal"),
    }),
    execute: async ({ reason, customerReply, urgency }) => {
      const liveConfig = (await getRestaurantConfig(ctx.instanceId).catch(() => null)) || {};
      const adminPhone = getAdminPhone(liveConfig);
      return {
        action: "escalate_to_admin",
        instanceId: ctx.instanceId,
        phone: ctx.phone,
        adminPhone: adminPhone || null,
        escalationAvailable: Boolean(adminPhone),
        reason,
        urgency,
        customerReply,
      };
    },
  });
}
