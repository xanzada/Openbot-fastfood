import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

process.env.REDIS_URL = "redis://127.0.0.1:1";
process.env.REDIS_CONNECT_TIMEOUT_MS = "500";
process.env.REDIS_OPERATION_TIMEOUT_MS = "500";

const { redisClient } = await import("../src/services/redis.service.js");
test.after(() => {
  if (redisClient.isOpen) redisClient.destroy();
});

const guard = await import("../src/services/inboundGuard.service.js");
const read = (relative: string) => readFile(new URL(relative, import.meta.url), "utf8");

// B31, found 2026-08-23. Both halves end the same way: one guest, two replies - from the
// code whose whole job is to prevent that.

test("the lock outlives the longest turn the budgets allow", async () => {
  const source = await read("../src/services/inboundGuard.service.ts");
  // 90s was a magic number, and a turn can spend far more: the route waits up to 45s for a
  // previous turn, the buffer settles, the agent runs to REGEN_BUDGET_MS, and the send
  // sequence retries per chunk on a 10s axios timeout. The TTL is now derived from those
  // same budgets, so raising one cannot silently un-protect the lock.
  assert.match(source, /const TURN_WAIT_CEILING_MS = 45_000;/);
  assert.match(source, /const TURN_SEND_CEILING_MS = 60_000;/);
  assert.match(source, /TURN_WAIT_CEILING_MS\s*\n?\s*\+ INBOUND_BUFFER_DELAY_MS/);
  assert.match(source, /envNumber\(process\.env\.REGEN_BUDGET_MS, 38_000/);
  // And it can never regress below the old value.
  assert.match(source, /Math\.max\(\s*\n?\s*90_000,/);
});

test("releasing the lock is a single compare-and-delete", async () => {
  const source = await read("../src/services/inboundGuard.service.ts");
  // GET then DEL leaves a window: the lock expires, the next turn acquires it, and this
  // turn's comparison has already passed - so it deletes a lock it no longer owns and the
  // next turn runs unprotected.
  assert.match(source, /const RELEASE_TURN_LOCK_LUA =/);
  assert.match(source, /redis\.call\('get', KEYS\[1\]\) == ARGV\[1\]/);
  assert.match(source, /redisClient\.eval\(RELEASE_TURN_LOCK_LUA, \{ keys: \[key\], arguments: \[owner\] \}\)/);
});

test("a Redis that refuses EVAL still releases the lock", async () => {
  const source = await read("../src/services/inboundGuard.service.ts");
  const fn = source.slice(source.indexOf("export async function releaseTurnLock"));
  const body = fn.slice(0, fn.indexOf("\n}"));
  // Not releasing at all would hold the conversation for the whole TTL, which is worse
  // than the race the fallback carries.
  assert.match(body, /turn lock EVAL unavailable/);
  assert.match(body, /const current = await redisClient\.get\(key\);/);
  assert.match(body, /if \(current === owner\) await redisClient\.del\(key\);/);
});

test("the in-memory fallback still grants exactly one owner at a time", async () => {
  // This suite runs with Redis unreachable, so these are the real local-fallback paths -
  // the ones that matter during an outage, when double replies are least acceptable.
  const first = await guard.acquireTurnLock("b31-probe", "77000000000");
  assert.ok(first, "the first caller must get the lock");
  const second = await guard.acquireTurnLock("b31-probe", "77000000000");
  assert.equal(second, null, "a second caller must be refused while the turn runs");
  await guard.releaseTurnLock("b31-probe", "77000000000", first as string);
  const third = await guard.acquireTurnLock("b31-probe", "77000000000");
  assert.ok(third, "after release the next turn may proceed");
  await guard.releaseTurnLock("b31-probe", "77000000000", third as string);
});

test("a foreign owner cannot release someone else's lock", async () => {
  const owner = await guard.acquireTurnLock("b31-foreign", "77000000001");
  assert.ok(owner);
  // A stale turn finishing late must not free the lock the current turn is holding.
  await guard.releaseTurnLock("b31-foreign", "77000000001", "not-the-owner");
  assert.equal(await guard.acquireTurnLock("b31-foreign", "77000000001"), null, "the lock must still be held");
  await guard.releaseTurnLock("b31-foreign", "77000000001", owner as string);
  const next = await guard.acquireTurnLock("b31-foreign", "77000000001");
  assert.ok(next, "the real owner can still release it");
  await guard.releaseTurnLock("b31-foreign", "77000000001", next as string);
});
