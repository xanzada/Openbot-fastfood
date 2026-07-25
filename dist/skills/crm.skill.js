import { createTool } from "@voltagent/core";
import { z } from "zod";
import { updateCrmAction } from "../services/dle.service.js";
const CRM_SALES_STAGES = [
  "NEW",
  "MENU_SENT",
  "CHECKING_KITCHEN",
  "PAYMENT_PENDING",
  "RECEIPT_VERIFICATION",
  "PREPARING",
  "COMPLETED",
  "CANCELED"
];
function createUpdateCrmLeadSkill(ctx) {
  return createTool({
    name: "updateCrmLead",
    description: "Track the customer's current stage in the sales funnel for CRM analytics. This does NOT change any order status in DLE \u2014 it only records the customer's progress for reporting.",
    parameters: z.object({
      interest: z.string().optional().describe("What the customer is interested in (e.g., pizza, combo, delivery info)"),
      salesStage: z.enum([...CRM_SALES_STAGES]).optional().describe(
        "NEW \u2014 first contact, no link sent yet. MENU_SENT \u2014 magic link was delivered. CHECKING_KITCHEN \u2014 order received, waiting for kitchen confirmation. PAYMENT_PENDING \u2014 operator approved, awaiting customer payment. RECEIPT_VERIFICATION \u2014 customer sent a receipt, being verified. PREPARING \u2014 order confirmed and being prepared. COMPLETED \u2014 order delivered/picked up. CANCELED \u2014 order was cancelled."
      ),
      psychoAnalysis: z.string().optional().describe("Brief mood or behavior note (e.g., '\u0434\u043E\u0432\u043E\u043B\u044C\u043D\u044B\u0439', '\u0441\u043F\u0435\u0448\u0438\u0442', '\u043D\u0435\u0434\u043E\u0432\u043E\u043B\u0435\u043D \u0437\u0430\u0434\u0435\u0440\u0436\u043A\u043E\u0439')")
    }),
    execute: async ({ interest, salesStage, psychoAnalysis }) => {
      return updateCrmAction("update_crm", ctx.instanceId, ctx.phone, {
        config: ctx.config,
        interest,
        sales_stage: salesStage,
        psycho_analysis: psychoAnalysis
      });
    }
  });
}
export {
  createUpdateCrmLeadSkill
};
