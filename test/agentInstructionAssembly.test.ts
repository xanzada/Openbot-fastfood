import assert from "node:assert/strict";
import test from "node:test";
import { buildAgentInstructions } from "../src/agent/instructionAssembly.js";

test("tenant voice is injected exactly once and remains bounded", () => {
  const marker = "UNIQUE_TENANT_VOICE_MARKER";
  const tenantText = `${marker} ${"restaurant voice ".repeat(100)}`;
  const instructions = buildAgentInstructions({
    instanceId: "prestige",
    text: "Сәлем",
    language: "kk",
    config: { system_prompt: tenantText },
    hardRealtimeContext: {},
    runtimeStatus: null,
    activeShiftNotes: [],
    chatHistory: [],
    shporContext: [],
    menuSnapshot: { items: [] },
  } as any);

  assert.equal(instructions.split(marker).length - 1, 1);
  assert.ok(!instructions.includes("TENANT_INSTRUCTIONS_START"));
  // The bound guards against a runaway prompt, not against a specific number.
  // Raised from 16 000 when getKitchenStatus/getShiftNotes were registered, then
  // from 16 500 for the two rules added after the 2026-08-12 live round (the link
  // never replaces an answer; an unavailable item still gets alternatives), then
  // from 17 000 for the allergen rule (never promise a dish is allergen-free), then
  // from 17 400 for the two-phase escalation contract (the tool reports whether
  // the operator was actually notified or a clarifying question is owed).
  // Each ceiling sits a few hundred chars above the then-current size, so a
  // runaway addition still trips it.
  assert.ok(instructions.length < 17_800, `assembled prompt is unexpectedly large: ${instructions.length}`);
});
