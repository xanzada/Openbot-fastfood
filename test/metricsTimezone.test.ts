import assert from "node:assert/strict";
import test from "node:test";
import { metricsDayKey, metricsKey } from "../src/services/metrics.service.js";

test("early-morning Almaty metrics are stored under the restaurant's local day", () => {
  const instant = new Date("2026-09-09T20:30:00Z");
  assert.equal(metricsDayKey(instant, "Asia/Almaty"), "20260910");
  assert.equal(metricsDayKey(instant, "UTC"), "20260909");
  assert.equal(metricsKey("prestige", metricsDayKey(instant, "Asia/Almaty")), "metrics:prestige:20260910");
});
