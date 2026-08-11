import assert from "node:assert/strict";
import test from "node:test";
import { FAST_FOOD_SKILL_NAMES } from "../src/skills/index.js";
import { isRuntimeWatchEnabled, runtimeWatchIntervalMs } from "../src/cron/runtimeWatch.js";

// getKitchenStatus and getShiftNotes existed in runtimeStatus.skill.ts but were
// never put in the registry, so the agent physically could not re-check the
// kitchen or the operator's notes and answered from a boot-time snapshot.
test("the live kitchen and shift-note tools are registered", () => {
  assert.ok(FAST_FOOD_SKILL_NAMES.includes("getKitchenStatus" as never));
  assert.ok(FAST_FOOD_SKILL_NAMES.includes("getShiftNotes" as never));
});

test("skill names are unique", () => {
  assert.equal(new Set(FAST_FOOD_SKILL_NAMES).size, FAST_FOOD_SKILL_NAMES.length);
});

test("the watcher is on by default and can only be turned off explicitly", () => {
  assert.equal(isRuntimeWatchEnabled({} as NodeJS.ProcessEnv), true);
  assert.equal(isRuntimeWatchEnabled({ RUNTIME_WATCH_ENABLED: "off" } as any), false);
  assert.equal(isRuntimeWatchEnabled({ RUNTIME_WATCH_ENABLED: "true" } as any), true);
  assert.equal(isRuntimeWatchEnabled({ RUNTIME_WATCH_ENABLED: "typo" } as any), true);
});

test("the watch interval never drops below the floor that protects a 2-vCPU box", () => {
  assert.equal(runtimeWatchIntervalMs({} as NodeJS.ProcessEnv), 45_000);
  assert.equal(runtimeWatchIntervalMs({ RUNTIME_WATCH_INTERVAL_MS: "60000" } as any), 60_000);
  assert.equal(runtimeWatchIntervalMs({ RUNTIME_WATCH_INTERVAL_MS: "100" } as any), 15_000);
  assert.equal(runtimeWatchIntervalMs({ RUNTIME_WATCH_INTERVAL_MS: "nonsense" } as any), 45_000);
});
