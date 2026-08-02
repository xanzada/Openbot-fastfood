import test from "node:test";
import assert from "node:assert/strict";
import { AGENT_EVAL_SCENARIOS } from "../eval/scenarios.js";

test("agent eval corpus contains at least 120 unique real-service scenarios", () => {
  assert.ok(AGENT_EVAL_SCENARIOS.length >= 120, `only ${AGENT_EVAL_SCENARIOS.length} scenarios`);
  assert.equal(new Set(AGENT_EVAL_SCENARIOS.map((scenario) => scenario.id)).size, AGENT_EVAL_SCENARIOS.length);
});

test("agent eval corpus covers every critical behavior family in both languages", () => {
  const requiredCategories = [
    "smalltalk",
    "menu",
    "order_link",
    "business_info",
    "order_status",
    "payment_details",
    "payment_receipt",
    "complaint_actionable",
    "complaint_vague",
    "kitchen_busy",
    "kitchen_emergency",
    "safety",
    "memory",
    "multi_intent",
  ];

  for (const category of requiredCategories) {
    const scenarios = AGENT_EVAL_SCENARIOS.filter((scenario) => scenario.category === category);
    assert.ok(scenarios.some((scenario) => scenario.language === "kk"), `${category}: no Kazakh case`);
    assert.ok(scenarios.some((scenario) => scenario.language === "ru"), `${category}: no Russian case`);
  }
});

test("every scenario has an executable contract rather than prompt-only prose", () => {
  for (const scenario of AGENT_EVAL_SCENARIOS) {
    const assertions = [
      scenario.expectedTools?.length,
      scenario.forbiddenTools?.length,
      scenario.requireAny?.length,
      scenario.forbidAny?.length,
      scenario.requireLink,
      scenario.recentDialog?.length,
    ].some(Boolean);
    assert.ok(assertions, `${scenario.id}: missing executable expectations`);
  }
});
