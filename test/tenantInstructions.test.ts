import test from "node:test";
import assert from "node:assert/strict";
import { buildFactsPrompt, tenantInstructionsEntry } from "../src/context/buildFactsPrompt.js";

function ctx(config: Record<string, any>) {
  return {
    instanceId: "test_tenant",
    language: "ru",
    config,
    chatHistory: [],
    shporContext: [],
    activeShiftNotes: [],
    customerProfile: null,
    thinking: null,
    activeGoal: null,
    proactiveSignals: null,
  } as any;
}

test("a tenant prompt in the config reaches the model as tenant_instructions", () => {
  const out = buildFactsPrompt(ctx({ bot_prompt: "Отвечай только официально, без ты." }));
  assert.ok(out.includes("tenant_instructions"));
  assert.ok(out.includes("Отвечай только официально"));
  assert.ok(out.includes("restaurant owner's own special standing instructions"));
});

test("without a tenant prompt the block is absent entirely", () => {
  const out = buildFactsPrompt(ctx({ brand: "Test" }));
  assert.ok(!out.includes("tenant_instructions"));
});

test("field fallback order prefers system_prompt over prompt", () => {
  const entry = tenantInstructionsEntry({ system_prompt: "FIRST", prompt: "SECOND" }) as any;
  assert.equal(entry.tenant_instructions.text, "FIRST");
  const entry2 = tenantInstructionsEntry({ restaurantPrompt: "SECOND", prompt: "THIRD" }) as any;
  assert.equal(entry2.tenant_instructions.text, "SECOND");
});

test("the tenant prompt is capped so one restaurant cannot flood the context", () => {
  const entry = tenantInstructionsEntry({ bot_prompt: "x".repeat(5000) }) as any;
  assert.ok(entry.tenant_instructions.text.length <= 600);
});

test("whitespace-only prompts are treated as absent", () => {
  assert.deepEqual(tenantInstructionsEntry({ bot_prompt: "   \n  " }), {});
});

test("tenant isolation is untouched: only this tenant's config is read", () => {
  const out = buildFactsPrompt(ctx({ bot_prompt: "SECRET_RULE_1" }));
  const other = buildFactsPrompt(ctx({ bot_prompt: "SECRET_RULE_2" }));
  assert.ok(out.includes("SECRET_RULE_1") && !out.includes("SECRET_RULE_2"));
  assert.ok(other.includes("SECRET_RULE_2") && !other.includes("SECRET_RULE_1"));
});
