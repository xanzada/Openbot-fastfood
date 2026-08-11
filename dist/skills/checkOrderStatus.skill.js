import { createTool } from "@voltagent/core";
import { z } from "zod";
import { getCustomerOrder } from "../services/customerOrder.service.js";
export function createCheckOrderStatusSkill(ctx) {
    return createTool({
        name: "checkOrderStatus",
        description: "Read the current customer order from DLE. This is read-only, always uses the current WhatsApp customer, and returns only customer-safe order fields.",
        parameters: z.object({
            orderId: z.string().regex(/^\d{1,12}$/).optional().describe("Order number supplied by the current customer"),
        }),
        execute: async ({ orderId }) => {
            // The hub resolves the order by instance + phone and ignores `domain`
            // entirely, so refusing to look up a tenant that has no storefront URL
            // configured made the bot answer "unavailable" forever for that tenant.
            const domain = ctx.config?.domain || "";
            const result = await getCustomerOrder(ctx.instanceId, domain, ctx.phone, ctx.language, orderId);
            if (result.state !== "found")
                return { lookup: result.state };
            return {
                lookup: "found",
                orderNumber: result.order.orderNumber,
                status: result.order.status,
                stage: result.order.stage,
                statusLabel: result.order.statusLabel,
                statusExplanation: result.order.statusExplanation,
                items: result.order.items,
            };
        },
    });
}
