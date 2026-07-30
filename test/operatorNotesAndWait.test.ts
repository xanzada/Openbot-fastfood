import test from "node:test";
import assert from "node:assert/strict";
import { buildFactsPrompt } from "../src/context/buildFactsPrompt.js";

function ctx(overrides: Record<string, any> = {}) {
  return {
    instanceId: "prestige",
    language: "kk",
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

test("the note TEXT reaches the agent with the semantic warning rule", () => {
  const out = buildFactsPrompt(ctx({
    activeShiftNotes: [{ noteId: "26", text: "свет өшіп сусындар жылып кеткен, напитки жоқ", expiresAt: Date.now() + 3600_000 }],
  }));
  assert.ok(out.includes("напитки жоқ"), "note text must be visible");
  assert.ok(out.includes("active_operator_notes_rule"));
  assert.ok(out.includes("кола belongs to сусындар"), "semantic hint must be present");
  assert.ok(out.includes("warn the customer BEFORE they order"));
});

test("without active notes neither notes nor the rule appear", () => {
  const out = buildFactsPrompt(ctx());
  assert.ok(!out.includes("active_operator_notes_rule"));
});

test("a 60-minute busy kitchen exposes wait_label and requires consent (kk)", () => {
  const out = buildFactsPrompt(ctx({
    hardRealtimeContext: { wait_time: 60, delivery: true, pickup: true },
    runtimeStatus: { wait_time: 60, delivery: true, pickup: true },
  }));
  assert.ok(out.includes('"wait_consent_required": true'));
  assert.ok(out.includes('"wait_label": "1 сағат"'));
});

test("a calm kitchen hides the wait entirely", () => {
  const out = buildFactsPrompt(ctx({
    hardRealtimeContext: { wait_time: 0, delivery: true, pickup: true },
    runtimeStatus: { wait_time: 0, delivery: true, pickup: true },
  }));
  assert.ok(out.includes('"wait_label": ""'));
  assert.ok(out.includes('"wait_consent_required": false'));
});

test("wait label is spoken form, not raw minutes", () => {
  const out = buildFactsPrompt(ctx({
    hardRealtimeContext: { wait_time: 120 },
    runtimeStatus: { wait_time: 120 },
  }));
  assert.ok(out.includes('"wait_label": "2 сағат"'));
  assert.ok(!out.includes('"wait_label": "120'));
});
