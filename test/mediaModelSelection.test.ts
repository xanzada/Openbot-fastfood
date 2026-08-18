import test from "node:test";
import assert from "node:assert/strict";
import { getMediaPrimaryModel } from "../src/services/llm.service.js";

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
