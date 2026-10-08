import test from "node:test";
import assert from "node:assert/strict";
import crypto from "node:crypto";
import { redisClient, connectRedis } from "../src/services/redis.service.js";
import { createSiteWebhookQueue, redisSiteWebhookStore } from "../src/services/siteWebhookQueue.service.js";

test("real Redis persists a failed event for a replacement worker and deduplicates completion", { skip: process.env.AUDIT_REDIS_INTEGRATION !== "1" }, async () => {
  await connectRedis();
  let clock = Date.now(); let firstCalls = 0;
  const instance = `audit-${crypto.randomBytes(3).toString("hex")}`;
  const body = { instance, action: "new_order", order_id: "123", event_id: crypto.randomUUID() };
  const before = createSiteWebhookQueue({ store: redisSiteWebhookStore, now: () => clock, process: async () => { firstCalls++; return { status: 503 }; } });
  const accepted = await before.enqueue(body);
  assert.equal(accepted.inserted, true);
  assert.equal((await before.drain()).processed, 0);
  const pending = JSON.parse((await redisClient.get(`site_webhook:job:${accepted.id}`))!);
  assert.equal(pending.attempts, 1); assert.equal(pending.nextAttemptAt - clock, 2_000);
  clock += 2_000; let replacementCalls = 0;
  const after = createSiteWebhookQueue({ store: redisSiteWebhookStore, now: () => clock, process: async payload => {
    replacementCalls++; assert.equal(payload.instance, instance); return { status: 200 };
  } });
  assert.equal((await after.drain()).processed, 1);
  assert.equal(firstCalls, 1); assert.equal(replacementCalls, 1);
  const completed = JSON.parse((await redisClient.get(`site_webhook:job:${accepted.id}`))!);
  assert.equal(completed.status, "processed"); assert.equal(completed.body, undefined);
  assert.equal((await after.enqueue(body)).inserted, false);
  await after.drain(); assert.equal(replacementCalls, 1);
});

test("real Redis order lease prevents competing processors and fences a stale owner", { skip: process.env.AUDIT_REDIS_INTEGRATION !== "1" }, async () => {
  await connectRedis();
  const now = Date.now(); const instance = `audit-${crypto.randomBytes(3).toString("hex")}`;
  const body = { instance, action: "new_order", order_id: "124", event_id: crypto.randomUUID() };
  const queue = createSiteWebhookQueue({ store: redisSiteWebhookStore, now: () => now, process: async () => ({ status: 200 }) });
  const accepted = await queue.enqueue(body);
  const job = (await redisSiteWebhookStore.due(now, 24)).find(j => j.id === accepted.id)!;
  assert.equal(await redisSiteWebhookStore.claim(job, "owner-A"), true);
  assert.equal(await redisSiteWebhookStore.claim(job, "owner-B"), false);
  const lane = crypto.createHash("sha256").update(JSON.stringify([instance, body.order_id])).digest("hex");
  await redisClient.set(`site_webhook:lane:${lane}`, "owner-B", { PX: 20_000 });
  await assert.rejects(redisSiteWebhookStore.finish(job, "owner-A"), /LEASE_LOST/);
  assert.equal(JSON.parse((await redisClient.get(`site_webhook:job:${accepted.id}`))!).body.instance, instance);
  await redisSiteWebhookStore.finish(job, "owner-B");
});

test("real Redis quarantines one broken record without blocking healthy orders", { skip: process.env.AUDIT_REDIS_INTEGRATION !== "1" }, async () => {
  await connectRedis();
  const bad = crypto.randomBytes(32).toString("hex");
  await redisClient.set("site_webhook:job:" + bad, "{broken");
  await redisClient.zAdd("site_webhook:due", [{ score: Date.now()-1000, value: bad }]);
  let calls = 0;
  const q = createSiteWebhookQueue({ store: redisSiteWebhookStore, process: async () => { calls++; return { status: 200 }; } });
  await q.enqueue({ instance: "audit-quarantine", action: "new_order", order_id: "129", event_id: crypto.randomUUID() });
  assert.equal((await q.drain()).processed, 1); assert.equal(calls, 1);
  assert.equal(await redisClient.zScore("site_webhook:due", bad), null);
  assert.notEqual(await redisClient.zScore("site_webhook:quarantine", bad), null);
  assert.equal(await redisClient.get("site_webhook:job:" + bad), "{broken");
  await redisClient.zRem("site_webhook:quarantine", bad); await redisClient.del("site_webhook:job:" + bad);
});

test.after(async () => { if (redisClient.isOpen) await redisClient.quit(); });

// These controls exercise the actual handler and durable queue. Transport is
// a private Redis-backed ACK stub; no HTTP, WhatsApp, tenant key or provider.
const notificationFixtures: Array<{ instance: string; phone: string; body: { instance: string; action: string; order_id: string; event_id: string; phone: string; lang: string; total_price: number }; key: string; history: string; wal: string; calls: string; jobIds: string[] }> = [];
const siteCrashIntegration = { skip: process.env.AUDIT_REDIS_INTEGRATION !== "1", timeout: 45_000 };

async function notificationFixture() {
  await connectRedis();
  const instance = `audit-crash-${crypto.randomBytes(5).toString("hex")}`;
  const phone = "77000000001";
  const body = { instance, action: "new_order", order_id: "142", event_id: crypto.randomUUID(), phone, lang: "ru", total_price: 2000 };
  await redisClient.set(`config:${instance}`, JSON.stringify({ instance_id: instance, whatspro_base_url: "https://synthetic.invalid", whatspro_api_token: "synthetic-only" }), { EX: 120 });
  const fixture = { instance, phone, body, key: `kanban_lock:${instance}:142:new_order`, history: `history:${instance}:${phone}`, wal: `audit-notification-wal:${instance}`, calls: `audit-notification-calls:${instance}`, jobIds: [] as string[] };
  notificationFixtures.push(fixture); return fixture;
}

async function withNotificationTransport(f: Awaited<ReturnType<typeof notificationFixture>>, run: () => Promise<void>, mode: "accepted" | "unknown" = "accepted") {
  const axios = (await import("axios")).default;
  const originalGet = axios.get;
  const originalPost = axios.post;
  axios.get = (async () => { throw new Error("SYNTHETIC_NETWORK_DENIED"); }) as any;
  axios.post = (async (url: string, payload: any) => {
    if ((f as any).paymentContext && url === "https://synthetic.invalid/v1/integrations/bot/commands") return syntheticPaymentContext(f, payload);
    assert.equal(url, "https://synthetic.invalid/api/send");
    assert.equal(payload.instanceId, f.instance);
    assert.equal(payload.phone, f.phone);
    const digest = crypto.createHash("sha256").update(JSON.stringify([payload.phone, payload.text])).digest("hex");
    const previous = await redisClient.hGet(f.wal, payload.requestId);
    if (previous) {
      const old = JSON.parse(previous);
      assert.equal(old.digest, digest, "recovery uses the first frozen payload under the first ID");
      if (old.unknown) throw new Error("SEND_OUTCOME_UNKNOWN");
      return { status: 200, data: { success: true, messageId: old.messageId, replayed: true } };
    }
    await redisClient.incr(f.calls);
    await redisClient.hSet(f.wal, payload.requestId, JSON.stringify({ digest, messageId: "SYNTHETIC-ACK", unknown: mode === "unknown" }));
    if (mode === "unknown") throw new Error("SEND_OUTCOME_UNKNOWN");
    return { status: 200, data: { success: true, messageId: "SYNTHETIC-ACK" } };
  }) as any;
  try { await run(); } finally { axios.get = originalGet; axios.post = originalPost; }
}

async function invokeActualNotification(body: Record<string, unknown>) {
  const { handleKanbanWebhook } = await import("../src/controllers/kanban.js");
  let status = 200; let payload: any;
  const res: any = { headersSent: false, status(code: number) { status = code; return this; }, json(value: any) { payload = value; this.headersSent = true; return this; } };
  await handleKanbanWebhook({ body, app: { get: () => null } } as any, res);
  return { status, payload, retryLater: payload?.retry_later === true };
}

async function assertPendingQueueJob(f: Awaited<ReturnType<typeof notificationFixture>>, id: string, expectedBody: Record<string, unknown> = f.body) {
  assert.ok(f.jobIds.includes(id), "only this registered synthetic durable job is read");
  const raw = await redisClient.get(`site_webhook:job:${id}`);
  assert.notEqual(raw, null);
  const job = JSON.parse(raw!);
  // Original SiteWebhookJob has no pending status field. Finish alone replaces
  // the persisted event with a processed terminal record and removes its due ID.
  assert.deepEqual(Object.keys(job).sort(), ["attempts", "body", "createdAt", "id", "nextAttemptAt"]);
  assert.equal(job.id, id);
  assert.deepEqual(job.body, JSON.parse(JSON.stringify(expectedBody)));
  assert.ok(Number.isSafeInteger(job.createdAt) && job.createdAt > 0);
  assert.ok(Number.isSafeInteger(job.attempts) && job.attempts >= 0);
  assert.ok(Number.isSafeInteger(job.nextAttemptAt) && job.nextAttemptAt >= job.createdAt);
  assert.equal(await redisClient.zScore("site_webhook:due", id), job.nextAttemptAt);
  assert.equal(await redisClient.ttl(`site_webhook:job:${id}`), -1);
  return job;
}

async function expireOnlyFixtureLeases(f: Awaited<ReturnType<typeof notificationFixture>>) {
  const lane = crypto.createHash("sha256").update(JSON.stringify([f.instance, f.body.order_id])).digest("hex");
  // Model only the expiry of this synthetic processing lease, never erase the
  // durable journal, event claim, customer history or any production key.
  await redisClient.pExpire(`site_webhook:lane:${lane}`, 1);
  await redisClient.pExpire(`${f.key}:processing`, 1);
  await new Promise(resolve => setTimeout(resolve, 30));
}

async function killActualHandlerAt(f: Awaited<ReturnType<typeof notificationFixture>>, phase: "claim" | "accepted" | "ack" | "complete") {
  const { spawn } = await import("node:child_process");
  const source = `
    import axios from 'axios';
    import crypto from 'node:crypto';
    import {redisClient,connectRedis} from './src/services/redis.service.ts';
    import {createSiteWebhookQueue,redisSiteWebhookStore} from './src/services/siteWebhookQueue.service.ts';
    import {handleKanbanWebhook} from './src/controllers/kanban.ts';
    const f=JSON.parse(process.env.AUDIT_NOTIFICATION_FIXTURE);
    const phase=process.env.AUDIT_NOTIFICATION_CRASH_PHASE;
    if(f.fixtureNowMs)Date.now=()=>f.fixtureNowMs;
    async function stop(boundary){if(phase===boundary){process.send({boundary});await new Promise(()=>{});}}
    await connectRedis();
    axios.get=async()=>{throw new Error('SYNTHETIC_NETWORK_DENIED');};
    axios.post=async(url,payload)=>{
      if(f.paymentContext&&url==='https://synthetic.invalid/v1/integrations/bot/commands'){
        const c=typeof payload==='string'?JSON.parse(payload):payload;
        if(c.command!=='order.context.get'||c.instance!==f.instance||String(c.data.order_id)!=='142')throw new Error('SYNTHETIC_CONTEXT_SCOPE_INVALID');
        return{status:200,data:{result:{order:{id:'142',phone:f.phone,status:'pending',payment_timing:'prepay',payment_revision:1,receipt_required:true,total_price:2000}}}};
      }
      if(url!=='https://synthetic.invalid/api/send')throw new Error('SYNTHETIC_NETWORK_DENIED');
      const digest=crypto.createHash('sha256').update(JSON.stringify([payload.phone,payload.text])).digest('hex');
      const previous=await redisClient.hGet(f.wal,payload.requestId);
      if(previous){const p=JSON.parse(previous);if(p.digest!==digest)throw new Error('IDEMPOTENCY_PAYLOAD_MISMATCH');return{status:200,data:{success:true,messageId:p.messageId,replayed:true}};}
      await redisClient.incr(f.calls);
      await redisClient.hSet(f.wal,payload.requestId,JSON.stringify({digest,messageId:'SYNTHETIC-ACK'}));
      await stop('accepted');
      return{status:200,data:{success:true,messageId:'SYNTHETIC-ACK'}};
    };
    const originalSet=redisClient.set.bind(redisClient);
    redisClient.set=async(...args)=>{const r=await originalSet(...args);if(args[0]===f.key&&r)await stop('claim');return r;};
    const originalEval=redisClient.eval.bind(redisClient);
    redisClient.eval=async(script,options)=>{
      const r=await originalEval(script,options);
      if(script.startsWith('-- SITE_NOTIFICATION_CLAIM_V1')&&r[0]==='acquired')await stop('claim');
      if(script.startsWith('-- SITE_NOTIFICATION_UPDATE_V1')&&options.arguments[1]==='ack'&&r[0]==='ok')await stop('ack');
      return r;
    };
    const queue=createSiteWebhookQueue({store:redisSiteWebhookStore,process:async body=>{
      let status=200,payload;
      const res={headersSent:false,status(code){status=code;return this;},json(value){payload=value;this.headersSent=true;return this;}};
      await handleKanbanWebhook({body,app:{get:()=>null}},res);
      await stop('complete');
      return{status,retryLater:payload?.retry_later===true};
    }});
    await queue.drain();process.send({unexpectedCompletion:true});await redisClient.quit();
  `;
  const child = spawn(process.execPath, ["--import", "tsx", "--input-type=module", "-e", source], { cwd: process.cwd(), env: { ...process.env, AUDIT_NOTIFICATION_FIXTURE: JSON.stringify(f), AUDIT_NOTIFICATION_CRASH_PHASE: phase }, stdio: ["ignore", "ignore", "ignore", "ipc"] });
  const closed = new Promise<void>((resolve, reject) => { child.once("exit", () => resolve()); child.once("error", reject); });
  let timer: ReturnType<typeof setTimeout>;
  try {
    const checkpoint = await new Promise<any>((resolve, reject) => {
      timer = setTimeout(() => reject(new Error("CRASH_CHECKPOINT_NOT_REACHED")), 12_000);
      child.once("message", resolve); child.once("exit", () => reject(new Error("CHILD_EXITED_BEFORE_CHECKPOINT")));
    });
    assert.equal(checkpoint.boundary, phase);
    assert.equal(child.kill("SIGKILL"), true);
    await Promise.race([closed, new Promise((_, reject) => setTimeout(() => reject(new Error("CHILD_NOT_REAPED")), 5_000))]);
    assert.notEqual(child.exitCode === null && child.signalCode === null, true);
  } finally {
    clearTimeout(timer!);
    if (child.exitCode === null && child.signalCode === null) { child.kill("SIGKILL"); await closed; }
  }
}

for (const phase of ["claim", "accepted", "ack", "complete"] as const) {
  test(`actual handler abrupt death at ${phase}: replacement drains once with one ACK and one history entry`, siteCrashIntegration, async () => {
    const f = await notificationFixture();
    const queue = createSiteWebhookQueue({ store: redisSiteWebhookStore, process: async body => invokeActualNotification(body) });
    const accepted = await queue.enqueue(f.body); f.jobIds.push(accepted.id);
    await killActualHandlerAt(f, phase);
    await assertPendingQueueJob(f, accepted.id);
    await expireOnlyFixtureLeases(f);
    await withNotificationTransport(f, async () => {
      assert.equal((await queue.drain()).processed, 1);
      assert.equal((await invokeActualNotification(f.body)).status, 200);
    });
    assert.equal(await redisClient.get(f.calls), "1");
    const history = (await redisClient.lRange(f.history, 0, -1)).map(row => JSON.parse(row));
    assert.equal(history.length, 1);
    assert.equal(history[0].role, "model");
    assert.match(history[0].text, /^<bot_notification>\n/);
    assert.equal(JSON.parse((await redisClient.get(`site_webhook:job:${accepted.id}`))!).status, "processed");
  });
}

test("an unresolved legacy order claim never ACKs the queue and is never erased or upgraded", siteCrashIntegration, async () => {
  const f = await notificationFixture();
  await redisClient.set(f.key, "1", { EX: 86400 });
  const queue = createSiteWebhookQueue({ store: redisSiteWebhookStore, process: invokeActualNotification });
  const accepted = await queue.enqueue(f.body); f.jobIds.push(accepted.id);
  await withNotificationTransport(f, async () => { assert.equal((await queue.drain()).processed, 0); });
  assert.equal(await redisClient.get(f.key), "1");
  assert.equal(await redisClient.get(f.calls), null);
  await assertPendingQueueJob(f, accepted.id);
});

test("an unresolved legacy event claim is not evidence of a customer ACK", siteCrashIntegration, async () => {
  const f = await notificationFixture(); const eventKey = `kanban_event_lock:${f.instance}:${f.body.event_id}`;
  await redisClient.set(eventKey, "1", { EX: 86400 });
  await withNotificationTransport(f, async () => { assert.equal((await invokeActualNotification(f.body)).retryLater, true); });
  assert.equal(await redisClient.get(eventKey), "1"); assert.equal(await redisClient.get(f.calls), null);
});

test("unknown gateway ACK remains pending and repeats only the first canonical ID without another send", siteCrashIntegration, async () => {
  const f = await notificationFixture();
  await withNotificationTransport(f, async () => {
    assert.equal((await invokeActualNotification(f.body)).retryLater, true);
    assert.equal((await invokeActualNotification({ ...f.body, total_price: 9999, lang: "kk" })).retryLater, true);
  }, "unknown");
  assert.equal(await redisClient.get(f.calls), "1"); assert.equal(await redisClient.lLen(f.history), 0);
  assert.equal(JSON.parse((await redisClient.get(f.key))!).phase, "pending");
});

test("an attempted pending record beyond gateway retention requires reconciliation even if WAL disappeared", siteCrashIntegration, async () => {
  const f = await notificationFixture();
  await withNotificationTransport(f, async () => { assert.equal((await invokeActualNotification(f.body)).retryLater, true); }, "unknown");
  const raw = JSON.parse((await redisClient.get(f.key))!); raw.attemptedAt = Date.now() - 24 * 60 * 60_000;
  await redisClient.set(f.key, JSON.stringify(raw)); await redisClient.del(f.wal);
  await withNotificationTransport(f, async () => { assert.equal((await invokeActualNotification(f.body)).retryLater, true); });
  assert.equal(await redisClient.get(f.calls), "1"); assert.equal(await redisClient.lLen(f.history), 0);
  assert.equal(JSON.parse((await redisClient.get(f.key))!).attemptedAt, raw.attemptedAt);
});

test("no-ID statuses have different transport IDs, while camel and snake event aliases identify the same event", siteCrashIntegration, async () => {
  const f = await notificationFixture();
  const { siteNotificationRequestId } = await import("../src/controllers/kanban.js") as any;
  assert.equal(typeof siteNotificationRequestId, "function");
  const a = siteNotificationRequestId(f.instance, f.phone, "status_changed", "142", {}, "preparing");
  const b = siteNotificationRequestId(f.instance, f.phone, "status_changed", "142", {}, "delivery");
  assert.notEqual(a, b);
  assert.equal(siteNotificationRequestId(f.instance, f.phone, "status_changed", "142", { eventId: "event-1" }, "preparing"), siteNotificationRequestId(f.instance, f.phone, "status_changed", "142", { event_id: "event-1" }, "preparing"));
  await withNotificationTransport(f, async () => {
    assert.equal((await invokeActualNotification({ ...f.body, action: "status_changed", status: "preparing", event_id: undefined })).status, 200);
    assert.equal((await invokeActualNotification({ ...f.body, action: "status_changed", status: "delivery", event_id: undefined })).status, 200);
  });
  assert.equal(await redisClient.hLen(f.wal), 2); assert.equal(await redisClient.get(f.calls), "2");
});

test("a fresh event alias recovers the same unfinished order payload rather than minting another ID", siteCrashIntegration, async () => {
  const f = await notificationFixture();
  await withNotificationTransport(f, async () => { assert.equal((await invokeActualNotification(f.body)).retryLater, true); }, "unknown");
  const original = JSON.parse((await redisClient.get(f.key))!).payload;
  await withNotificationTransport(f, async () => { assert.equal((await invokeActualNotification({ ...f.body, event_id: crypto.randomUUID(), total_price: 9999 })).retryLater, true); });
  assert.deepEqual(JSON.parse((await redisClient.get(f.key))!).payload, original);
  assert.equal(await redisClient.get(f.calls), "1");
});

test("atomic completion preserves longer history TTL, max120 and a higher cursor; an obsolete token cannot commit", siteCrashIntegration, async () => {
  const f = await notificationFixture(); const api: any = await import("../src/services/redis.service.js");
  const acquired = await api.claimSiteNotification(f.instance, "142", f.key, ""); assert.equal(acquired.status, "acquired");
  const c = acquired.claim;
  await api.prepareSiteNotification(c, { instance: f.instance, orderId: "142", phone: f.phone, text: "Synthetic accepted notification", requestId: "a".repeat(64), rank: 2, status: "preparing", clearOrderPointer: false, createdAt: 12345 });
  await api.attemptSiteNotification(c); await api.acknowledgeSiteNotification(c, "SYNTHETIC-ACK");
  for (let i = 0; i < 125; i++) await redisClient.rPush(f.history, JSON.stringify({ role: "user", text: `old-${i}`, createdAt: i }));
  await redisClient.expire(f.history, 900000); const cursorKey = `order_notify_cursor:${f.instance}:142`;
  await redisClient.set(cursorKey, JSON.stringify({ rank: 9, status: "completed" }));
  await redisClient.set(c.leaseKey, "replacement-token", { PX: 20000 });
  await assert.rejects(api.finishSiteNotification(c), /EFFECTS_NOT_COMMITTED/);
  assert.equal(await redisClient.lLen(f.history), 125); assert.equal(JSON.parse((await redisClient.get(f.key))!).phase, "acknowledged");
  await redisClient.set(c.leaseKey, c.token, { PX: 20000 }); await api.finishSiteNotification(c);
  assert.equal(await redisClient.lLen(f.history), 120); assert.ok((await redisClient.ttl(f.history)) > 604800);
  assert.deepEqual(JSON.parse((await redisClient.get(cursorKey))!), { rank: 9, status: "completed" });
  const entry = JSON.parse((await redisClient.lRange(f.history, -1, -1))[0]);
  assert.deepEqual(entry, { role: "model", text: "<bot_notification>\nSynthetic accepted notification\n</bot_notification>", createdAt: 12345 });
  assert.equal(JSON.parse((await redisClient.get(f.key))!).phase, "complete");
});

test("failed Redis history effects cannot COMPLETE or ACK a queued notification", siteCrashIntegration, async () => {
  const f = await notificationFixture(); await redisClient.set(f.history, "synthetic wrong-type storage failure");
  const queue = createSiteWebhookQueue({ store: redisSiteWebhookStore, process: invokeActualNotification });
  const accepted = await queue.enqueue(f.body); f.jobIds.push(accepted.id);
  await withNotificationTransport(f, async () => { assert.equal((await queue.drain()).processed, 0); });
  assert.equal(JSON.parse((await redisClient.get(f.key))!).phase, "acknowledged");
  await assertPendingQueueJob(f, accepted.id);
  assert.equal(await redisClient.get(f.history), "synthetic wrong-type storage failure");
});

test("a competing active owner keeps the handler and queue pending without transport", siteCrashIntegration, async () => {
  const f = await notificationFixture(); const api: any = await import("../src/services/redis.service.js");
  const first = await api.claimSiteNotification(f.instance, "142", f.key, ""); assert.equal(first.status, "acquired");
  await withNotificationTransport(f, async () => { assert.equal((await invokeActualNotification(f.body)).retryLater, true); });
  assert.equal(await redisClient.get(f.calls), null); assert.equal(await redisClient.get(first.claim.leaseKey), first.claim.token);
  await api.releaseSiteNotification(first.claim);
});

test("an explicit unknown-template no-send is recorded without retaining the original released order scope", siteCrashIntegration, async () => {
  const f = await notificationFixture(); const body = { ...f.body, action: "status_changed", status: "not-a-customer-status" };
  const key = `kanban_lock:${f.instance}:142:status_changed:not-a-customer-status`;
  await withNotificationTransport(f, async () => {
    const first = await invokeActualNotification(body); assert.equal(first.status, 200); assert.equal(first.retryLater, false);
    const second = await invokeActualNotification(body); assert.equal(second.status, 200); assert.equal(second.retryLater, false);
  });
  assert.equal(await redisClient.get(f.calls), null); assert.equal(await redisClient.get(key), null);
  const alias = JSON.parse((await redisClient.get(`kanban_event_lock:${f.instance}:${f.body.event_id}`))!);
  const decision = JSON.parse((await redisClient.get(alias.journalKey))!);
  assert.equal(decision.phase, "no_send"); assert.equal(decision.reason, "status not intended for client"); assert.equal(decision.payload, undefined);
});

test("an already persisted ACK can complete after the gateway replay horizon without another call", siteCrashIntegration, async () => {
  const f = await notificationFixture(); const queue = createSiteWebhookQueue({ store: redisSiteWebhookStore, process: invokeActualNotification });
  const accepted = await queue.enqueue(f.body); f.jobIds.push(accepted.id); await killActualHandlerAt(f, "ack"); await expireOnlyFixtureLeases(f);
  const raw = JSON.parse((await redisClient.get(f.key))!); raw.attemptedAt = Date.now() - 24 * 60 * 60_000;
  await redisClient.set(f.key, JSON.stringify(raw)); await redisClient.del(f.wal);
  await withNotificationTransport(f, async () => { assert.equal((await queue.drain()).processed, 1); });
  assert.equal(await redisClient.get(f.calls), "1"); assert.equal(await redisClient.lLen(f.history), 1);
});

test("a fenced payment-cycle reset preserves a finished or advanced cursor", siteCrashIntegration, async () => {
  const f = await notificationFixture(); const api: any = await import("../src/services/redis.service.js");
  const acquired = await api.claimSiteNotification(f.instance, "142", f.key, ""); assert.equal(acquired.status, "acquired");
  const cursor = `order_notify_cursor:${f.instance}:142`;
  await redisClient.set(cursor, JSON.stringify({ rank: 9, status: "completed" }));
  await api.resetSiteNotificationCursor(acquired.claim, 5);
  assert.deepEqual(JSON.parse((await redisClient.get(cursor))!), { rank: 9, status: "completed" });
  await redisClient.set(acquired.claim.leaseKey, "replacement-token", { PX: 20000 });
  await assert.rejects(api.resetSiteNotificationCursor(acquired.claim, 5), /LEASE_LOST/);
  assert.deepEqual(JSON.parse((await redisClient.get(cursor))!), { rank: 9, status: "completed" });
});

test("observed legacy order uncertainty survives its original TTL expiry without becoming a fresh delivery", siteCrashIntegration, async () => {
  const f = await notificationFixture(); await redisClient.set(f.key, "1", { EX: 86400 });
  await withNotificationTransport(f, async () => {
    assert.equal((await invokeActualNotification(f.body)).retryLater, true);
    assert.equal(await redisClient.get(f.key), "1");
    assert.notEqual(await redisClient.get(`${f.key}:reconcile`), null);
    await redisClient.pExpire(f.key, 1); await new Promise(resolve => setTimeout(resolve, 30));
    assert.equal(await redisClient.get(f.key), null);
    assert.equal((await invokeActualNotification(f.body)).retryLater, true);
  });
  assert.equal(await redisClient.get(f.key), null); assert.equal(await redisClient.get(f.calls), null);
  assert.equal(await redisClient.lLen(f.history), 0); assert.equal(await redisClient.ttl(`${f.key}:reconcile`), -1);
});

test("observed legacy event uncertainty survives its TTL expiry without upgrading the event or order", siteCrashIntegration, async () => {
  const f = await notificationFixture(); const event = `kanban_event_lock:${f.instance}:${f.body.event_id}`;
  await redisClient.set(event, "1", { EX: 86400 });
  await withNotificationTransport(f, async () => {
    assert.equal((await invokeActualNotification(f.body)).retryLater, true);
    assert.equal(await redisClient.get(event), "1"); assert.notEqual(await redisClient.get(`${event}:reconcile`), null);
    await redisClient.pExpire(event, 1); await new Promise(resolve => setTimeout(resolve, 30));
    assert.equal(await redisClient.get(event), null);
    assert.equal((await invokeActualNotification(f.body)).retryLater, true);
  });
  assert.equal(await redisClient.get(event), null); assert.equal(await redisClient.get(f.key), null);
  assert.equal(await redisClient.get(f.calls), null); assert.equal(await redisClient.ttl(`${event}:reconcile`), -1);
});

test("malformed completed ACK timestamp stays reconciliation and cannot finish a queued job", siteCrashIntegration, async () => {
  const f = await notificationFixture(); const now = Date.now();
  const raw = JSON.stringify({ schema: "SITE_NOTIFICATION_JOURNAL_V1", instance: f.instance, orderId: "142", phase: "complete", eventKeys: {}, attemptedAt: now, acknowledgedAt: "unknown", payload: { instance: f.instance, orderId: "142", phone: f.phone, text: "Synthetic malformed completed notification", requestId: "a".repeat(64), rank: 2, status: "preparing", clearOrderPointer: false, createdAt: now } });
  await redisClient.set(f.key, raw, { EX: 600 });
  const queue = createSiteWebhookQueue({ store: redisSiteWebhookStore, process: invokeActualNotification });
  const accepted = await queue.enqueue(f.body); f.jobIds.push(accepted.id);
  await withNotificationTransport(f, async () => { assert.equal((await queue.drain()).processed, 0); });
  assert.equal(await redisClient.get(f.key), raw);
  assert.ok((await redisClient.ttl(f.key)) > 500 && (await redisClient.ttl(f.key)) <= 600);
  assert.notEqual(await redisClient.get(`${f.key}:reconcile`), null);
  assert.equal(await redisClient.get(f.calls), null); assert.equal(await redisClient.lLen(f.history), 0);
  await assertPendingQueueJob(f, accepted.id);
});

test.afterEach(async () => {
  // These exact synthetic fixtures are already settled by killActualHandlerAt
  // before its promise resolves/rejects. Clear only their records between files;
  // real journals, original test fixtures, source trees and live WAL are outside
  // this disposable internal-only integration Redis.
  for (const f of notificationFixtures.splice(0)) {
    for (const id of f.jobIds) { await redisClient.zRem("site_webhook:due", id); await redisClient.del(`site_webhook:job:${id}`); }
    const lane = crypto.createHash("sha256").update(JSON.stringify([f.instance, f.body.order_id])).digest("hex");
    await redisClient.del(`site_webhook:lane:${lane}`);
    const keys = await redisClient.keys(`*:${f.instance}:*`);
    for (const key of keys) assert.ok(key.includes(`:${f.instance}:`));
    if (keys.length) await redisClient.del(keys);
    await redisClient.del([`config:${f.instance}`, `config_backup:${f.instance}`, f.wal, f.calls]);
  }
});

async function withNotificationFixtureClock<T>(now: number, run: () => Promise<T>): Promise<T> {
  const original = Date.now;
  Date.now = () => now;
  try { return await run(); } finally { Date.now = original; }
}

async function prepareSyntheticPaymentContext(f: Awaited<ReturnType<typeof notificationFixture>>) {
  const config = JSON.parse((await redisClient.get(`config:${f.instance}`))!);
  await redisClient.set(`config:${f.instance}`, JSON.stringify({ ...config, alemi_api_url: "https://synthetic.invalid", alemi_secret: "synthetic-test-only" }), { EX: 120 });
  (f as any).paymentContext = true;
}

function syntheticPaymentContext(f: Awaited<ReturnType<typeof notificationFixture>>, request: unknown) {
  const command = typeof request === "string" ? JSON.parse(request) : request;
  assert.equal((command as any).command, "order.context.get");
  assert.equal((command as any).instance, f.instance);
  assert.equal(String((command as any).data.order_id), "142");
  return { status: 200, data: { result: { order: { id: "142", phone: f.phone, status: "pending", payment_timing: "prepay", payment_revision: 1, receipt_required: true, total_price: 2000 } } } };
}

async function findOnlyFrozenNotification(f: Awaited<ReturnType<typeof notificationFixture>>) {
  const records: Array<{ key: string; state: any }> = [];
  for (const key of await redisClient.keys(`kanban_lock:${f.instance}:142:*`)) {
    if (key.endsWith(":processing") || key.endsWith(":reconcile")) continue;
    const raw = await redisClient.get(key);
    if (!raw || !raw.startsWith("{")) continue;
    const state = JSON.parse(raw);
    if (state.schema === "SITE_NOTIFICATION_JOURNAL_V1" && state.payload) records.push({ key, state });
  }
  assert.equal(records.length, 1, "one admitted event has one frozen journal, never a fresh minute journal");
  return records[0];
}

for (const identity of ["request_id", "no_id", "timing_without_revision"] as const) {
  test(`accepted ACK then abrupt death: ${identity} retry crosses minute and receipt state without another send`, siteCrashIntegration, async () => {
    const f = await notificationFixture();
    const body: any = { ...f.body, action: identity === "timing_without_revision" ? "payment_timing_changed" : "request_payment" };
    delete body.event_id;
    if (identity === "request_id") body.request_id = "synthetic-press-one";
    // No timing/revision in the third event: only the fresh synthetic context
    // supplies them, so the original wall-clock fallback is actually reached.
    if (identity === "timing_without_revision") body.previous_payment_timing = "on_receipt";
    (f as any).body = body;
    await prepareSyntheticPaymentContext(f);
    await redisClient.set(`receipt_seen:${f.instance}:142`, "1", { EX: 120 });
    const queue = createSiteWebhookQueue({ store: redisSiteWebhookStore, process: invokeActualNotification });
    const accepted = await queue.enqueue(body); f.jobIds.push(accepted.id);
    const now = (await assertPendingQueueJob(f, accepted.id, body)).nextAttemptAt;
    (f as any).fixtureNowMs = now;
    await killActualHandlerAt(f, "accepted");
    const before = await findOnlyFrozenNotification(f);
    assert.equal(before.state.phase, "pending");
    assert.equal(await redisClient.get(f.calls), "1");
    const firstPayload = before.state.payload;
    f.key = before.key;
    await expireOnlyFixtureLeases(f);
    // This is a current-state change, not a change to the persisted event.
    await redisClient.del(`receipt_seen:${f.instance}:142`);
    await withNotificationFixtureClock(now + 65_000, async () => {
      await withNotificationTransport(f, async () => {
        assert.equal((await queue.drain()).processed, 1);
        assert.equal((await invokeActualNotification(JSON.parse(JSON.stringify(body)))).retryLater, false);
      });
    });
    const after = await findOnlyFrozenNotification(f);
    assert.equal(after.key, before.key);
    assert.equal(after.state.phase, "complete");
    assert.deepEqual(after.state.payload, firstPayload);
    assert.equal(await redisClient.get(f.calls), "1");
    assert.equal(await redisClient.hLen(f.wal), 1);
    const history = (await redisClient.lRange(f.history, 0, -1)).map(value => JSON.parse(value));
    assert.equal(history.length, 1);
    assert.equal(history[0].text, `<bot_notification>\n${firstPayload.text}\n</bot_notification>`);
    assert.equal(JSON.parse((await redisClient.get(`site_webhook:job:${accepted.id}`))!).status, "processed");
  });
}

test("distinct receipt press request IDs remain independent while identical no-ID bodies are indistinguishable retries", siteCrashIntegration, async () => {
  const f = await notificationFixture(); await prepareSyntheticPaymentContext(f);
  const base: any = { ...f.body, action: "request_payment" }; delete base.event_id;
  await redisClient.set(`receipt_seen:${f.instance}:142`, "1", { EX: 120 });
  const queue = createSiteWebhookQueue({ store: redisSiteWebhookStore, process: invokeActualNotification });
  const a = await queue.enqueue({ ...base, request_id: "press-a" });
  const b = await queue.enqueue({ ...base, request_id: "press-b" });
  f.jobIds.push(a.id, b.id); assert.notEqual(a.id, b.id);
  await withNotificationTransport(f, async () => {
    assert.equal((await queue.drain()).processed, 1);
    assert.equal((await queue.drain()).processed, 1);
  });
  assert.equal(await redisClient.get(f.calls), "2"); assert.equal(await redisClient.hLen(f.wal), 2);
  const x = await queue.enqueue(base); const y = await queue.enqueue(JSON.parse(JSON.stringify(base)));
  f.jobIds.push(x.id); assert.equal(x.id, y.id);
  await withNotificationTransport(f, async () => { assert.equal((await queue.drain()).processed, 1); });
  assert.equal(await redisClient.get(f.calls), "3"); assert.equal(await redisClient.hLen(f.wal), 3);
});

test("a reused request ID across different actions cannot alias the earlier notification", siteCrashIntegration, async () => {
  const f = await notificationFixture(); await prepareSyntheticPaymentContext(f);
  const base: any = { ...f.body, request_id: "same-external-request" }; delete base.event_id;
  await redisClient.set(`receipt_seen:${f.instance}:142`, "1", { EX: 120 });
  await withNotificationTransport(f, async () => {
    assert.equal((await invokeActualNotification({ ...base, action: "request_payment" })).retryLater, false);
    assert.equal((await invokeActualNotification({ ...base, action: "status_changed", status: "preparing" })).retryLater, false);
  });
  assert.equal(await redisClient.get(f.calls), "2"); assert.equal(await redisClient.hLen(f.wal), 2);
});

test("distinct payment revisions and press IDs retain independent frozen timing notices", siteCrashIntegration, async () => {
  const f = await notificationFixture();
  await withNotificationTransport(f, async () => {
    assert.equal((await invokeActualNotification({ ...f.body, action: "payment_timing_changed", event_id: "timing-press-a", payment_timing: "on_receipt", payment_revision: 2 })).retryLater, false);
    assert.equal((await invokeActualNotification({ ...f.body, action: "payment_timing_changed", event_id: "timing-press-b", payment_timing: "prepay", payment_revision: 3 })).retryLater, false);
  });
  assert.equal(await redisClient.get(f.calls), "2"); assert.equal(await redisClient.hLen(f.wal), 2);
});

for (const scope of ["receipt_resend", "timing_change"] as const) {
  test(`historical no-event ${scope} minute claim stays reconciliation after its TTL and receipt-state expiry`, siteCrashIntegration, async () => {
    const f = await notificationFixture(); await prepareSyntheticPaymentContext(f);
    const body: any = { ...f.body, action: scope === "receipt_resend" ? "request_payment" : "payment_timing_changed", request_id: "stable-new-private-event" };
    delete body.event_id;
    await redisClient.set(`receipt_seen:${f.instance}:142`, "1", { EX: 120 });
    const prefix = `kanban_lock:${f.instance}:142:${scope === "receipt_resend" ? "request_payment:receipt_resend:t" : "payment_timing_changed:revt"}`;
    const oldKey = `${prefix}${Math.floor(Date.now() / 60_000) - 5}`;
    await redisClient.set(oldKey, "1", { EX: 86400 });
    const queue = createSiteWebhookQueue({ store: redisSiteWebhookStore, process: invokeActualNotification });
    const accepted = await queue.enqueue(body); f.jobIds.push(accepted.id);
    await withNotificationTransport(f, async () => { assert.equal((await queue.drain()).processed, 0); });
    assert.equal(await redisClient.get(oldKey), "1");
    assert.ok((await redisClient.ttl(oldKey)) > 86300);
    assert.equal(await redisClient.ttl(`${prefix}:reconcile`), -1);
    await redisClient.pExpire(oldKey, 1); await new Promise(resolve => setTimeout(resolve, 30));
    await redisClient.del(`receipt_seen:${f.instance}:142`);
    await withNotificationFixtureClock(Date.now() + 65_000, async () => {
      await withNotificationTransport(f, async () => { assert.equal((await invokeActualNotification(body)).retryLater, true); });
    });
    assert.equal(await redisClient.get(oldKey), null);
    assert.equal(await redisClient.get(f.calls), null); assert.equal(await redisClient.hLen(f.wal), 0);
    assert.equal(await redisClient.lLen(f.history), 0);
    await assertPendingQueueJob(f, accepted.id, body);
    for (const key of await redisClient.keys(`kanban_lock:${f.instance}:142:*`)) {
      const raw = await redisClient.get(key);
      assert.equal(raw?.includes('"schema":"SITE_NOTIFICATION_JOURNAL_V1"'), false, "unknown legacy evidence is never upgraded into a fresh journal");
    }
  });
}

test("bounded-out legacy minute lookup never becomes absence proof or a new send", siteCrashIntegration, async () => {
  const f = await notificationFixture();
  const body: any = { ...f.body, action: "request_payment", request_id: "private-bounded-lookup" }; delete body.event_id;
  const original = redisClient.sendCommand.bind(redisClient); let pages = 0;
  (redisClient as any).sendCommand = async (argv: string[], ...rest: any[]) => {
    if (argv[0] === "SCAN" && argv[2] === "MATCH" && argv[3] === `kanban_lock:${f.instance}:142:request_payment:receipt_resend:t*`) {
      pages += 1; return ["123", []];
    }
    return (original as any)(argv, ...rest);
  };
  try {
    await withNotificationTransport(f, async () => { assert.equal((await invokeActualNotification(body)).retryLater, true); });
  } finally { redisClient.sendCommand = original; }
  assert.equal(pages, 128);
  assert.equal(await redisClient.get(f.calls), null);
  assert.equal(await redisClient.ttl(`kanban_lock:${f.instance}:142:request_payment:receipt_resend:t:reconcile`), -1);
  assert.equal(await redisClient.get(`kanban_lock:${f.instance}:142:request_payment`), null);
});

for (const phase of ["accepted", "complete"] as const) {
  test(`actual ${phase} crash survives unbounded queue interruption after gateway retention with no second transport`, siteCrashIntegration, async () => {
    const f = await notificationFixture();
    (f as any).body = { ...f.body, action: "request_payment" };
    await prepareSyntheticPaymentContext(f);
    await redisClient.set(`receipt_seen:${f.instance}:142`, "1", { EX: 120 });
    const queue = createSiteWebhookQueue({ store: redisSiteWebhookStore, process: invokeActualNotification });
    const accepted = await queue.enqueue(f.body); f.jobIds.push(accepted.id);
    const now = (await assertPendingQueueJob(f, accepted.id)).nextAttemptAt;
    (f as any).fixtureNowMs = now;
    await killActualHandlerAt(f, phase);
    const before = await findOnlyFrozenNotification(f);
    assert.equal(before.state.phase, phase === "complete" ? "complete" : "pending");
    assert.equal(before.state.payload.rank, -1, "receipt resend has no stale-rank suppression that could conceal a second transport");
    await assertPendingQueueJob(f, accepted.id);
    assert.equal(await redisClient.get(f.calls), "1");
    const firstPayload = before.state.payload;
    f.key = before.key;
    await expireOnlyFixtureLeases(f);
    // Model only the expiry that a product assigned to its own proof keys.
    // Durable -1 TTLs are preserved; never erase a pending/indefinite proof.
    const proofKeys = [before.key, ...Object.keys(before.state.eventKeys)];
    for (const key of proofKeys) {
      const ttl = await redisClient.ttl(key);
      assert.ok(ttl === -1 || ttl > 0);
      if (ttl > 0) await redisClient.pExpire(key, 1);
    }
    await new Promise(resolve => setTimeout(resolve, 30));
    await redisClient.del(f.wal); // Synthetic-only accepted WAL retention expiry.
    await withNotificationFixtureClock(now + 24 * 60 * 60_000 + 60_000, async () => {
      await withNotificationTransport(f, async () => {
        assert.equal((await queue.drain()).processed, phase === "complete" ? 1 : 0);
      });
    });
    assert.equal(await redisClient.get(f.calls), "1");
    assert.equal(await redisClient.hLen(f.wal), 0);
    const after = await findOnlyFrozenNotification(f);
    assert.equal(after.key, before.key);
    assert.deepEqual(after.state.payload, firstPayload);
    assert.equal(after.state.phase, before.state.phase);
    for (const key of proofKeys) assert.equal(await redisClient.ttl(key), -1, "delivery/attempt proof and event alias survive an indefinitely pending queue job");
    const history = (await redisClient.lRange(f.history, 0, -1)).map(value => JSON.parse(value));
    assert.equal(history.length, phase === "complete" ? 1 : 0);
    if (phase === "complete") assert.equal(history[0].text, `<bot_notification>\n${firstPayload.text}\n</bot_notification>`);
    if (phase === "complete") assert.equal(JSON.parse((await redisClient.get(`site_webhook:job:${accepted.id}`))!).status, "processed");
    else await assertPendingQueueJob(f, accepted.id);
  });
}

test("canonical no-ID persisted JSON keeps nested reordered values under one recovered journal while changed material body is independent", siteCrashIntegration, async () => {
  const f = await notificationFixture(); await prepareSyntheticPaymentContext(f);
  const body: any = { ...f.body, action: "request_payment", line_items: [{ item_id: "synthetic-one", quantity: 1 }, { item_id: "synthetic-two", quantity: 2 }] };
  delete body.event_id; (f as any).body = body;
  await redisClient.set(`receipt_seen:${f.instance}:142`, "1", { EX: 120 });
  const queue = createSiteWebhookQueue({ store: redisSiteWebhookStore, process: invokeActualNotification });
  const first = await queue.enqueue(body); f.jobIds.push(first.id);
  await killActualHandlerAt(f, "accepted");
  const before = await findOnlyFrozenNotification(f);
  f.key = before.key; await assertPendingQueueJob(f, first.id);
  await expireOnlyFixtureLeases(f);
  const reordered = { line_items: [{ quantity: 1, item_id: "synthetic-one" }, { quantity: 2, item_id: "synthetic-two" }], total_price: body.total_price, lang: body.lang, phone: body.phone, order_id: body.order_id, action: body.action, instance: body.instance };
  assert.deepEqual(reordered, body);
  await withNotificationTransport(f, async () => {
    assert.equal((await queue.drain()).processed, 1);
    assert.equal((await invokeActualNotification(reordered)).retryLater, false);
  });
  const recovered = await findOnlyFrozenNotification(f);
  assert.equal(recovered.key, before.key); assert.deepEqual(recovered.state.payload, before.state.payload);
  assert.equal(await redisClient.get(f.calls), "1"); assert.equal(await redisClient.hLen(f.wal), 1);
  assert.equal(await redisClient.lLen(f.history), 1);
  const changed = { ...body, total_price: 3000, line_items: [...body.line_items].reverse() };
  const second = await queue.enqueue(changed); f.jobIds.push(second.id); assert.notEqual(second.id, first.id);
  await withNotificationTransport(f, async () => { assert.equal((await queue.drain()).processed, 1); });
  assert.equal(await redisClient.get(f.calls), "2"); assert.equal(await redisClient.hLen(f.wal), 2);
  assert.equal(await redisClient.lLen(f.history), 2);
  assert.deepEqual(JSON.parse((await redisClient.get(before.key))!).payload, before.state.payload);
  assert.equal(JSON.parse((await redisClient.get(`site_webhook:job:${first.id}`))!).status, "processed");
  assert.equal(JSON.parse((await redisClient.get(`site_webhook:job:${second.id}`))!).status, "processed");
});

test("intermediate ready_delivery remains an explicit no-send decision while client-facing delivery identity is tested separately", siteCrashIntegration, async () => {
  const f = await notificationFixture();
  await withNotificationTransport(f, async () => {
    const ignored = await invokeActualNotification({ ...f.body, action: "status_changed", status: "ready_delivery" });
    assert.equal(ignored.status, 200); assert.equal(ignored.retryLater, false);
    assert.equal(ignored.payload.message, "Ignored status not intended for client");
  });
  assert.equal(await redisClient.get(f.calls), null); assert.equal(await redisClient.hLen(f.wal), 0);
  assert.equal(await redisClient.lLen(f.history), 0);
  const pointer = JSON.parse((await redisClient.get(`kanban_event_lock:${f.instance}:${f.body.event_id}`))!);
  assert.equal(pointer.schema, "SITE_NOTIFICATION_EVENT_V1");
  assert.ok(pointer.journalKey.startsWith(`kanban_lock:${f.instance}:142:status_changed:ready_delivery:no_send:`));
  const decision = JSON.parse((await redisClient.get(pointer.journalKey))!);
  assert.equal(decision.phase, "no_send"); assert.equal(decision.reason, "status not intended for client");
  assert.equal(decision.payload, undefined); assert.equal(await redisClient.ttl(pointer.journalKey), -1);
});

// Real-handler terminal effects: no-phone events recover only this synthetic mapping.
// ACK and unknown outcomes share the original registered transport/cleanup fixture.
for (const terminal of [
  { label: "completed", action: "status_changed", status: "completed", rank: 7 },
  { label: "cancelled", action: "status_changed", status: "cancelled", rank: 99 },
  { label: "order_rejected", action: "order_rejected", status: "", rank: 99 },
] as const) {
  for (const transport of ["accepted", "unknown"] as const) {
    test(`actual terminal ${terminal.label} missing phone: ${transport} preserves ACK-gated effects`, siteCrashIntegration, async () => {
      const f = await notificationFixture();
      const api = await import("../src/services/redis.service.js");
      // Empty rejection reason returns before the optional model humanizer.
      const body: Record<string, unknown> = { ...f.body, action: terminal.action, phone: "", reason: "" };
      if (terminal.status) body.status = terminal.status;
      f.key = `kanban_lock:${f.instance}:142:${terminal.action === "status_changed" ? "status_changed:" + terminal.status : terminal.action}`;
      assert.equal(await api.saveOrderPhone(f.instance, "142", f.phone), true);
      assert.equal(await api.getOrderPhone(f.instance, "142"), f.phone);
      const pointerKey = `last_order:${f.instance}:${f.phone}`;
      const pointer = JSON.stringify({ order_id: "142", synthetic: true });
      await redisClient.set(pointerKey, pointer, { EX: 600 });
      const previousCursor = { rank: 4, status: "preparing" };
      assert.equal(await api.saveOrderNotifyCursor(f.instance, "142", previousCursor.rank, previousCursor.status), true);
      const priorEntry = JSON.stringify({ role: "user", text: "Synthetic retained conversation", createdAt: 12345 });
      await redisClient.rPush(f.history, priorEntry);
      await redisClient.expire(f.history, 900_000);
      const historyBefore = await redisClient.lRange(f.history, 0, -1);
      assert.deepEqual(historyBefore, [priorEntry]);

      await withNotificationTransport(f, async () => {
        const actual = await invokeActualNotification(body);
        assert.equal(await api.getOrderPhone(f.instance, "142"), f.phone);
        assert.equal(await redisClient.get(f.calls), "1", "exactly one synthetic transport attempt");
        const rawJournal = await redisClient.get(f.key);
        assert.notEqual(rawJournal, null);
        const journal = JSON.parse(rawJournal!);
        assert.equal(journal.payload.phone, f.phone);
        assert.equal(journal.payload.rank, terminal.rank);
        assert.equal(journal.payload.status, terminal.status || terminal.action);
        assert.equal(journal.payload.clearOrderPointer, true);
        assert.ok(typeof journal.payload.text === "string" && journal.payload.text.length > 0);
        assert.ok(Number.isSafeInteger(journal.attemptedAt) && journal.attemptedAt > 0);
        if (transport === "accepted") {
          assert.equal(actual.status, 200);
          assert.equal(actual.retryLater, false);
          assert.equal(journal.phase, "complete");
          assert.ok(Number.isSafeInteger(journal.acknowledgedAt) && journal.acknowledgedAt >= journal.attemptedAt);
          assert.equal(journal.messageId, "SYNTHETIC-ACK");
          assert.equal(await redisClient.get(pointerKey), null);
          assert.deepEqual(await api.getOrderNotifyCursor(f.instance, "142"), { rank: terminal.rank, status: terminal.status || terminal.action });
          const history = await redisClient.lRange(f.history, 0, -1);
          assert.deepEqual(history.slice(0, historyBefore.length), historyBefore);
          assert.equal(history.length, historyBefore.length + 1);
          assert.deepEqual(JSON.parse(history[history.length - 1]), {
            role: "model",
            text: `<bot_notification>\n${journal.payload.text}\n</bot_notification>`,
            createdAt: journal.payload.createdAt,
          });
          assert.ok((await redisClient.ttl(f.history)) > 604_800, "longer existing history TTL is preserved");
          const replay = await invokeActualNotification(body);
          assert.equal(replay.status, 200);
          assert.equal(replay.retryLater, false);
          assert.equal(await redisClient.get(f.calls), "1");
          assert.deepEqual(await redisClient.lRange(f.history, 0, -1), history, "completed retry adds no duplicate history");
        } else {
          assert.equal(actual.status, 503);
          assert.equal(actual.retryLater, true);
          assert.equal(journal.phase, "pending");
          assert.equal(journal.acknowledgedAt, undefined);
          assert.equal(journal.messageId, undefined);
          assert.equal(await redisClient.get(pointerKey), pointer);
          assert.deepEqual(await api.getOrderNotifyCursor(f.instance, "142"), previousCursor);
          assert.deepEqual(await redisClient.lRange(f.history, 0, -1), historyBefore);
          assert.ok((await redisClient.ttl(f.history)) > 604_800);
        }
      }, transport);
    });
  }
}

// Terminal A may ACK after a fresh read has replaced the phone-wide cache with B.
// Exercise the actual handler/Lua effects against this fixture's private Redis.
const terminalCacheCases: Array<{ label: string; raw?: string; list?: string[]; clears: boolean }> = [
  { label: "matching top A", raw: JSON.stringify({ order_id: "142", synthetic: true }), clears: true },
  { label: "matching active A", raw: JSON.stringify({ active_order: { id: "142" }, synthetic: true }), clears: true },
  { label: "matching order A", raw: JSON.stringify({ order: { id: "142" }, synthetic: true }), clears: true },
  { label: "matching numeric A", raw: JSON.stringify({ order_id: 142 }), clears: true },
  { label: "newer top B", raw: JSON.stringify({ order_id: "143", active_order: { id: "143" }, synthetic: true }), clears: false },
  { label: "newer active B", raw: JSON.stringify({ active_order: { id: "143" }, synthetic: true }), clears: false },
  { label: "newer order B", raw: JSON.stringify({ order: { id: "143" }, synthetic: true }), clears: false },
  { label: "conflicting A and B", raw: JSON.stringify({ order_id: "142", active_order: { id: "143" } }), clears: false },
  { label: "malformed identity", raw: JSON.stringify({ order_id: "142", order: { id: {} } }), clears: false },
  { label: "malformed JSON", raw: "{broken", clears: false },
  { label: "null JSON", raw: "null", clears: false },
  { label: "unproven identity", raw: JSON.stringify({ synthetic: true }), clears: false },
  { label: "absent cache", clears: false },
  { label: "wrong Redis type", list: ["synthetic-unproven"], clears: false },
];
for (const terminal of [
  { label: "completed", action: "status_changed", status: "completed", rank: 7 },
  { label: "cancelled", action: "status_changed", status: "cancelled", rank: 99 },
  { label: "order_rejected", action: "order_rejected", status: "", rank: 99 },
] as const) {
  for (const cache of terminalCacheCases) {
    for (const transport of ["accepted", "unknown"] as const) {
      test(`terminal phone cache identity: ${terminal.label} ${cache.label} ${transport}`, siteCrashIntegration, async () => {
        const f = await notificationFixture();
        const api = await import("../src/services/redis.service.js");
        const axios = (await import("axios")).default;
        const body: Record<string, unknown> = { ...f.body, action: terminal.action, reason: "" };
        if (terminal.status) body.status = terminal.status;
        f.key = `kanban_lock:${f.instance}:142:${terminal.action === "status_changed" ? "status_changed:" + terminal.status : terminal.action}`;
        const pointerKey = `last_order:${f.instance}:${f.phone}`;
        await redisClient.set(pointerKey, JSON.stringify({ order_id: "142" }), { EX: 600 });
        const previousCursor = { rank: 4, status: "preparing" };
        assert.equal(await api.saveOrderNotifyCursor(f.instance, "142", previousCursor.rank, previousCursor.status), true);
        const retainedEntry = JSON.stringify({ role: "user", text: "Synthetic retained conversation", createdAt: 12345 });
        await redisClient.rPush(f.history, retainedEntry);
        await redisClient.expire(f.history, 900_000);
        let frozenPayload: any;
        let cacheTTLBefore = -2;
        const readPointer = async () => cache.list
          ? { type: await redisClient.type(pointerKey), body: await redisClient.lRange(pointerKey, 0, -1) }
          : { type: await redisClient.type(pointerKey), body: await redisClient.get(pointerKey) };
        await withNotificationTransport(f, async () => {
          const registeredTransport = axios.post;
          axios.post = (async (url: any, payload: any, ...rest: any[]) => {
            assert.equal(url, "https://synthetic.invalid/api/send");
            const beforeACK = JSON.parse((await redisClient.get(f.key))!);
            assert.equal(beforeACK.phase, "pending");
            assert.ok(Number.isSafeInteger(beforeACK.attemptedAt) && beforeACK.attemptedAt > 0);
            assert.equal(beforeACK.payload.orderId, "142");
            assert.equal(beforeACK.payload.clearOrderPointer, true);
            frozenPayload = beforeACK.payload;
            // This write is after A's payload/attempt is frozen, before its ACK.
            await redisClient.del(pointerKey);
            if (cache.raw !== undefined) await redisClient.set(pointerKey, cache.raw, { EX: 900_000 });
            if (cache.list) { await redisClient.rPush(pointerKey, cache.list); await redisClient.expire(pointerKey, 900_000); }
            cacheTTLBefore = await redisClient.pTTL(pointerKey);
            return (registeredTransport as any)(url, payload, ...rest);
          }) as any;
          const actual = await invokeActualNotification(body);
          assert.equal(await redisClient.get(f.calls), "1");
          assert.equal(await redisClient.hLen(f.wal), 1);
          const journal = JSON.parse((await redisClient.get(f.key))!);
          assert.deepEqual(journal.payload, frozenPayload, "cache writes do not alter A's frozen delivery payload");
          const retainedPointer = { type: cache.list ? "list" : cache.raw === undefined ? "none" : "string", body: cache.list ?? cache.raw ?? null };
          if (transport === "accepted") {
            assert.equal(actual.status, 200); assert.equal(actual.retryLater, false);
            assert.equal(journal.phase, "complete"); assert.equal(journal.messageId, "SYNTHETIC-ACK");
            assert.ok(Number.isSafeInteger(journal.acknowledgedAt) && journal.acknowledgedAt >= journal.attemptedAt);
            assert.deepEqual(await readPointer(), cache.clears ? { type: "none", body: null } : retainedPointer);
            assert.deepEqual(await api.getOrderNotifyCursor(f.instance, "142"), { rank: terminal.rank, status: terminal.status || terminal.action });
            const history = await redisClient.lRange(f.history, 0, -1);
            assert.equal(history.length, 2); assert.equal(history[0], retainedEntry);
            assert.deepEqual(JSON.parse(history[1]), { role: "model", text: `<bot_notification>\n${journal.payload.text}\n</bot_notification>`, createdAt: journal.payload.createdAt });
            assert.ok((await redisClient.ttl(f.history)) > 604_800);
            if (cache.clears) await redisClient.set(pointerKey, JSON.stringify({ order_id: "143", synthetic: true }), { EX: 900_000 });
            const replayPointer = await readPointer();
            const replay = await invokeActualNotification(body);
            assert.equal(replay.status, 200); assert.equal(replay.retryLater, false);
            assert.deepEqual(await readPointer(), replayPointer, "completed A replay never clears a subsequent cache generation");
            assert.deepEqual(await redisClient.lRange(f.history, 0, -1), history);
          } else {
            assert.equal(actual.status, 503); assert.equal(actual.retryLater, true);
            assert.equal(journal.phase, "pending"); assert.equal(journal.acknowledgedAt, undefined);
            assert.equal(journal.messageId, undefined);
            assert.deepEqual(await readPointer(), retainedPointer, "unknown outcome keeps every cache shape");
            assert.deepEqual(await api.getOrderNotifyCursor(f.instance, "142"), previousCursor);
            assert.deepEqual(await redisClient.lRange(f.history, 0, -1), [retainedEntry]);
            const retry = await invokeActualNotification(body);
            assert.equal(retry.status, 503); assert.equal(retry.retryLater, true);
            assert.deepEqual(await readPointer(), retainedPointer);
            assert.deepEqual(await redisClient.lRange(f.history, 0, -1), [retainedEntry]);
          }
          assert.equal(await redisClient.get(f.calls), "1", "replay or unknown retry never makes a second synthetic attempt");
          assert.equal(await redisClient.hLen(f.wal), 1);
          if (!cache.clears || transport === "unknown") {
            const ttlAfter = await redisClient.pTTL(pointerKey);
            if (cacheTTLBefore === -2) assert.equal(ttlAfter, -2);
            else assert.ok(ttlAfter > cacheTTLBefore - 2_000 && ttlAfter <= cacheTTLBefore, "preserved cache retains its existing TTL");
          }
        }, transport);
      });
    }
  }
}
