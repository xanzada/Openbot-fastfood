import { createTool } from "@voltagent/core";
import { z } from "zod";
import { getOrderStatus } from "../services/dle.service.js";
export function createCheckOrderStatusSkill(ctx) {
    return createTool({
        name: "checkOrderStatus",
        description: "Read the customer's current active order status from the DLE database. This is READ-ONLY — it never changes any order state. Call when the customer asks 'Where is my order?', 'Статус заказа', 'Тапсырыс қайда?', or similar status inquiries.",
        parameters: z.object({}),
        execute: async () => {
            const domain = ctx.config?.domain || "";
            if (!domain)
                return { active: false, reason: "domain_not_configured" };
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
            const data = order;
            return {
                active: true,
                order_id: data.order_id,
                status: data.status,
                payment_status: data.payment_status,
                total_price: data.total_price,
                items: data.items || [],
                address: data.address || null,
                is_pickup: data.is_pickup || false,
                is_stale: Boolean(data.is_stale),
                recent_orders: data.recent_orders || [],
            };
        },
    });
}
