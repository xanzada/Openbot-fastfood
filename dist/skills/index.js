import { createSearchMenuSkill } from "./searchMenu.skill.js";
import { createGetPaymentDetailsSkill } from "./payment.skill.js";
import { createUpdateCrmLeadSkill } from "./crm.skill.js";
import { createEscalateToAdminSkill } from "./escalation.skill.js";
import { createSendMenuLinkSkill } from "./menuLink.skill.js";
import { createCheckOrderStatusSkill } from "./checkOrderStatus.skill.js";
import { createGetBusinessInfoSkill } from "./businessInfo.skill.js";
const FAST_FOOD_SKILL_NAMES = [
  "searchMenu",
  "getPaymentDetails",
  "updateCrmLead",
  "escalateToAdmin",
  "sendMenuLink",
  "checkOrderStatus",
  "getBusinessInfo"
];
function createFastFoodSkills(ctx) {
  return [
    createSearchMenuSkill(ctx),
    createGetPaymentDetailsSkill(ctx),
    createUpdateCrmLeadSkill(ctx),
    createEscalateToAdminSkill(ctx),
    createSendMenuLinkSkill(ctx),
    createCheckOrderStatusSkill(ctx),
    createGetBusinessInfoSkill(ctx)
  ];
}
export {
  FAST_FOOD_SKILL_NAMES,
  createFastFoodSkills
};
