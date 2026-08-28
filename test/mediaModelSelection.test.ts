import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { getMediaPrimaryModel, normalizeGeminiMediaModel } from "../src/services/llm.service.js";

const MODEL_ENV_NAMES = ["MEDIA_PRIMARY_MODEL", "GEMINI_MEDIA_MODEL", "GEMINI_MODEL"] as const;

function withModelEnv(values: Partial<Record<(typeof MODEL_ENV_NAMES)[number], string>>, run: () => void) {
  const previous = Object.fromEntries(MODEL_ENV_NAMES.map((name) => [name, process.env[name]]));
  try {
    for (const name of MODEL_ENV_NAMES) delete process.env[name];
    for (const [name, value] of Object.entries(values)) process.env[name] = value;
    run();
  } finally {
    for (const name of MODEL_ENV_NAMES) {
      const value = previous[name];
      if (value === undefined) delete process.env[name];
      else process.env[name] = value;
    }
  }
}

test("media defaults to Google's current audio-capable Flash model", () => {
  withModelEnv({}, () => assert.equal(getMediaPrimaryModel(), "gemini-3.6-flash"));
});

test("a retired Gemini 2.5 media override is upgraded instead of breaking every voice note", () => {
  withModelEnv({ MEDIA_PRIMARY_MODEL: "gemini-2.5-flash" }, () => {
    assert.equal(getMediaPrimaryModel(), "gemini-3.6-flash");
  });
  withModelEnv({ GEMINI_MEDIA_MODEL: "gemini-2.5-flash-lite" }, () => {
    assert.equal(getMediaPrimaryModel(), "gemini-3.6-flash");
  });
});

test("an explicitly configured non-retired media model is preserved", () => {
  withModelEnv({ MEDIA_PRIMARY_MODEL: "gemini-3.5-flash" }, () => {
    assert.equal(getMediaPrimaryModel(), "gemini-3.5-flash");
  });
});

// The env lane has normalised retired models since they were retired; the panel's
// key pool did not, and each workspace entry carries its own hand-typed model. On
// 2026-08-28 five of six Gemini entries answered "models/gemini-2.5-flash is no
// longer available to new users" on every receipt, and the chain fell through to an
// env reserve the key migration had already emptied.
test("the same normalisation is available to the panel's key pool", () => {
  assert.equal(normalizeGeminiMediaModel("gemini-2.5-flash"), "gemini-3.6-flash");
  assert.equal(normalizeGeminiMediaModel("models/gemini-2.5-flash"), "gemini-3.6-flash");
  assert.equal(normalizeGeminiMediaModel("GEMINI-2.5-FLASH-LITE"), "gemini-3.6-flash");
  assert.equal(normalizeGeminiMediaModel("gemini-1.5-flash"), "gemini-3.6-flash");
  // A current model, and any model we do not know about, passes through untouched.
  assert.equal(normalizeGeminiMediaModel("gemini-3.6-flash"), "gemini-3.6-flash");
  assert.equal(normalizeGeminiMediaModel("gemini-4-experimental"), "gemini-4-experimental");
  assert.equal(normalizeGeminiMediaModel(""), "");
});

// The whole point of the chain is that no single failure ends the turn. A media
// call must try every workspace entry, then the pro pool, then the env keys - and
// when the env reserve has no key at all it must report what actually failed
// instead of OPENROUTER_API_KEY_NOT_CONFIGURED, which was the least useful line in
// the chain and the one that paged the owner (2026-08-28).
test("every media channel is attempted, and the last-resort error names the real failures", async () => {
  const source = await readFile(new URL("../src/services/llm.service.ts", import.meta.url), "utf8");
  const fn = source.slice(source.indexOf("export async function generateMediaText"));

  assert.match(fn, /const failures: string\[\] = \[\]/);
  assert.match(fn, /normalizeGeminiMediaModel\(entry\.model\)/);
  assert.match(fn, /failures\.push\(`\$\{entry\.name\}/);
  assert.match(fn, /MEDIA_ALL_CHANNELS_FAILED/);
  // Two guards, both required: the reserve is only called when it actually has a key.
  assert.equal((fn.match(/if \(!openRouterKey\)|if \(openRouterKey\)/g) || []).length, 2);
});
