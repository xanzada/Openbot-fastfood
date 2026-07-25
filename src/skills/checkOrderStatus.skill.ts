import { createTool } from "@voltagent/core";
import { z } from "zod";
import { getCustomerOrder } from "../services/customerOrder.service.js";
import type { FastFoodContext } from "../context/types.js";

export function createCheckOrderStatusSkill(ctx: FastFoodContext) {
  return createTool({
    name: "checkOrderStatus",
    description:
      "Read the current customer order from DLE. This is read-only, always uses the current WhatsApp customer, and returns only customer-safe order fields.",
    parameters: z.object({
      orderId: z.string().regex(/^\d{1,12}$/).optional().describe("Order number supplied by the current customer"),
    }),
    execute: async ({ orderId }) => {
      const domain = ctx.config?.domain || "";
      if (!domain) return { lookup: "unavailable" };
      const result = await getCustomerOrder(ctx.instanceId, domain, ctx.phone, ctx.language, orderId);
      if (result.state !== "found") return { lookup: result.state };
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
