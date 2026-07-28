import { createTool } from "@voltagent/core";
import { z } from "zod";
import type { FastFoodContext } from "../context/types.js";

const BUSINESS_INFO_FIELDS = ["work_hours", "whatsapp_phone", "brand", "address"] as const;
type BusinessInfoField = (typeof BUSINESS_INFO_FIELDS)[number];

function cleanPublicValue(value: unknown, max = 500): string {
  return String(value ?? "")
    .replace(/[\r\n\t]+/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, max);
}

function publicBusinessInfo(config: Record<string, any>): Record<BusinessInfoField, string> {
  return {
    work_hours: cleanPublicValue(config.work_hours),
    whatsapp_phone: cleanPublicValue(config.whatsapp_phone, 40),
    brand: cleanPublicValue(config.brand, 160),
    address: cleanPublicValue(config.address),
  };
}

export function createGetBusinessInfoSkill(ctx: FastFoodContext) {
  return createTool({
    name: "getBusinessInfo",
    description:
          "Return only customer-safe restaurant information from the current instance: work hours, this bot's WhatsApp phone, brand, and address. Never return any secret platform field.",
    parameters: z.object({
      fields: z.array(z.enum(BUSINESS_INFO_FIELDS)).max(BUSINESS_INFO_FIELDS.length).optional(),
    }),
    execute: async ({ fields }) => {
      const all = publicBusinessInfo(ctx.config || {});
      const requested = fields?.length ? Array.from(new Set(fields)) : [...BUSINESS_INFO_FIELDS];
      const data = Object.fromEntries(requested.map((field) => [field, all[field]]));
      return {
          source: "whatspro_platform_current_instance_allowlist",
        instanceId: ctx.instanceId,
        data,
        unavailable: requested.filter((field) => !all[field]),
      };
    },
  });
}
