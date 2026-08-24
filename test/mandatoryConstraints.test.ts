import test from "node:test";
import assert from "node:assert/strict";
import { buildFactsPrompt } from "../src/context/buildFactsPrompt.js";
import { FASTFOOD_AGENT_INSTRUCTIONS } from "../src/agent/instructions.js";

function ctx(overrides: Record<string, any> = {}) {
  return {
    instanceId: "prestige",
    language: "kk",
    text: "",
    config: { brand: "Test" },
    chatHistory: [],
    shporContext: [],
    activeShiftNotes: [],
    customerProfile: null,
    thinking: null,
    activeGoal: null,
    proactiveSignals: null,
    hardRealtimeContext: {},
    runtimeStatus: null,
    ...overrides,
  } as any;
}

test("mandatory_constraints is the FIRST block right after now_iso", () => {
  const out = buildFactsPrompt(ctx());
  const nowIdx = out.indexOf('"now_iso"');
  const mcIdx = out.indexOf('"mandatory_constraints"');
  assert.ok(nowIdx > -1 && mcIdx > nowIdx);
  const between = out.slice(nowIdx, mcIdx);
  assert.ok(between.length < 120, "nothing significant between now_iso and mandatory_constraints");
  assert.ok(out.includes("MANDATORY BACKEND CHECK"));
  assert.ok(out.includes("overrides the menu and the customer's assumption"));
});

test("a customer message hitting a note term is flagged deterministically", () => {
  const out = buildFactsPrompt(ctx({
    text: "донер бар ма?",
    activeShiftNotes: [{ noteId: "7", text: "лаваш бітіп қалды, донер жоқ", expiresAt: Date.now() + 3600_000 }],
  }));
  assert.ok(out.includes('"operator_notes_active": 1'));
  const fieldIdx = out.indexOf('"operator_notes_hit_by_current_message"');
  assert.ok(fieldIdx > -1, "hit field must be present");
  assert.ok(out.slice(fieldIdx, fieldIdx + 120).includes('"7"'), "hit note id must be listed");
});

test("unrelated messages are not flagged", () => {
  const out = buildFactsPrompt(ctx({
    text: "сәлем, қалайсыз?",
    activeShiftNotes: [{ noteId: "7", text: "лаваш бітіп қалды, донер жоқ", expiresAt: Date.now() + 3600_000 }],
  }));
  assert.ok(!out.includes("operator_notes_hit_by_current_message"));
});

test("busy kitchen mode and consent surface in the briefing", () => {
  const out = buildFactsPrompt(ctx({
    runtimeStatus: { wait_time: 60, delivery: true, pickup: true },
    hardRealtimeContext: { wait_time: 60 },
  }));
  assert.ok(out.includes('"kitchen_mode": "busy"'));
  assert.ok(out.includes('"wait_consent_required": true'));
  assert.ok(out.includes('"blocks_all_orders": false'));
});

test("a closed kitchen blocks all orders in the briefing", () => {
  const out = buildFactsPrompt(ctx({
    runtimeStatus: { wait_time: 240, delivery: true, pickup: true },
  }));
  assert.ok(out.includes('"blocks_all_orders": true'));
});

test("instructions declare notes as live law with alternatives and no bare refusal", () => {
  assert.ok(FASTFOOD_AGENT_INSTRUCTIONS.includes("notes are the kitchen's live law"));
  assert.ok(FASTFOOD_AGENT_INSTRUCTIONS.includes("never leave them with a bare refusal"));
  assert.ok(FASTFOOD_AGENT_INSTRUCTIONS.includes("verified alternatives from searchMenu"));
});

test("instructions define the consent conversation and the no-outcome close", () => {
  assert.ok(FASTFOOD_AGENT_INSTRUCTIONS.includes("clear yes means continue the order normally"));
  assert.ok(FASTFOOD_AGENT_INSTRUCTIONS.includes("clear no means apologize briefly and close the topic politely"));
});

test("instructions enforce link discipline", () => {
  assert.ok(FASTFOOD_AGENT_INSTRUCTIONS.includes("Send the link only when it is truly needed"));
  assert.ok(FASTFOOD_AGENT_INSTRUCTIONS.includes("never while the current request is still constrained by an operator note or an unanswered wait consent"));
});

// The wait-consent rule is business-critical: a prompt rewrite may reword it,
// but it may not drop the mandatory ask, the refusal path, the clarify path or
// the delivery/pickup distinction (restored 2026-08-24).
test("instructions keep wait consent mandatory, per-channel and clarify-on-unclear", () => {
  assert.ok(FASTFOOD_AGENT_INSTRUCTIONS.includes("MANDATORY confirmation"), "consent must be stated as mandatory");
  assert.ok(FASTFOOD_AGENT_INSTRUCTIONS.includes("clear yes means continue the order normally"));
  assert.ok(FASTFOOD_AGENT_INSTRUCTIONS.includes("clear no means apologize briefly and close the topic politely"));
  assert.ok(/never treat silence, a change of subject or an unrelated sentence as agreement/.test(FASTFOOD_AGENT_INSTRUCTIONS));
  assert.ok(FASTFOOD_AGENT_INSTRUCTIONS.includes("Delivery and pickup are separate"));
  assert.ok(FASTFOOD_AGENT_INSTRUCTIONS.includes("delivery_wait_consent_required"));
  assert.ok(FASTFOOD_AGENT_INSTRUCTIONS.includes("pickup_wait_consent_required"));
});

test("per-channel consent facts reach the briefing", () => {
  const out = buildFactsPrompt(ctx({
    runtimeStatus: { wait_time: 0, delivery: true, pickup: true },
    hardRealtimeContext: { wait_time: 0, delivery: true, pickup: true },
    activeShiftNotes: [{ noteId: "c1", text: "Доставка задерживается примерно на 90 минут. Самовывоз как обычно." }],
  }));
  assert.ok(out.includes('"delivery_wait_consent_required": true'), "the delayed channel must ask");
  assert.ok(out.includes('"pickup_wait_consent_required": false'), "the normal channel must not ask");
  assert.ok(out.includes("delivery_wait_label"));
  assert.ok(out.includes("pickup_wait_label"));
});
