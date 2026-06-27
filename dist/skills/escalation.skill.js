import { createTool } from "@voltagent/core";
import { z } from "zod";
export function createEscalateToAdminSkill(ctx) {
    return createTool({
        name: "escalateToAdmin",
        description: "Escalate a critical or uncertain case to the restaurant admin/operator.",
        parameters: z.object({
            reason: z.string(),
            customerReply: z.string(),
            urgency: z.enum(["low", "normal", "high"]).default("normal"),
        }),
        execute: async ({ reason, customerReply, urgency }) => {
            return {
                action: "escalate_to_admin",
                instanceId: ctx.instanceId,
                phone: ctx.phone,
                adminPhone: ctx.config.admin_phone,
                reason,
                urgency,
                customerReply,
            };
        },
    });
}
