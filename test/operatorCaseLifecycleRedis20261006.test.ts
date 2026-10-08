import assert from "node:assert/strict";
import test from "node:test";
import {lifecycleRedisEnabled, operatorLifecycleFixture} from "./helpers/operatorLifecycleFixture.js";
const options = {skip: !lifecycleRedisEnabled && "Requires disposable AUDIT_REDIS_SOCKET; no emulated Lua."};
const crossOptions = {skip: (!lifecycleRedisEnabled || !process.env.AUDIT_WHATSPRO_ROOT) && "Requires disposable Redis plus actual WhatsPro sosStore."};
type Fixture = Awaited<ReturnType<typeof operatorLifecycleFixture>>;
async function run(fn: (h: Fixture) => Promise<void>) {const h = await operatorLifecycleFixture(); try {await fn(h);} finally {await h.close();}}
async function record(h: Fixture, id: string) {return JSON.parse((await h.client.get(h.key("case", id)))!);}
async function legacyUnflagged(h: Fixture, id: string) {
  const data = await record(h, id); delete data.markerPushedAt;
  await h.client.set(h.key("case", id), JSON.stringify(data), {KEEPTTL: true});
}
test("actual panel close before lifecycle CAS creates fresh case and notification ledgers", crossOptions, () => run(async h => {
  const first = await h.create(), snapshot = await h.sosStore.snapshot(h.instance, h.phone);
  let cleared = false; h.setHook(async () => {cleared = await h.sosStore.clear(h.instance, h.phone, snapshot);});
  const second = await h.create({signalId: "new_signal"});
  assert.equal(h.hookUsed(), true); assert.equal(cleared, true); assert.notEqual(second.id, first.id);
  assert.equal((await record(h, first.id)).status, "resolved"); assert.equal((await record(h, second.id)).status, "open");
  assert.equal(await h.client.get(h.key("active")), second.id); assert.equal(h.store.records.size, 4);
  assert.equal(JSON.parse((await h.client.get(h.key("marker")))!).caseRevision, second.revision);
}));
test("actual panel close after atomic signal rejects stale raw snapshot at same millisecond", crossOptions, () => run(async h => {
  const first = await h.create(), snapshot = await h.sosStore.snapshot(h.instance, h.phone);
  let cleared = true; h.setHook(async () => {cleared = await h.sosStore.clear(h.instance, h.phone, snapshot);}, "after");
  const second = await h.create({signalId: "new_signal"});
  assert.equal(h.hookUsed(), true); assert.equal(cleared, false); assert.equal(second.id, first.id);
  assert.equal((await record(h, second.id)).status, "open"); assert.equal(await h.client.get(h.key("active")), second.id);
  assert.notEqual(first.revision, second.revision); assert.equal(h.store.records.size, 2);
  assert.equal(JSON.parse((await h.client.get(h.key("marker")))!).signalId, "new_signal");
}));
test("legacy unflagged bump loses to actual panel close without reopening or appending history", crossOptions, () => run(async h => {
  const first = await h.create(); await legacyUnflagged(h, first.id);
  const snapshot = await h.sosStore.snapshot(h.instance, h.phone), count = await h.client.lLen(h.key("history"));
  h.setHook(async () => {assert.equal(await h.sosStore.clear(h.instance, h.phone, snapshot), true);});
  assert.equal(await h.cases.bumpOperatorCaseSignal(h.instance, h.phone), false); assert.equal(h.hookUsed(), true);
  assert.equal((await record(h, first.id)).status, "resolved"); assert.equal(await h.client.get(h.key("active")), null);
  assert.equal(await h.client.get(h.key("marker")), null); assert.equal(await h.client.lLen(h.key("history")), count);
}));
test("history has one flag, full TTL, bounded inbox/index and expired SOS cleanup", options, () => run(async h => {
  await h.client.zAdd(h.key("sos"), [{score: h.time() - 1, value: "77000000003"}]);
  const first = await h.create(); await h.create({signalId: "second_signal"}); await h.cases.bumpOperatorCaseSignal(h.instance, h.phone);
  assert.equal(await h.client.lLen(h.key("history")), 1); assert.ok((await h.client.ttl(h.key("history"))) > 604790);
  assert.ok((await h.client.ttl(h.key("inbox"))) > 604790); assert.ok((await h.client.ttl(h.key("index"))) > 604790);
  assert.ok((await h.client.ttl(h.key("marker"))) > 3590); assert.ok((await h.client.ttl(h.key("unread"))) > 3590);
  assert.equal(await h.client.zScore(h.key("sos"), "77000000003"), null); assert.equal(await h.client.get(h.key("active")), first.id);
}));
test("flagging a valid legacy case rotates and synchronizes revision without duplicate history", crossOptions, () => run(async h => {
  const first = await h.create(); await legacyUnflagged(h, first.id);
  assert.equal(await h.cases.bumpOperatorCaseSignal(h.instance, h.phone), true);
  const changed = await record(h, first.id), marker = JSON.parse((await h.client.get(h.key("marker")))!);
  assert.notEqual(changed.revision, first.revision); assert.equal(changed.revision, marker.caseRevision);
  assert.equal(await h.client.lLen(h.key("history")), 1);
  assert.equal(await h.sosStore.clear(h.instance, h.phone, await h.sosStore.snapshot(h.instance, h.phone)), true);
}));
test("stale cleanup cannot remove a replacement active case at the mutation boundary", options, () => run(async h => {
  const first = await h.create(); h.advance(h.cases.CASE_FLAG_QUIET_MS + 1);
  let replacement: any;
  h.setHook(async () => {
    // Remove only the old pointer, then create an independent new episode.
    await h.client.del(h.key("active")); replacement = await h.create({signalId: "replacement"});
  });
  assert.equal(await h.cases.bumpOperatorCaseSignal(h.instance, h.phone), false); assert.equal(h.hookUsed(), true);
  assert.notEqual(replacement.id, first.id); assert.equal(await h.client.get(h.key("active")), replacement.id);
  assert.equal(JSON.parse((await h.client.get(h.key("marker")))!).caseId, replacement.id);
}));
test("stale episode cleanup preserves canonical history and accepted legacy ledger", options, () => run(async h => {
  const first = await h.create(); await h.client.set(h.key("ledger", first.id), "accepted", {EX: 604800}); h.advance(h.cases.CASE_FLAG_QUIET_MS + 1);
  assert.equal(await h.cases.bumpOperatorCaseSignal(h.instance, h.phone), false);
  assert.equal(await h.client.get(h.key("active")), null); assert.ok(await h.client.get(h.key("marker")));
  assert.ok(await h.client.get(h.key("unread"))); assert.ok(await h.client.zScore(h.key("sos"), h.phone));
  assert.equal(await h.client.get(h.key("ledger", first.id)), "accepted"); assert.equal(await h.client.lLen(h.key("history")), 1);
  assert.equal((await record(h, first.id)).status, "open");
}));
test("technical recovery refuses canonical-only replacement under unchanged marker", options, () => run(async h => {
  const first = await h.create({kind: "unresolved", source: "ai_unavailable"}), rawMarker = await h.client.get(h.key("marker"));
  h.setHook(async () => {
    const changed = await record(h, first.id); changed.kind = "complaint"; changed.source = "ai_tool_escalate_to_admin"; changed.revision = "new-real-complaint";
    await h.client.set(h.key("case", first.id), JSON.stringify(changed), {KEEPTTL: true});
  });
  assert.equal(await h.cases.resolveTechnicalSosAfterRecovery(h.instance, h.phone), false); assert.equal(h.hookUsed(), true);
  assert.equal((await record(h, first.id)).kind, "complaint"); assert.equal(await h.client.get(h.key("marker")), rawMarker);
  assert.equal(await h.client.get(h.key("active")), first.id);
}));
test("technical recovery clears only its matching open episode and keeps ledger and TTL", options, () => run(async h => {
  const first = await h.create({kind: "unresolved", source: "ai_unavailable"}); await h.client.set(h.key("ledger", first.id), "accepted", {EX: 604800});
  assert.equal(await h.cases.resolveTechnicalSosAfterRecovery(h.instance, h.phone), true);
  assert.equal((await record(h, first.id)).resolution, "automatic_recovery"); assert.ok((await h.client.ttl(h.key("case", first.id))) > 604790);
  assert.equal(await h.client.get(h.key("active")), null); assert.equal(await h.client.get(h.key("marker")), null);
  assert.equal(await h.client.get(h.key("ledger", first.id)), "accepted"); assert.equal(await h.client.lLen(h.key("history")), 1);
}));
for (const name of ["unread", "sos", "inbox", "index", "history"]) {
  test(`create prevalidates ${name} WRONGTYPE without partial canonical/marker/pointer writes`, options, () => run(async h => {
    const bad = h.key(name);
    if (name === "unread") await h.client.rPush(bad, "wrong"); else await h.client.set(bad, "wrong");
    await assert.rejects(h.create(), /OPERATOR_LIFECYCLE_WRONGTYPE/);
    assert.equal(await h.client.get(h.key("active")), null); assert.equal(await h.client.get(h.key("marker")), null);
    let cases = 0; for await (const keys of h.client.scanIterator({MATCH: `operator_case:${h.instance}:*`})) cases += keys.length;
    assert.equal(cases, 0); assert.equal(h.store.records.size, 0);
  }));
}
for (const operation of ["bump", "recovery"]) {
  test(`${operation} prevalidates WRONGTYPE before touching the canonical state`, options, () => run(async h => {
    const first = await h.create({kind: "unresolved", source: "ai_unavailable"});
    if (operation === "bump") await legacyUnflagged(h, first.id);
    const before = await h.client.get(h.key("case", first.id)), marker = await h.client.get(h.key("marker"));
    await h.client.del(h.key("sos")); await h.client.set(h.key("sos"), "wrong");
    const action = operation === "bump" ? h.cases.bumpOperatorCaseSignal(h.instance, h.phone) : h.cases.resolveTechnicalSosAfterRecovery(h.instance, h.phone);
    await assert.rejects(action, /OPERATOR_LIFECYCLE_WRONGTYPE/);
    assert.equal(await h.client.get(h.key("case", first.id)), before); assert.equal(await h.client.get(h.key("marker")), marker);
    assert.equal(await h.client.get(h.key("active")), first.id);
  }));
}

test("SOS producer retention: one-hour marker unread and score keep the seven-day case", options, () => run(async h => {
  const first = await h.create(), marker = JSON.parse((await h.client.get(h.key("marker")))!);
  assert.equal(marker.startedAt, h.time()); assert.equal(marker.expiresAt, h.time() + 3600000);
  assert.equal(await h.client.zScore(h.key("sos"), h.phone), h.time() + 3600000);
  for (const key of [h.key("marker"), h.key("unread")]) {
    const ttl = await h.client.ttl(key); assert.ok(ttl > 3590 && ttl <= 3600);
  }
  for (const key of [h.key("case", first.id), h.key("active"), h.key("history")]) assert.ok((await h.client.ttl(key)) > 604790);
}));

test("SOS producer retention: accelerated Redis expiry removes the signal without case or accepted-ledger loss", crossOptions, () => run(async h => {
  const first = await h.create();
  assert.ok((await h.client.ttl(h.key("marker"))) <= 3600);
  const canonical = await h.client.get(h.key("case", first.id));
  await h.client.set(h.key("ledger", first.id), "accepted", {EX: 604800});
  h.advance(3599999); assert.equal((await h.sosStore.list(h.instance)).length, 1);
  // The production TTL is asserted above; only disposable Redis expiry is accelerated.
  for (const key of [h.key("marker"), h.key("unread")]) await h.client.pExpireAt(key, Date.now() - 1);
  h.advance(1); assert.equal(await h.client.get(h.key("marker")), null); assert.equal(await h.client.get(h.key("unread")), null);
  assert.deepEqual(await h.sosStore.list(h.instance), []); assert.equal(await h.client.zScore(h.key("sos"), h.phone), null);
  assert.equal(await h.client.get(h.key("case", first.id)), canonical); assert.equal(await h.client.get(h.key("active")), first.id);
  assert.equal(await h.client.get(h.key("ledger", first.id)), "accepted"); assert.equal(await h.client.lLen(h.key("history")), 1);
  assert.ok((await h.client.ttl(h.key("case", first.id))) > 604790);
}));

test("SOS producer retention: existing flag bump does not renew signal origin or TTL", options, () => run(async h => {
  await h.create(); const raw = await h.client.get(h.key("marker"));
  await h.client.expire(h.key("marker"), 1800); await h.client.expire(h.key("unread"), 1800);
  h.advance(1000); await h.cases.bumpOperatorCaseSignal(h.instance, h.phone);
  assert.equal(await h.client.get(h.key("marker")), raw);
  for (const key of [h.key("marker"), h.key("unread")]) assert.ok((await h.client.ttl(key)) <= 1800);
  assert.equal(JSON.parse(raw!).expiresAt - JSON.parse(raw!).startedAt, 3600000);
}));

test("SOS producer retention: stale panel ACK cannot clear a newer one-hour signal", crossOptions, () => run(async h => {
  await h.create(); const old = await h.sosStore.snapshot(h.instance, h.phone);
  h.advance(3599999); await h.create({signalId: "newer_signal"});
  const current = await h.client.get(h.key("marker"));
  assert.equal(await h.sosStore.acknowledge(h.instance, h.phone, old), false);
  assert.equal(await h.sosStore.clear(h.instance, h.phone, old), false);
  assert.equal(await h.client.get(h.key("marker")), current);
  const row = JSON.parse(current!); assert.equal(row.signalId, "newer_signal"); assert.equal(row.expiresAt - row.startedAt, 3600000);
  assert.ok((await h.client.ttl(h.key("marker"))) <= 3600); assert.equal(await h.client.get(h.key("unread")), "newer_signal");
}));

test("SOS producer retention: a later write removes only expired index members", options, () => run(async h => {
  await h.client.zAdd(h.key("sos"), [{score: h.time() - 1, value: "77000000003"}, {score: h.time() + 1800000, value: "77000000004"}]);
  await h.create();
  assert.equal(await h.client.zScore(h.key("sos"), "77000000003"), null);
  assert.equal(await h.client.zScore(h.key("sos"), "77000000004"), h.time() + 1800000);
  assert.equal(await h.client.zScore(h.key("sos"), h.phone), h.time() + 3600000);
}));
