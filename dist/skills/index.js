import { createSearchMenuSkill } from "./searchMenu.skill.js";
import { createGetPaymentDetailsSkill, createRegisterPaymentReceiptSkill } from "./payment.skill.js";
import { createUpdateCrmLeadSkill } from "./crm.skill.js";
import { createEscalateToAdminSkill } from "./escalation.skill.js";
import { createSendMenuLinkSkill } from "./menuLink.skill.js";
export function createFastFoodSkills(ctx) {
    return [
        createSearchMenuSkill(ctx),
        createGetPaymentDetailsSkill(ctx),
        createRegisterPaymentReceiptSkill(ctx),
        createUpdateCrmLeadSkill(ctx),
        createEscalateToAdminSkill(ctx),
        createSendMenuLinkSkill(ctx),
    ];
}
