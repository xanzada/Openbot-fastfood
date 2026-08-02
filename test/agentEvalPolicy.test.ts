import { describe, expect, test } from "vitest";
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
  } as any;
}

describe("146-scenario deterministic agent policy", () => {
  test.each(AGENT_EVAL_SCENARIOS)(
    "$id: $category ($language)",
    (scenario) => {
      const plan = resolveAgentToolPlan(contextFor(scenario));
      expect(plan.requiredTools.length).toBeLessThanOrEqual(3);
      expect(new Set(plan.requiredTools).size).toBe(plan.requiredTools.length);

      for (const expected of scenario.expectedTools || []) {
        if (CODE_GATED_TOOLS.has(expected as AgentToolName)) {
          expect(plan.requiredTools, `missing deterministic tool ${expected}`).toContain(expected);
        }
      }

      for (const forbidden of scenario.forbiddenTools || []) {
        expect(plan.requiredTools, `unsafe deterministic tool ${forbidden}`).not.toContain(forbidden);
      }
    }
  );
});
