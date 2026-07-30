import test from "node:test";
import assert from "node:assert/strict";
import { resolveShiftNoteTtlSeconds } from "../src/services/redis.service.js";

const NOW = Date.parse("2026-07-30T12:00:00Z");
const DAY = 24 * 60 * 60;

test("a Unix timestamp in SECONDS gets its real TTL, not the 24h fallback", () => {
  const expiresAtSec = Math.floor((NOW + 2 * 3600_000) / 1000);
  const ttl = resolveShiftNoteTtlSeconds(String(expiresAtSec), NOW);
  assert.ok(ttl > 7000 && ttl <= 7200, `expected ~2h, got ${ttl}`);
});

test("a Unix timestamp in MILLISECONDS also works", () => {
  const ttl = resolveShiftNoteTtlSeconds(String(NOW + 3600_000), NOW);
  assert.ok(ttl > 3500 && ttl <= 3600, `expected ~1h, got ${ttl}`);
});

test("an ISO datetime string works", () => {
  const ttl = resolveShiftNoteTtlSeconds("2026-07-31T12:00:00Z", NOW);
  assert.equal(ttl, DAY);
});

test("a past expiry falls back to the default instead of dying instantly", () => {
  assert.equal(resolveShiftNoteTtlSeconds("2020-01-01T00:00:00Z", NOW), DAY);
  assert.equal(resolveShiftNoteTtlSeconds(String(Math.floor(NOW / 1000) - 100), NOW), DAY);
});

test("empty or garbage input gets the default TTL", () => {
  assert.equal(resolveShiftNoteTtlSeconds(undefined, NOW), DAY);
  assert.equal(resolveShiftNoteTtlSeconds("", NOW), DAY);
  assert.equal(resolveShiftNoteTtlSeconds("not-a-date", NOW), DAY);
});

test("a very near expiry is clamped to at least 60 seconds", () => {
  const ttl = resolveShiftNoteTtlSeconds(String(Math.floor((NOW + 5_000) / 1000)), NOW);
  assert.ok(ttl >= 60);
});
