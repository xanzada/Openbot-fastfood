import assert from "node:assert/strict";
import test from "node:test";
import { sanitizeWorkspace } from "../src/services/llmWorkspace.service.js";

test("the workspace sanitizer keeps only complete, deduped entries in order", () => {
  const pools = sanitizeWorkspace({
    text: [
      { name: "DeepSeek тегін", type: "openai", baseUrl: "https://api.deepseek.com/v1", model: "deepseek-chat", key: "sk-1" },
      { name: "көшірме", type: "openai", baseUrl: "https://api.deepseek.com/v1", model: "deepseek-chat", key: "sk-1" },
      { model: "no-key-here" },
      { name: "Gemini резерв", provider: "gemini", model: "google/gemini-2.5-flash", key: " g sk-2 " },
    ],
    media: [
      { name: "Gemini 1", type: "gemini", model: "gemini-2.5-flash", key: "AIza1" },
      { name: "Gemini 2", type: "GEMINI", model: "gemini-2.5-flash", key: "AIza2" },
      { name: "ақылы резерв", type: "openai", baseUrl: "https://openrouter.ai/api/v1/", model: "google/gemini-3.6", key: "sk-3" },
      "junk",
      { name: "модельі жоқ", type: "gemini", key: "AIza4" },
    ],
  });

  assert.equal(pools.text.length, 2);
  assert.equal(pools.text[0].name, "DeepSeek тегін");
  assert.equal(pools.text[0].baseUrl, "https://api.deepseek.com/v1");
  // Legacy provider=gemini maps onto the Google base URL.
  assert.equal(pools.text[1].type, "gemini");
  assert.equal(pools.text[1].baseUrl, "https://generativelanguage.googleapis.com/v1beta");
  assert.equal(pools.text[1].key, "gsk-2");

  assert.equal(pools.media.length, 3);
  assert.equal(pools.media[0].type, "gemini");
  assert.equal(pools.media[0].baseUrl, "https://generativelanguage.googleapis.com/v1beta");
  // Trailing slash is trimmed, casing normalised.
  assert.equal(pools.media[1].type, "gemini");
  assert.equal(pools.media[2].baseUrl, "https://openrouter.ai/api/v1");
});

test("runtime identity and sanitized provider health survive the workspace poll", () => {
  const pools = sanitizeWorkspace({
    text: [{
      id: "llm_text_1",
      name: "Primary",
      type: "openai",
      baseUrl: "https://provider.example/v1",
      model: "model-1",
      key: "secret",
      enabled: true,
      health: { status: "healthy", lastCheckedAt: "2026-09-11T12:00:00Z", latencyMs: 123, errorCode: null },
    }],
  });
  assert.equal(pools.text[0].id, "llm_text_1");
  assert.equal(pools.text[0].enabled, true);
  assert.deepEqual(pools.text[0].health, {
    status: "healthy",
    lastCheckedAt: "2026-09-11T12:00:00Z",
    latencyMs: 123,
    errorCode: null,
  });
});

test("an empty or malformed workspace means 'not configured', never a broken pool", () => {
  assert.deepEqual(sanitizeWorkspace(null), { text: [], media: [] });
  assert.deepEqual(sanitizeWorkspace({ text: "oops" }), { text: [], media: [] });
  const pools = sanitizeWorkspace({ text: [{ type: "openai", model: "m", key: "k" }] });
  assert.equal(pools.media.length, 0);
  // A missing base URL falls back to the OpenRouter lane, not to garbage.
  assert.equal(pools.text[0].baseUrl, "https://openrouter.ai/api/v1");
});
