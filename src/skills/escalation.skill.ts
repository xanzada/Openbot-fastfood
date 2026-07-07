import { createTool } from "@voltagent/core";
import { z } from "zod";
import type { FastFoodContext } from "../context/types.js";
import { getRestaurantConfig } from "../services/nocodb.service.js";
import { clearComplaintMedia, getComplaintMedia } from "../services/redis.service.js";
import { sendWhatsProMessage } from "../transport/whatspro.client.js";

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
      const complaintMedia = await getComplaintMedia(ctx.instanceId, ctx.phone).catch(() => null);
      const orderInfo = ctx.activeOrder?.order_id || ctx.activeOrder?.id || "Табылмады";
      const restaurantLabel = liveConfig.name || liveConfig.restaurant_name || ctx.config.name || ctx.instanceId;
      const adminMsg = `${urgency === "high" ? "🚨 *ЖАҢА ШАҒЫМ*" : "⚠️ *ОПЕРАТОР КӨМЕГІ ҚАЖЕТ*"}\n🏪 *Ресторан:* ${restaurantLabel}\n📞 *Клиент:* +${ctx.phone}\n📌 *Тапсырыс №:* ${orderInfo}\n\n🧠 *AI Анализі:* ${reason}`;
      const media = complaintMedia?.base64
        ? {
            base64: complaintMedia.base64,
            mimeType: complaintMedia.mediaType || complaintMedia.mimeType || "image/jpeg",
            type: String(complaintMedia.mediaType || complaintMedia.mimeType || "image").includes("image")
              ? "image"
              : "document",
          }
        : null;
      let sent: any = null;
      if (adminPhone) {
        sent = await sendWhatsProMessage({
          instanceId: ctx.instanceId,
          phone: adminPhone,
          text: adminMsg,
          media,
        });
        if (media) await clearComplaintMedia(ctx.instanceId, ctx.phone).catch(() => undefined);
      }

      return {
        action: "escalate_to_admin",
        instanceId: ctx.instanceId,
        phone: ctx.phone,
        adminPhone: adminPhone || null,
        escalationAvailable: Boolean(adminPhone),
        sent,
        adminPayload: {
          phone: adminPhone || null,
          text: adminMsg,
          media,
        },
        reason,
        urgency,
        customerReply,
      };
    },
  });
}
