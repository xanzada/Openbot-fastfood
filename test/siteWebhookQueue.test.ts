import test from "node:test";
import assert from "node:assert/strict";
import { createSiteWebhookQueue, type SiteWebhookJob, type SiteWebhookStore } from "../src/services/siteWebhookQueue.service.js";

function fixture() {
  let clock = 1_000_000;
  const jobs = new Map<string, SiteWebhookJob>();
  const done = new Set<string>();
  const leases = new Map<string, string>();
  const lane = (job: SiteWebhookJob) => `${job.body.instance}/${job.body.order_id}`;
  const store: SiteWebhookStore = {
    async put(job) { if (jobs.has(job.id) || done.has(job.id)) return false; jobs.set(job.id, structuredClone(job)); return true; },
    async due(now, limit) { return [...jobs.values()].filter(j => j.nextAttemptAt <= now).slice(0, limit).map(j => structuredClone(j)); },
    async claim(job, token) { if (leases.has(lane(job))) return false; leases.set(lane(job), token); return true; },
    async renew() {},
    async finish(job, token) { assert.equal(leases.get(lane(job)), token); leases.delete(lane(job)); jobs.delete(job.id); done.add(job.id); },
    async retry(job, token) { assert.equal(leases.get(lane(job)), token); leases.delete(lane(job)); jobs.set(job.id, structuredClone(job)); },
  };
  return { jobs, done, store, now: () => clock, advance: (ms: number) => { clock += ms; } };
}
const event = (instance = "audit-resto", event_id = "event-A", order_id = "123") => ({ instance, event_id, order_id, action: "new_order" });

test("acceptance persists first and does not wait for the order processor", async () => {
  const f = fixture(); let calls = 0;
  const queue = createSiteWebhookQueue({ store: f.store, now: f.now, process: async () => { calls++; return { status: 200 }; } });
  const accepted = await queue.enqueue(event());
  assert.equal(accepted.inserted, true); assert.equal(f.jobs.size, 1); assert.equal(calls, 0);
  assert.equal((await queue.drain()).processed, 1); assert.equal(calls, 1);
});

test("persistence failure cannot acknowledge and lose an event", async () => {
  const f = fixture(); f.store.put = async () => { throw new Error("storage unavailable"); };
  const queue = createSiteWebhookQueue({ store: f.store, process: async () => ({ status: 200 }) });
  await assert.rejects(queue.enqueue(event()), /storage unavailable/); assert.equal(f.jobs.size, 0);
});

test("duplicate webhook retries process once, while tenant event ids stay isolated", async () => {
  const f = fixture(); let calls = 0;
  const queue = createSiteWebhookQueue({ store: f.store, now: f.now, process: async () => { calls++; return { status: 200 }; } });
  assert.equal((await queue.enqueue(event())).inserted, true);
  assert.equal((await queue.enqueue(event())).inserted, false);
  assert.equal((await queue.enqueue(event("other-resto"))).inserted, true);
  await queue.drain(); assert.equal(calls, 2);
  assert.equal((await queue.enqueue(event())).inserted, false); await queue.drain(); assert.equal(calls, 2);
});

test("503 retries at 2s, 5s, 10s and stops only after processing succeeds", async () => {
  const f = fixture(); let calls = 0;
  const queue = createSiteWebhookQueue({ store: f.store, now: f.now, process: async () => ({ status: ++calls <= 3 ? 503 : 200 }) });
  await queue.enqueue(event());
  for (const delay of [2_000, 5_000, 10_000]) {
    await queue.drain(); assert.equal(f.jobs.size, 1);
    assert.equal([...f.jobs.values()][0]!.nextAttemptAt - f.now(), delay);
    f.advance(delay - 1); await queue.drain(); assert.equal(f.jobs.size, 1); f.advance(1);
  }
  await queue.drain(); assert.equal(calls, 4); assert.equal(f.jobs.size, 0); assert.equal(f.done.size, 1);
});

test("fresh payment unavailable plus 200 retry_later remains durable pending", async () => {
  const f = fixture(); const queue = createSiteWebhookQueue({ store: f.store, now: f.now, process: async () => ({ status: 200, retryLater: true }) });
  await queue.enqueue({ ...event(), action: "request_payment" });
  assert.equal((await queue.drain()).processed, 0); assert.equal(f.jobs.size, 1); assert.equal(f.done.size, 0);
});

test("a replacement worker recovers events persisted before the process stopped", async () => {
  const f = fixture();
  const before = createSiteWebhookQueue({ store: f.store, now: f.now, process: async () => { throw new Error("must not execute"); } });
  await before.enqueue(event());
  let calls = 0;
  const after = createSiteWebhookQueue({ store: f.store, now: f.now, process: async () => { calls++; return { status: 200 }; } });
  await after.drain(); assert.equal(calls, 1); assert.equal(f.jobs.size, 0);
});

test("same-order events serialize while an unrelated order remains independent", async () => {
  const f = fixture(); const active = new Set<string>(); let overlap = false; let calls = 0;
  const queue = createSiteWebhookQueue({ store: f.store, now: f.now, process: async body => {
    const id = String(body.order_id); if (active.has(id)) overlap = true; active.add(id); calls++;
    await new Promise(resolve => setImmediate(resolve)); active.delete(id); return { status: 200 };
  } });
  await queue.enqueue(event("audit-resto", "event-A", "123")); await queue.enqueue(event("audit-resto", "event-B", "123"));
  await queue.enqueue(event("audit-resto", "event-C", "124"));
  await queue.drain(); await queue.drain(); assert.equal(overlap, false); assert.equal(calls, 3);
});

test("invalid instance/order/action cannot enter a persistent accepted queue", async () => {
  const f = fixture(); const queue = createSiteWebhookQueue({ store: f.store, process: async () => ({ status: 200 }) });
  for (const body of [{ ...event(), instance: "../bad" }, { ...event(), order_id: "0" }, { ...event(), action: "fake_order" }]) {
    await assert.rejects(queue.enqueue(body), /BAD_/);
  }
  assert.equal(f.jobs.size, 0);
});

test("durable payload does not retain verified request credentials", async () => {
  const f = fixture(); const queue = createSiteWebhookQueue({ store: f.store, process: async () => ({ status: 200 }) });
  await queue.enqueue({ ...event(), tenant_secret: "fixture-secret", token: "fixture-token", alemi_secret: "fixture-alemi" });
  const saved = [...f.jobs.values()][0]!;
  assert.equal(saved.body.tenant_secret, undefined); assert.equal(saved.body.token, undefined);
  assert.equal(saved.body.alemi_secret, undefined); assert.equal(saved.body.order_id, "123");
});

test("later retries back off without abandoning the confirmed site event", async () => {
  const f = fixture(); const queue = createSiteWebhookQueue({ store: f.store, now: f.now, process: async () => ({ status: 503 }) });
  await queue.enqueue(event());
  for (const delay of [2000, 5000, 10000, 20000, 40000]) {
    await queue.drain();
    assert.equal([...f.jobs.values()][0]!.nextAttemptAt - f.now(), delay);
    f.advance(delay);
  }
  assert.equal(f.done.size, 0); assert.equal(f.jobs.size, 1);
});
