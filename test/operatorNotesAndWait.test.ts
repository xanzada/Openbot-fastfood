import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
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

test("the note becomes a derived constraint, never raw operator text", () => {
  const out = buildFactsPrompt(ctx({
    activeShiftNotes: [{ noteId: "26", text: "свет өшіп сусындар жылып кеткен, напитки жоқ", expiresAt: Date.now() + 3600_000 }],
  }));
  // The operator writes shorthand for the kitchen, not a sentence for a guest.
  // Only the derived constraint may travel, so nothing quotable exists.
  assert.ok(!out.includes("свет өшіп"), "raw operator wording must not be present");
  assert.ok(out.includes("unavailable_now"), "derived constraint must reach the agent");
  assert.ok(out.includes("active_operator_notes_rule"));
  assert.ok(out.includes("кола belongs to сусындар"), "semantic hint must be present");
  assert.ok(out.includes("Warn the customer BEFORE they order"));
  assert.ok(out.includes("CONFIDENTIAL SOURCE"), "confidentiality must be stated");
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

test("an existing order never mutes the kitchen gate", () => {
  // Regression: a guest with an open order asked to order again and the bot
  // answered with a bare link, never mentioning the 60-minute wait, because
  // the gate returned early on activeOrder. Questions about an existing order
  // are answered before the gate, so anything reaching it is new intent.
  const src = readFileSync(new URL("../src/routes/whatsappWebhook.route.ts", import.meta.url), "utf8");
  const gate = src.slice(src.indexOf("async function kitchenGateReply"));
  const body = gate.slice(0, gate.indexOf("\nasync function ", 10) + 1 || undefined);
  assert.ok(!/if \(ctx\.activeOrder\) return null;/.test(body), "the gate must not mute itself on an active order");
  assert.ok(body.includes("policy.requiresConsent"), "consent branch must remain");
  assert.ok(body.includes("savePendingKitchenConsent"), "the wait question must be remembered");
});
