import { createTool } from "@voltagent/core";
import { z } from "zod";
const BUSINESS_INFO_FIELDS = ["work_hours", "whatsapp_phone", "brand", "address"];
function cleanPublicValue(value, max = 500) {
  return String(value ?? "").replace(/[\r\n\t]+/g, " ").replace(/\s+/g, " ").trim().slice(0, max);
}
function publicBusinessInfo(config) {
  return {
    work_hours: cleanPublicValue(config.work_hours),
    whatsapp_phone: cleanPublicValue(config.whatsapp_phone, 40),
    brand: cleanPublicValue(config.brand, 160),
    address: cleanPublicValue(config.address)
  };
}
function createGetBusinessInfoSkill(ctx) {
  return createTool({
    name: "getBusinessInfo",
    description: "Return only customer-safe restaurant information from the current instance: work hours, this bot's WhatsApp phone, brand, and address. Never return any other NocoDB column.",
    parameters: z.object({
      fields: z.array(z.enum(BUSINESS_INFO_FIELDS)).max(BUSINESS_INFO_FIELDS.length).optional()
    }),
    execute: async ({ fields }) => {
      const all = publicBusinessInfo(ctx.config || {});
      const requested = fields?.length ? Array.from(new Set(fields)) : [...BUSINESS_INFO_FIELDS];
      const data = Object.fromEntries(requested.map((field) => [field, all[field]]));
      return {
        source: "nocodb_current_instance_allowlist",
        instanceId: ctx.instanceId,
        data,
        unavailable: requested.filter((field) => !all[field])
      };
    }
  });
}
export {
  createGetBusinessInfoSkill
};
