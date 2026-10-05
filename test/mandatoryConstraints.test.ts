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
  assert.ok(/never a bare refusal/.test(FASTFOOD_AGENT_INSTRUCTIONS));
  assert.ok(/offer verified alternatives in the same message/.test(FASTFOOD_AGENT_INSTRUCTIONS));
});

test("instructions define the consent conversation and the no-outcome close", () => {
  assert.ok(/Clear yes = continue/.test(FASTFOOD_AGENT_INSTRUCTIONS));
  assert.ok(/Clear no = apologize briefly and close without pushing/.test(FASTFOOD_AGENT_INSTRUCTIONS));
});

test("instructions enforce link discipline", () => {
  assert.ok(/Send it only when truly needed/.test(FASTFOOD_AGENT_INSTRUCTIONS));
  assert.ok(/never while an operator note or unanswered wait consent is unresolved/.test(FASTFOOD_AGENT_INSTRUCTIONS));
});

// The wait-consent rule is business-critical: a prompt rewrite may reword it,
// but it may not drop the mandatory ask, the refusal path, the clarify path or
// the delivery/pickup distinction (restored 2026-08-24).
test("instructions keep wait consent mandatory, per-channel and clarify-on-unclear", () => {
  assert.ok(/WAIT CONSENT IS MANDATORY/.test(FASTFOOD_AGENT_INSTRUCTIONS), "consent must be stated as mandatory");
  assert.ok(/Clear yes = continue/.test(FASTFOOD_AGENT_INSTRUCTIONS));
  assert.ok(/Clear no = apologize briefly and close without pushing/.test(FASTFOOD_AGENT_INSTRUCTIONS));
  assert.ok(/Never treat silence, topic change, or an unrelated sentence as agreement/.test(FASTFOOD_AGENT_INSTRUCTIONS));
  assert.ok(FASTFOOD_AGENT_INSTRUCTIONS.includes("Delivery and pickup are separate"));
  assert.ok(/only that channel.s delay/.test(FASTFOOD_AGENT_INSTRUCTIONS));
  assert.ok(/Unclear = ask again plainly/.test(FASTFOOD_AGENT_INSTRUCTIONS));
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

// The voice must stay human: warm openings, an open-door close, one emoji at
// most, short human-sized sentences, and the URL alone on its own line. These
// are the guardrails a future prompt trim must not quietly remove
// (owner request, 2026-08-24).
test("instructions define a warm human voice with an open-door close", () => {
  assert.ok(/Help the customer warmly and clearly on WhatsApp/.test(FASTFOOD_AGENT_INSTRUCTIONS));
  assert.ok(/қосымша сұрағыңыз болса, жазыңыз/.test(FASTFOOD_AGENT_INSTRUCTIONS), "the Kazakh open-door phrasing is calibrated");
  assert.ok(/Composed fresh — not a template/.test(FASTFOOD_AGENT_INSTRUCTIONS));
  assert.ok(/Never use identical opening words in two consecutive messages/.test(FASTFOOD_AGENT_INSTRUCTIONS), "examples must never become templates");
});

test("instructions keep replies short, split and never one long paragraph", () => {
  assert.ok(/Never one long paragraph/.test(FASTFOOD_AGENT_INSTRUCTIONS));
  assert.ok(/break them into separate short sentences/.test(FASTFOOD_AGENT_INSTRUCTIONS));
});

test("instructions cap emoji and keep the URL on its own line", () => {
  assert.ok(/Max: 1 emoji per message/.test(FASTFOOD_AGENT_INSTRUCTIONS));
  assert.ok(/Skip emojis entirely:[\s\S]*In apologies or complaint handling[\s\S]*When communicating payment details[\s\S]*In delay or wait notifications/.test(FASTFOOD_AGENT_INSTRUCTIONS));
  assert.ok(/A URL sits alone on its own line/.test(FASTFOOD_AGENT_INSTRUCTIONS));
});

test("instructions forbid system-flavoured link wording", () => {
  assert.ok(FASTFOOD_AGENT_INSTRUCTIONS.includes("the menu made for them"));
  assert.ok(/Never call it a «token»/.test(FASTFOOD_AGENT_INSTRUCTIONS));
});
