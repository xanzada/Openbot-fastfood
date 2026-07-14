import { createTool } from "@voltagent/core";
import { z } from "zod";
import { getOrderStatus } from "../services/dle.service.js";
import type { FastFoodContext } from "../context/types.js";

export function createCheckOrderStatusSkill(ctx: FastFoodContext) {
  return createTool({
    name: "checkOrderStatus",
    description: "Read the customer's current active order status from the DLE database. This is READ-ONLY — it never changes any order state. Call when the customer asks 'Where is my order?', 'Статус заказа', 'Тапсырыс қайда?', or similar status inquiries.",
    parameters: z.object({}),
    execute: async () => {
      const domain = ctx.config?.domain || "";
      if (!domain) return { active: false, reason: "domain_not_configured" };

      const order = await getOrderStatus(ctx.instanceId, ctx.phone, domain);
      if (!order) {
        return {
          active: false,
          status: null,
          message: ctx.language === "kk"
            ? "Сізде белсенді тапсырыс жоқ."
            : "У вас нет активного заказа.",
        };
      }

      return {
        active: true,
        order_id: order.order_id,
        status: order.status,
        payment_status: order.payment_status,
        total_price: order.total_price,
        items: order.items || [],
        address: order.address || null,
        is_pickup: order.is_pickup || false,
        is_stale: Boolean(order.is_stale),
        recent_orders: order.recent_orders || [],
      };
    },
  });
}