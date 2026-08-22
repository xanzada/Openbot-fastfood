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

// Tools that CHANGE something outside this turn. The critic path re-runs the whole
// agent on the same ctx, so without memoisation every one of these ran twice:
// updateCrmLead wrote the CRM again, sendMenuLink re-marked markMagicLinkSent and
// markKitchenCheckoutStarted, and escalateToAdmin called routeComplaintToAdmin a
// second time - where takeComplaintClarification now found the flag the FIRST pass
// had just written and turned a bare demand into a real operator case, defeating the
// clarify-first gate on exactly the high-risk turns the critic runs on
// (found 2026-08-22).
const SIDE_EFFECTING_SKILLS = ["updateCrmLead", "sendMenuLink", "escalateToAdmin"] as const;

type TurnToolMemo = Map<string, unknown>;

// One memo per turn, keyed on the ctx object itself, so nothing leaks between turns
// or between tenants and no caller has to remember to clear it.
const turnMemos = new WeakMap<object, TurnToolMemo>();

function turnMemo(ctx: FastFoodContext): TurnToolMemo {
  let memo = turnMemos.get(ctx as unknown as object);
  if (!memo) {
    memo = new Map();
    turnMemos.set(ctx as unknown as object, memo);
  }
  return memo;
}

/**
 * Wraps a side-effecting tool so the first call in a turn executes and every later
 * call in the SAME turn returns that first result verbatim.
 *
 * The model is not lied to: it receives exactly what the tool reported the first
 * time, which is what actually happened. Read-only tools are left alone - re-reading
 * the menu or the kitchen mid-turn is the whole point of having them.
 */
function memoizePerTurn(ctx: FastFoodContext, tool: any) {
  const name = String(tool?.name || "");
  if (!SIDE_EFFECTING_SKILLS.includes(name as (typeof SIDE_EFFECTING_SKILLS)[number])) return tool;
  const memo = turnMemo(ctx);
  const execute = tool.execute?.bind(tool);
  if (typeof execute !== "function") return tool;
  tool.execute = async (...args: unknown[]) => {
    if (memo.has(name)) return memo.get(name);
    const result = await execute(...args);
    memo.set(name, result);
    return result;
  };
  return tool;
}

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
  ].map((tool) => memoizePerTurn(ctx, tool));
}

export const __test = { SIDE_EFFECTING_SKILLS, memoizePerTurn, turnMemo };
