import type { FastFoodContext } from "../context/types.js";
import { createSearchMenuSkill } from "./searchMenu.skill.js";
import { createGetPaymentDetailsSkill } from "./payment.skill.js";
import { createUpdateCrmLeadSkill } from "./crm.skill.js";
import { createEscalateToAdminSkill } from "./escalation.skill.js";
import { createSendMenuLinkSkill } from "./menuLink.skill.js";
import { createCheckOrderStatusSkill } from "./checkOrderStatus.skill.js";
import { createGetKitchenStatusSkill, createGetShiftNotesSkill } from "./runtimeStatus.skill.js";

export function createFastFoodSkills(ctx: FastFoodContext) {
  return [
    createSearchMenuSkill(ctx),
    createGetPaymentDetailsSkill(ctx),
    createUpdateCrmLeadSkill(ctx),
    createEscalateToAdminSkill(ctx),
    createSendMenuLinkSkill(ctx),
    createCheckOrderStatusSkill(ctx),
    createGetKitchenStatusSkill(ctx),
    createGetShiftNotesSkill(ctx),
  ];
}
