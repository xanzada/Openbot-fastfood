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
  // Raised from 16 000 when getKitchenStatus/getShiftNotes were registered: two
  // more tool descriptions are ~250 chars, and the old ceiling sat ~60 chars above
  // the then-current size, so any real addition would have tripped it.
  assert.ok(instructions.length < 16_500, `assembled prompt is unexpectedly large: ${instructions.length}`);
});
