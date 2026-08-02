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
  assert.ok(instructions.length < 16_000, `assembled prompt is unexpectedly large: ${instructions.length}`);
});
