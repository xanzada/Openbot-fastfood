import { createTool } from "@voltagent/core";
import { z } from "zod";
import type { FastFoodContext } from "../context/types.js";
import { paymentPolicyForOrder } from "../services/paymentPolicy.service.js";

export function createGetPaymentDetailsSkill(ctx: FastFoodContext) {
  return createTool({
    name: "getPaymentDetails",
    description: "Return current prepayment requisites only from live kitchen settings, plus the payment policy (prepay by default; some restaurants offer pay on receipt in the checkout link). Not for an order paid on receipt. If details are unavailable, report not_configured; never escalate a normal payment-method question by yourself.",
    parameters: z.object({
      requestedLabel: z.string().optional(),
    }),
    execute: async ({ requestedLabel }) => {
      const paymentPolicy = paymentPolicyForOrder(ctx.activeOrder);
      if (paymentPolicy.active_order_payment_timing === "on_receipt") {
        return {
          available: false,
          source: "order_on_receipt",
          paymentPolicy,
          details: [],
          instruction: "The guest's current order is paid on receipt. Do not send requisites and do not ask for a receipt; say they pay when they get the order.",
        };
      }
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
        paymentPolicy,
        details: filtered.length ? filtered : runtimeDetails,
        instruction: runtimeDetails.length
          ? "Prepayment by these requisites; the guest sends the receipt to this chat. Pay on receipt exists only if the checkout link offers it - never promise or deny it. Answer only from details and never claim payment succeeded without confirmation."
          : "The current payment requisites are not configured/available to verify; the restaurant sends them after confirming the order. Pay on receipt exists only if the checkout link offers it - never promise or deny it. Do not create an operator case unless the customer explicitly asks for a person.",
      };
    },
  });
}
