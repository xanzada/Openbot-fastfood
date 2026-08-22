import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { AGENT_EVAL_SCENARIOS } from "../eval/scenarios.js";
import {
  resolveAgentToolPlan,
  type AgentToolName,
} from "../src/agent/toolPolicy.js";

const CODE_GATED_TOOLS = new Set<AgentToolName>([
  "searchMenu",
  "getPaymentDetails",
  "escalateToAdmin",
  "sendMenuLink",
  "checkOrderStatus",
  "getBusinessInfo",
]);

function contextFor(scenario: (typeof AGENT_EVAL_SCENARIOS)[number]) {
  const hasActiveOrder = scenario.contextKind === "activeOrderPending"
    || scenario.contextKind === "activeOrderPaid";
  return {
    text: scenario.message,
    activeOrder: hasActiveOrder ? { id: 42, status: "pending" } : null,
    explicitMenuLinkIntent: scenario.category === "order_link",
    // Production shape: is_accepting_orders / within_work_hours / is_emergency live
    // on runtimeStatus, NOT on hardRealtimeContext. The old fixture put them on
    // hardRealtimeContext, which production never does, so this corpus could not
    // see that toolPolicy was classifying the kitchen from the partial object
    // (found 2026-08-22).
    runtimeStatus: {
      wait_time: scenario.contextKind === "busy60" ? 60 : 0,
      is_emergency: scenario.contextKind === "emergency",
      is_accepting_orders: scenario.contextKind !== "emergency",
      within_work_hours: true,
    },
    hardRealtimeContext: {
      wait_time: scenario.contextKind === "busy60" ? 60 : 0,
    },
  } as any;
}

describe("146-scenario deterministic agent policy", () => {
  for (const scenario of AGENT_EVAL_SCENARIOS) {
    test(`${scenario.id}: ${scenario.category} (${scenario.language})`, () => {
      const plan = resolveAgentToolPlan(contextFor(scenario));
      assert.ok(plan.requiredTools.length <= 3);
      assert.equal(new Set(plan.requiredTools).size, plan.requiredTools.length);

      for (const expected of scenario.expectedTools || []) {
        if (CODE_GATED_TOOLS.has(expected as AgentToolName)) {
          assert.ok(plan.requiredTools.includes(expected as AgentToolName), `missing deterministic tool ${expected}`);
        }
      }

      for (const forbidden of scenario.forbiddenTools || []) {
        assert.ok(!plan.requiredTools.includes(forbidden as AgentToolName), `unsafe deterministic tool ${forbidden}`);
      }
    });
  }

  test("a short kitchen estimate still allows checkout while a consent queue does not", () => {
    const shortWait = resolveAgentToolPlan({
      text: "Хочу заказать",
      explicitMenuLinkIntent: true,
      runtimeStatus: { wait_time: 20, is_accepting_orders: true, within_work_hours: true },
    } as any);
    const consentWait = resolveAgentToolPlan({
      text: "Хочу заказать",
      explicitMenuLinkIntent: true,
      runtimeStatus: { wait_time: 60, is_accepting_orders: true, within_work_hours: true },
    } as any);
    assert.ok(shortWait.requiredTools.includes("sendMenuLink"));
    assert.ok(!consentWait.requiredTools.includes("sendMenuLink"));
  });
});
