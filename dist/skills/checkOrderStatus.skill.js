import { createTool } from "@voltagent/core";
import { z } from "zod";
import { getOrderContext, getOrderStatus, normalizePhone } from "../services/dle.service.js";
export function createCheckOrderStatusSkill(ctx) {
    return createTool({
        name: "checkOrderStatus",
        description: "Read order status from the live DLE database. This is READ-ONLY and never changes order state. Use orderId when the customer gives a specific order number; otherwise use the current WhatsApp phone.",
        parameters: z.object({
            orderId: z.string().optional().describe("Specific DLE order id if the customer provided it"),
            phone: z.string().optional().describe("Customer phone override. Defaults to the current WhatsApp phone."),
        }),
        execute: async ({ orderId, phone }) => {
            const domain = ctx.config?.domain || "";
            if (!domain)
                return { active: false, reason: "domain_not_configured" };
            const cleanPhone = normalizePhone(phone || ctx.phone);
            const order = orderId
                ? await getOrderContext(ctx.instanceId, domain, { phone: cleanPhone, orderId })
                : await getOrderStatus(ctx.instanceId, cleanPhone, domain);
            if (!order) {
                return {
                    active: false,
                    status: null,
                    message: ctx.language === "kk" ? "Сізде белсенді тапсырыс жоқ." : "У вас нет активного заказа.",
                };
            }
            const data = order;
            const orderData = data.order || data.active_order || null;
            const isActive = Boolean(data.active ?? true);
            return {
                found: Boolean(data.found ?? orderData),
                active: isActive,
                source: data.source || "dle_spa_orders",
                order_id: data.order_id || orderData?.id || null,
                status: data.status || orderData?.status || null,
                payment_status: data.payment_status || orderData?.payment_status || null,
                total_price: data.total_price || orderData?.total_price || 0,
                items: data.items || orderData?.items || [],
                address: data.address || orderData?.address || null,
                comment: data.comment || orderData?.comment || null,
                is_pickup: Boolean(data.is_pickup || orderData?.is_pickup),
                is_stale: Boolean(data.is_stale),
                order: orderData,
                active_order: isActive ? data.active_order || orderData : null,
                recent_orders: data.recent_orders || [],
            };
        },
    });
}
