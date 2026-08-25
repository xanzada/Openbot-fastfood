import assert from "node:assert/strict";
import test from "node:test";
import { sanitizeWorkspace } from "../src/services/llmWorkspace.service.js";

test("the workspace sanitizer keeps only complete, deduped entries in order", () => {
  const pools = sanitizeWorkspace({
    text: [
      { name: "DeepSeek тегін", provider: "openrouter", model: "deepseek/deepseek-chat", key: "sk-1" },
      { name: "көшірме", provider: "openrouter", model: "deepseek/deepseek-chat", key: "sk-1" },
      { model: "no-key-here" },
      { name: "Gemini резерв", provider: "gemini", model: "google/gemini-2.5-flash", key: " g sk-2 " },
    ],
    media: [
      { name: "Gemini 1", provider: "gemini", model: "gemini-2.5-flash", key: "AIza1" },
      { name: "Gemini 2", provider: "GEMINI", model: "gemini-2.5-flash", key: "AIza2" },
      { name: "ақылы резерв", provider: "openrouter", model: "google/gemini-3.6", key: "sk-3" },
      "junk",
      { name: "модельі жоқ", provider: "gemini", key: "AIza4" },
    ],
  });

  assert.equal(pools.text.length, 2);
  assert.equal(pools.text[0].name, "DeepSeek тегін");
  assert.equal(pools.text[1].provider, "gemini");
  assert.equal(pools.text[1].key, "gsk-2");

  assert.equal(pools.media.length, 3);
  assert.equal(pools.media[0].provider, "gemini");
  // Unknown casing still normalises to a known provider.
  assert.equal(pools.media[1].provider, "gemini");
});

test("an empty or malformed workspace means 'not configured', never a broken pool", () => {
  assert.deepEqual(sanitizeWorkspace(null), { text: [], media: [] });
  assert.deepEqual(sanitizeWorkspace({ text: "oops" }), { text: [], media: [] });
  const pools = sanitizeWorkspace({ text: [{ provider: "openrouter", model: "m", key: "k" }] });
  assert.equal(pools.media.length, 0);
});
