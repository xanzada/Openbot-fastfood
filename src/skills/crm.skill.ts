import { createTool } from "@voltagent/core";
import { z } from "zod";
import { updateCrmAction } from "../services/dle.service.js";
import type { FastFoodContext } from "../context/types.js";

export function createUpdateCrmLeadSkill(ctx: FastFoodContext) {
  return createTool({
    name: "updateCrmLead",
    description: "Update customer CRM analytics without changing order state.",
    parameters: z.object({
      interest: z.string().optional(),
      salesStage: z.string().optional(),
      psychoAnalysis: z.string().optional(),
    }),
    execute: async ({ interest, salesStage, psychoAnalysis }) => {
      return updateCrmAction("update_crm", ctx.instanceId, ctx.phone, {
        config: ctx.config,
        interest,
        sales_stage: salesStage,
        psycho_analysis: psychoAnalysis,
      });
    },
  });
}
