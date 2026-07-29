import { createTool } from "@voltagent/core";
import { z } from "zod";
import type { FastFoodContext } from "../context/types.js";
import { ONLINE_PREPAYMENT_POLICY } from "../services/paymentPolicy.service.js";

export function createGetPaymentDetailsSkill(ctx: FastFoodContext) {
  return createTool({
    name: "getPaymentDetails",
    description: "Return current online prepayment details only from live kitchen settings. Payment is always online and prepaid; cash and payment on delivery or pickup are not accepted. If details are unavailable, report not_configured; never escalate a normal payment-method question by yourself.",
    parameters: z.object({
      requestedLabel: z.string().optional(),
    }),
    execute: async ({ requestedLabel }) => {
      const runtimeDetails = Array.isArray(ctx.runtimeStatus?.payment_details)
        ? ctx.runtimeStatus.payment_details
        : Array.isArray(ctx.runtimeStatus?.kitchen_status?.payment_details)
          ? ctx.runtimeStatus.kitchen_status.payment_details
          : [];
      const needle = String(requestedLabel || "").toLowerCase();
      const filtered = needle
        ? runtimeDetails.filter((item: any) => String(item.label || "").toLowerCase().includes(needle))
        : runtimeDetails;
      return {
        available: runtimeDetails.length > 0,
        source: runtimeDetails.length ? "site_kitchen_settings" : "not_configured",
        paymentPolicy: ONLINE_PREPAYMENT_POLICY,
        details: filtered.length ? filtered : runtimeDetails,
        instruction: runtimeDetails.length
          ? "Payment is online and prepaid only. Cash and payment on delivery or pickup are not accepted. Answer only from details and never claim payment succeeded without confirmation."
          : "Payment is online and prepaid only, but the current payment requisites are not configured/available to verify. Cash and payment on delivery or pickup are not accepted. Do not create an operator case unless the customer explicitly asks for a person.",
      };
    },
  });
}
