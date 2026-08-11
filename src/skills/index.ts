import type { FastFoodContext } from "../context/types.js";
import { createSearchMenuSkill } from "./searchMenu.skill.js";
import { createGetPaymentDetailsSkill } from "./payment.skill.js";
import { createUpdateCrmLeadSkill } from "./crm.skill.js";
import { createEscalateToAdminSkill } from "./escalation.skill.js";
import { createSendMenuLinkSkill } from "./menuLink.skill.js";
import { createCheckOrderStatusSkill } from "./checkOrderStatus.skill.js";
import { createGetBusinessInfoSkill } from "./businessInfo.skill.js";
import { createGetKitchenStatusSkill, createGetShiftNotesSkill } from "./runtimeStatus.skill.js";

export const FAST_FOOD_SKILL_NAMES = [
  "searchMenu",
  "getPaymentDetails",
  "updateCrmLead",
  "escalateToAdmin",
  "sendMenuLink",
  "checkOrderStatus",
  "getBusinessInfo",
  // Written long ago, never registered: without these two the agent could not
  // re-check the kitchen or the operator's notes mid-conversation and answered
  // from a snapshot taken before the guest asked.
  "getKitchenStatus",
  "getShiftNotes",
] as const;

export function createFastFoodSkills(ctx: FastFoodContext) {
  return [
    createSearchMenuSkill(ctx),
    createGetPaymentDetailsSkill(ctx),
    createUpdateCrmLeadSkill(ctx),
    createEscalateToAdminSkill(ctx),
    createSendMenuLinkSkill(ctx),
    createCheckOrderStatusSkill(ctx),
    createGetBusinessInfoSkill(ctx),
    createGetKitchenStatusSkill(ctx),
    createGetShiftNotesSkill(ctx),
  ];
}
