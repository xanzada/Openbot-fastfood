import { createTool } from "@voltagent/core";
import { z } from "zod";
import { routeComplaintToAdmin } from "../services/complaintRouting.service.js";
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
            const routing = await routeComplaintToAdmin(ctx, {
                summary: reason,
                customerReply,
                urgency,
                source: "ai_tool_escalate_to_admin",
            });
            return {
                action: "escalate_to_admin",
                instanceId: ctx.instanceId,
                phone: ctx.phone,
                adminPhone: routing.adminPhone,
                escalationAvailable: routing.escalationAvailable,
                sent: routing.sent,
                adminPayload: {
                    phone: routing.adminPhone,
                    text: routing.adminText,
                    mediaAttached: routing.mediaAttached,
                },
                reason,
                urgency,
                customerReply: routing.customerReply,
            };
        },
    });
}
