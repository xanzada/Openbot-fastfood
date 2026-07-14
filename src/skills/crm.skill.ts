import { createTool } from "@voltagent/core";
import { z } from "zod";
import { updateCrmAction } from "../services/dle.service.js";
import type { FastFoodContext } from "../context/types.js";

const CRM_SALES_STAGES = [
  "NEW",
  "MENU_SENT",
  "CHECKING_KITCHEN",
  "PAYMENT_PENDING",
  "RECEIPT_VERIFICATION",
  "PREPARING",
  "COMPLETED",
  "CANCELED",
] as const;

export function createUpdateCrmLeadSkill(ctx: FastFoodContext) {
  return createTool({
    name: "updateCrmLead",
    description: "Track the customer's current stage in the sales funnel for CRM analytics. This does NOT change any order status in DLE — it only records the customer's progress for reporting.",
    parameters: z.object({
      interest: z.string().optional().describe("What the customer is interested in (e.g., pizza, combo, delivery info)"),
      salesStage: z.enum(CRM_SALES_STAGES).optional().describe(
        "NEW — first contact, no link sent yet. "
        + "MENU_SENT — magic link was delivered. "
        + "CHECKING_KITCHEN — order received, waiting for kitchen confirmation. "
        + "PAYMENT_PENDING — operator approved, awaiting customer payment. "
        + "RECEIPT_VERIFICATION — customer sent a receipt, being verified. "
        + "PREPARING — order confirmed and being prepared. "
        + "COMPLETED — order delivered/picked up. "
        + "CANCELED — order was cancelled."
      ),
      psychoAnalysis: z.string().optional().describe("Brief mood or behavior note (e.g., 'довольный', 'спешит', 'недоволен задержкой')"),
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
