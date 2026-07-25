import { createTool } from "@voltagent/core";
import { z } from "zod";
import type { FastFoodContext } from "../context/types.js";

export function createGetPaymentDetailsSkill(ctx: FastFoodContext) {
  return createTool({
    name: "getPaymentDetails",
    description: "Return current payment details only from the live site kitchen settings payment_details.",
    parameters: z.object({
      requestedLabel: z.string().optional(),
    }),
    execute: async ({ requestedLabel }) => {
      const runtimeDetails = Array.isArray(ctx.runtimeStatus?.payment_details)
        ? ctx.runtimeStatus.payment_details
        : Array.isArray(ctx.runtimeStatus?.kitchen_status?.payment_details)
          ? ctx.runtimeStatus.kitchen_status.payment_details
          : [];
      const all = runtimeDetails;
      const needle = String(requestedLabel || "").toLowerCase();
      const filtered = needle
        ? all.filter((item: any) => String(item.label || "").toLowerCase().includes(needle))
        : all;
      return {
        source: runtimeDetails.length ? "site_kitchen_settings" : "not_configured",
        details: filtered.length ? filtered : all,
      };
    },
  });
}
