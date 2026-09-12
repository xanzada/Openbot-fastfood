import assert from "node:assert/strict";
import test from "node:test";
import {
  classifyProviderError,
  clearProviderHealthForTests,
  noteProviderOutcome,
  providersForRequest,
} from "../src/services/llmProviderHealth.service.js";
import type { LlmKeyEntry } from "../src/services/llmWorkspace.service.js";

const entry = (name: string, status: any = "unknown"): LlmKeyEntry => ({
  id: `id_${name}`,
  name,
  type: "openai",
  baseUrl: `https://${name}.example/v1`,
  model: `model-${name}`,
  key: `key-${name}`,
  health: { status },
});

test.afterEach(() => clearProviderHealthForTests());

test("healthy-first order skips providers already known to be unavailable", () => {
  const unavailable = entry("down", "unavailable");
  const healthy = entry("up", "healthy");
  const unknown = entry("new", "unknown");
  assert.deepEqual(providersForRequest([unavailable, unknown, healthy], "text").map((item) => item.name), ["up", "new"]);
});

test("a runtime failure opens the local circuit and the next request skips immediately", () => {
  const failed = entry("failed");
  const reserve = entry("reserve");
  noteProviderOutcome({ entry: failed, pool: "media", ok: false, latencyMs: 400, error: new Error("OPENAI_COMPATIBLE_402 billing") });
  assert.deepEqual(providersForRequest([failed, reserve], "media").map((item) => item.name), ["reserve"]);
});

test("transient failures are skipped during cooldown and an all-bad workspace returns no chain", () => {
  const transient = entry("transient");
  const unavailable = entry("unavailable", "unavailable");
  noteProviderOutcome({ entry: transient, pool: "media", ok: false, latencyMs: 2500, error: new Error("HTTP 503 service unavailable") });
  assert.deepEqual(providersForRequest([transient, unavailable], "media"), []);
});

test("provider errors are reduced to safe operational categories", () => {
  assert.equal(classifyProviderError(new Error("HTTP 401 unauthorized")), "AUTH_INVALID");
  assert.equal(classifyProviderError(new Error("Daily check-in required to use free models")), "QUOTA_UNAVAILABLE");
  assert.equal(classifyProviderError(new Error("HTTP 503 service unavailable")), "PROVIDER_UNAVAILABLE");
  assert.equal(classifyProviderError(new Error("request timeout")), "TIMEOUT");
});
