import assert from "node:assert/strict";
import test from "node:test";
import {operatorPlanFixture, planRedisEnabled} from "./helpers/operatorPlanFixture.js";
const options = {skip: !planRedisEnabled && "Requires disposable AUDIT_REDIS_SOCKET; tests actual lifecycle Lua, delivery services and production cron."};
type Fixture = Awaited<ReturnType<typeof operatorPlanFixture>>;
async function run(fn: (h: Fixture) => Promise<void>) {const h = await operatorPlanFixture(); try {await fn(h);} finally {await h.close();}}
async function crashedCreate(h: Fixture, extra: any = {}) {
  h.fault("after_lifecycle"); await assert.rejects(h.create(extra), /SIMULATED_PROCESS_EXIT/);
  assert.equal(h.hookUsed(), true); h.fault(""); return (await h.redis.get(h.active))!;
}
test("process exit after committed lifecycle leaves BOTH stable plans and due index atomically", options, () => run(async h => {
  const id = await crashedCreate(h);
  assert.ok(await h.redis.get(h.canonical(id))); assert.ok(await h.redis.get(h.marker));
  for (const channel of ["hub", "admin"]) {
    const key = h.key(channel, id), row = JSON.parse((await h.redis.get(key))!);
    assert.equal(row.status, "pending"); assert.equal(row.payload.channel, channel); assert.equal(row.payload.phone, h.phone);
    assert.equal(await h.redis.ttl(key), -1); assert.ok(await h.redis.zScore(h.index, key));
  }
  assert.equal(await h.redis.ttl(h.index), -1); assert.equal(h.calls.admin.length, 0); assert.equal(h.calls.hub.length, 0);
}));
test("actual production cron timer reloads durable plans after process exit and delivers both", options, () => run(async h => {
  const id = await crashedCreate(h); await h.workerTick();
  assert.equal(h.calls.admin.length, 1); assert.equal(h.calls.hub.length, 1);
  assert.equal(h.calls.admin[0].phone, "77000000009"); assert.match(h.calls.admin[0].requestId, /^[a-f0-9]{64}$/);
  for (const channel of ["hub", "admin"]) assert.equal(JSON.parse((await h.redis.get(h.key(channel, id)))!).status, "delivered");
  assert.equal(await h.redis.zCard(h.index), 0);
}));
test("exit between followup queue preparations cannot leave only one channel planned", options, () => run(async h => {
  h.fault("before_admin_plan"); await assert.rejects(h.create(), /SIMULATED_PROCESS_EXIT/); assert.equal(h.hookUsed(), true);
  const id = (await h.redis.get(h.active))!;
  assert.ok(await h.redis.get(h.key("hub", id))); assert.ok(await h.redis.get(h.key("admin", id)));
  await h.workerTick(); assert.equal(h.calls.admin.length, 1); assert.equal(h.calls.hub.length, 1);
}));
test("reuse repairs missing channel atomically while retaining accepted other-channel ledger", options, () => run(async h => {
  const first = await h.create(); await h.restartDrain();
  const hub = await h.redis.get(h.key("hub", first.id)); await h.redis.del(h.key("admin", first.id));
  const reused = await crashedCreate(h, {signalId: "reused_signal"});
  assert.equal(reused, first.id); assert.equal(await h.redis.get(h.key("hub", first.id)), hub);
  assert.ok(await h.redis.get(h.key("admin", first.id))); await h.workerTick();
  assert.equal(h.calls.hub.length, 1); assert.equal(h.calls.admin.length, 2);
}));
test("same active episode reuse and restart never resend accepted stable plans", options, () => run(async h => {
  const first = await h.create(); await h.restartDrain(); const second = await crashedCreate(h, {signalId: "second_signal"});
  assert.equal(first.id, second); await h.workerTick(); assert.equal(h.calls.hub.length, 1); assert.equal(h.calls.admin.length, 1);
}));
test("pending plans outlive canonical/SOS expiry and preserve current customer recipient guard", options, () => run(async h => {
  const id = await crashedCreate(h);
  await h.redis.del([h.canonical(id), h.active, h.marker]); h.advance(60 * 24 * 60 * 60 * 1000);
  for (const channel of ["hub", "admin"]) assert.equal(await h.redis.ttl(h.key(channel, id)), -1);
  assert.equal(await h.redis.ttl(h.index), -1); h.setConfig({instance_id: h.instance, admin_phone: h.phone});
  await h.workerTick(); assert.equal(h.calls.admin.length, 0); assert.equal(h.calls.hub.length, 1);
  const admin = JSON.parse((await h.redis.get(h.key("admin", id)))!);
  assert.equal(admin.status, "pending"); assert.equal(admin.last_error, "ADMIN_RECIPIENT_COLLISION");
  assert.equal(await h.redis.ttl(h.key("admin", id)), -1);
}));
test("reuse repairs an absent due index before a post-lifecycle process exit", options, () => run(async h => {
  const first = await h.create(); await h.redis.del(h.index); await crashedCreate(h, {signalId: "second_signal"});
  assert.equal(await h.redis.zCard(h.index), 2); assert.equal(await h.redis.ttl(h.index), -1);
  await h.workerTick(); assert.equal(h.calls.admin.length, 1); assert.equal(h.calls.hub.length, 1);
}));
test("atomic reuse removes legacy TTLs from BOTH pending plans and due index", options, () => run(async h => {
  const first = await h.create();
  await h.redis.expire(h.key("hub", first.id), 10); await h.redis.expire(h.key("admin", first.id), 10); await h.redis.expire(h.index, 10);
  await crashedCreate(h, {signalId: "second_signal"});
  for (const key of [h.key("hub", first.id), h.key("admin", first.id), h.index]) assert.equal(await h.redis.ttl(key), -1);
}));
test("technical recovery case retains its existing no-operator-notification meaning", options, () => run(async h => {
  const id = await crashedCreate(h, {kind: "unresolved", source: "ai_unavailable"});
  assert.equal(await h.redis.get(h.key("hub", id)), null); assert.equal(await h.redis.get(h.key("admin", id)), null);
  assert.equal(await h.redis.zCard(h.index), 0); await h.workerTick(); assert.equal(h.calls.hub.length, 0); assert.equal(h.calls.admin.length, 0);
}));
for (const channel of ["hub", "admin"]) for (const corruption of ["foreign_instance", "foreign_customer", "masked_customer", "wrong_channel", "invalid_json", "invalid_status", "invalid_metadata"]) {
  test("corrupt/foreign atomic intent cannot overwrite a lifecycle snapshot: " + channel + ":" + corruption, options, () => run(async h => {
    const first = await h.create(), record = JSON.parse((await h.redis.get(h.key(channel, first.id)))!);
    if (corruption === "foreign_instance") record.payload.instanceId = "other_tenant";
    if (corruption === "foreign_customer") record.payload.phone = "77000000088";
    if (corruption === "masked_customer") record.payload.phone = "***" + h.phone;
    if (corruption === "wrong_channel") record.payload.channel = channel === "hub" ? "admin" : "hub";
    if (corruption === "invalid_status") record.status = "unknown";
    if (corruption === "invalid_metadata") record.attempts = "invalid";
    await h.redis.set(h.key(channel, first.id), corruption === "invalid_json" ? "{" : JSON.stringify(record));
    const canonical = await h.redis.get(h.canonical(first.id)), marker = await h.redis.get(h.marker);
    await assert.rejects(h.create({signalId: "replacement_signal"}), /OPERATOR_NOTIFICATION_(?:SCOPE_MISMATCH|RECORD_INVALID)/);
    assert.equal(await h.redis.get(h.canonical(first.id)), canonical); assert.equal(await h.redis.get(h.marker), marker);
    assert.equal(await h.redis.get(h.active), first.id); assert.equal(h.calls.admin.length, 0); assert.equal(h.calls.hub.length, 0);
  }));
}
for (const name of ["hub", "admin", "index"]) {
  test("all notification key types are validated before canonical or other-plan writes: " + name, options, () => run(async h => {
    const first = await h.create(); const key = name === "index" ? h.index : h.key(name, first.id);
    await h.redis.del(key); if (name === "index") await h.redis.set(key, "wrong"); else await h.redis.rPush(key, "wrong");
    const canonical = await h.redis.get(h.canonical(first.id)), marker = await h.redis.get(h.marker);
    const other = name === "hub" ? "admin" : "hub", preserved = await h.redis.get(h.key(other, first.id));
    await assert.rejects(h.create({signalId: "replacement_signal"}), /OPERATOR_NOTIFICATION_WRONGTYPE/);
    assert.equal(await h.redis.get(h.canonical(first.id)), canonical); assert.equal(await h.redis.get(h.marker), marker);
    assert.equal(await h.redis.get(h.key(other, first.id)), preserved);
  }));
}

for (const corruption of ["masked_customer", "foreign_case_key"]) {
  test("restart drain rejects corrupt recipient-scope intent before transport: " + corruption, options, () => run(async h => {
    const id = await crashedCreate(h), key = h.key("admin", id), row = JSON.parse((await h.redis.get(key))!);
    if (corruption === "masked_customer") row.payload.phone = "***" + h.phone;
    else row.payload.caseId = "foreign_case";
    await h.redis.set(key, JSON.stringify(row)); h.setConfig({instance_id: h.instance, admin_phone: h.phone});
    await h.workerTick(); assert.equal(h.calls.admin.length, 0); assert.equal(h.calls.hub.length, 1);
    assert.ok(await h.redis.zScore(h.index + ":quarantine", key)); assert.equal(await h.redis.ttl(key), -1);
  }));
}

test("new case refuses an invalid due-index type before any canonical or plan writes", options, () => run(async h => {
  await h.redis.set(h.index, "wrong"); await assert.rejects(h.create(), /OPERATOR_NOTIFICATION_WRONGTYPE/);
  assert.equal(await h.redis.get(h.active), null); assert.equal(await h.redis.get(h.marker), null);
  for await (const keys of h.redis.scanIterator({MATCH: "operator_notification:" + h.instance + ":*"})) assert.equal(keys.length, 0);
}));
