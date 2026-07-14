import { createTool } from "@voltagent/core";
import { z } from "zod";
import type { FastFoodContext } from "../context/types.js";
import { updateCrmAction } from "../services/dle.service.js";

export function createGetPaymentDetailsSkill(ctx: FastFoodContext) {
  return createTool({
    name: "getPaymentDetails",
    description: "Return current payment details. Use runtime payment_details first; fallback to NocoDB config only if runtime is empty.",
    parameters: z.object({
      requestedLabel: z.string().optional(),
    }),
    execute: async ({ requestedLabel }) => {
      const runtimeDetails = Array.isArray(ctx.runtimeStatus?.payment_details)
        ? ctx.runtimeStatus?.payment_details
        : [];
      const fallback = [];
      if (!runtimeDetails.length && ctx.config.kaspi_info) {
        fallback.push({ label: "Kaspi", value: ctx.config.kaspi_info, source: "nocodb_fallback" });
      }
      const all = runtimeDetails.length ? runtimeDetails : fallback;
      const needle = String(requestedLabel || "").toLowerCase();
      const filtered = needle
        ? all.filter((item: any) => String(item.label || "").toLowerCase().includes(needle))
        : all;
      return {
        source: runtimeDetails.length ? "runtime_status" : "nocodb_fallback",
        details: filtered.length ? filtered : all,
      };
    },
  });
}

export function createRegisterPaymentReceiptSkill(ctx: FastFoodContext) {
  return createTool({
    name: "registerPaymentReceipt",
    description: "Register a customer's Kaspi/Halyk payment receipt in the DLE CRM. This calls add_payment_comment in DLE which updates ai_comment — it does NOT change order status. Call ONLY after validating the media IS a real payment receipt.",
    parameters: z.object({
      amountPaid: z.number().min(1).describe("Amount paid in tenge from the receipt"),
      senderName: z.string().min(1).max(80).describe("Sender name extracted from the receipt via OCR/Vision"),
    }),
    execute: async ({ amountPaid, senderName }) => {
      return updateCrmAction("receipt", ctx.instanceId, ctx.phone, {
        config: ctx.config,
        amount_paid: amountPaid,
        sender_name: senderName,
      });
    },
  });
}
