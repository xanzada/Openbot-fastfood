import test from "node:test";
import assert from "node:assert/strict";
import { redisClient } from "../src/services/redis.service.js";
import { claimInboundEvent } from "../src/controllers/kanban.js";

// docs/integration/site-integration.md promises the site can retry a failed
// delivery because the bot filters duplicates by `event_id`. Nothing in the code
// read that field: the only guard was `kanban_lock:<instance>:<order>:<action>`,
// which happens to cover a retry of an order event and covers nothing for a
// signal that carries no order id. These tests pin the promise itself.
const store = new Map<string, string>();

Object.defineProperty(redisClient, "isOpen", { get: () => true, configurable: true });
(redisClient as any).connect = async () => undefined;
(redisClient as any).set = async (key: string, value: string, options?: { NX?: boolean }) => {
  if (options?.NX && store.has(key)) return null;
  store.set(key, value);
  return "OK";
};
(redisClient as any).del = async (key: string) => (store.delete(key) ? 1 : 0);

test("the same event_id is claimed once and refused the second time", async () => {
  store.clear();
  const first = await claimInboundEvent("prestige", "evt-1");
  assert.equal(first.claimed, true);
  assert.equal(first.key, "kanban_event_lock:prestige:evt-1");

  const retry = await claimInboundEvent("prestige", "evt-1");
  assert.equal(retry.claimed, false);
  // A refused claim must not hand back a key: releasing it on failure would
  // delete the lock held by the delivery that is still being processed.
  assert.equal(retry.key, "");
  assert.equal(retry.eventId, "evt-1");
});

test("one tenant's event_id never blocks another tenant's", async () => {
  store.clear();
  assert.equal((await claimInboundEvent("prestige", "evt-9")).claimed, true);
  assert.equal((await claimInboundEvent("other-resto", "evt-9")).claimed, true);
  assert.equal([...store.keys()].length, 2);
});

test("a signal with no event_id is claimed trivially and holds no key", async () => {
  store.clear();
  for (const value of [undefined, null, "", "   "]) {
    const claim = await claimInboundEvent("prestige", value);
    assert.equal(claim.claimed, true);
    assert.equal(claim.key, "");
    assert.equal(claim.eventId, "");
  }
  assert.equal(store.size, 0);
});

test("a released claim can be retried, which is what a failed delivery needs", async () => {
  store.clear();
  const claim = await claimInboundEvent("prestige", "evt-fail");
  assert.equal(claim.claimed, true);
  await redisClient.del(claim.key);
  assert.equal((await claimInboundEvent("prestige", "evt-fail")).claimed, true);
});
