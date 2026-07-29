import { createTool } from "@voltagent/core";
import { z } from "zod";
import type { FastFoodContext } from "../context/types.js";
import { routeComplaintToAdmin } from "../services/complaintRouting.service.js";

export function createEscalateToAdminSkill(ctx: FastFoodContext) {
  return createTool({
    name: "escalateToAdmin",
    description: "Create a human operator case only for an explicit request to speak to a person, a genuine complaint/service incident, or unresolved fulfillment that requires human action. Missing menu, payment, address, or business data alone is not a reason to escalate.",
    parameters: z.object({
      reason: z.string(),
      customerReply: z.string(),
      urgency: z.enum(["low", "normal", "high"]).default("normal"),
    }),
    execute: async ({ reason, customerReply, urgency }) => {
      const routing = await routeComplaintToAdmin(ctx, {
        summary: reason,
        customerReply,
        urgency,
        source: "ai_tool_escalate_to_admin",
      });

      return {
        action: "operator_case_created",
        caseId: routing.caseId,
        queuedForChat: routing.queuedForChat,
        escalationAvailable: routing.escalationAvailable,
        mediaAttached: routing.mediaAttached,
        urgency,
        customerReply: routing.customerReply,
      };
    },
  });
}
