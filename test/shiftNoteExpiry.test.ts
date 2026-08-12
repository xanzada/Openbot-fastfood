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

// An operator who set the expiry to a time that has already passed said the note
// is over. Giving it the 24h default kept an expired note alive for a whole day,
// so the bot quoted a constraint the shift had already lifted (audit,
// 2026-08-12). A readable past expiry now means "do not store it at all".
test("a past expiry is honoured, not turned into a fresh 24 hours", () => {
  assert.equal(resolveShiftNoteTtlSeconds("2020-01-01T00:00:00Z", NOW), 0);
  assert.equal(resolveShiftNoteTtlSeconds(String(Math.floor(NOW / 1000) - 100), NOW), 0);
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
