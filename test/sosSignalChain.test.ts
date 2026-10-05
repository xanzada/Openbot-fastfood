import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { operatorFixture } from "./helpers/operatorNotificationFixture.js";
import { operatorNotificationKey } from "../src/services/operatorNotification.service.js";

// The SOS signal chain: guest complaint -> operator case record -> panel marker
// (chatwoot:sos*) -> hub command operator.sos.raised. Five defects in that chain,
// all found on 2026-08-22. The contract it must satisfy:
//   one case = one site notification, for the case's whole life;
//   a failed send releases the claim so the next signal retries;
//   a hub failure never touches the guest flow or the panel.

process.env.REDIS_URL = "redis://127.0.0.1:1";
process.env.REDIS_CONNECT_TIMEOUT_MS = "500";
process.env.REDIS_OPERATION_TIMEOUT_MS = "500";

const { redisClient, CHAT_HISTORY_TTL_SECONDS } = await import("../src/services/redis.service.js");

test.after(() => {
  if (redisClient.isOpen) redisClient.destroy();
});

import {lifecycleRedisEnabled, operatorLifecycleFixture} from "./helpers/operatorLifecycleFixture.js";
const lifecycleOptions = {skip: !lifecycleRedisEnabled && "Requires disposable real Redis for lifecycle TTL checks."};

const SOURCE = new URL("../src/services/operatorCase.service.ts", import.meta.url);

// --------------------------------------------------------------------------- B10
// The NX claim distinguishes "somebody already notified the site for this case"
// from "Redis could not answer". Both used to yield null, and null meant "do not
// send" - so one transient blip silently suppressed the site notification for the
// remaining 7 days of that case. The operator saw the red row; the site never
// heard. That is the shape of the 2026-08-21 incident.
test("a Redis claim error leaves a durable plan that retries after recovery", async () => {
  const h = operatorFixture(); await h.queue();
  const claim = h.store.claim.bind(h.store);
  h.store.claim = async () => {throw new Error("REDIS_UNAVAILABLE");};
  await h.run(); assert.equal(h.hub.length, 0);
  assert.equal((await h.store.get(operatorNotificationKey("fixture", "case_fixture", "hub")))?.status, "pending");
  h.store.claim = claim; await h.run(3000);
  assert.equal(h.hub.length, 1);
});

test("a worker cannot release another worker's lease", async () => {
  const h = operatorFixture(); const key = operatorNotificationKey("fixture", "case_fixture", "hub");
  assert.equal(await h.store.claim(key, "worker-first"), true);
  await h.store.release(key, "worker-second");
  assert.equal(await h.store.claim(key, "worker-second"), false);
  await h.store.release(key, "worker-first");
  assert.equal(await h.store.claim(key, "worker-second"), true);
});

// --------------------------------------------------------------------------- B11
// 400 INTEGRATION_COMMAND_INVALID (payload) and 401 INTEGRATION_SIGNATURE_INVALID
// (credential) are completely different faults. axios throws before
// assertAlemiResponse runs, so error.code was unset and both logged as the bare
// axios message - indistinguishable from a dropped connection. That is how the
// order_number:"not_found" payload regression survived 48 hours.
test("an SOS failure records safe HTTP status and Hub error code without customer data", async () => {
  const h = operatorFixture(); await h.queue();
  h.deps.sendHub = async () => {const error: any = new Error("Bearer forbidden-secret 70000000002");
    error.response = {status: 400, data: {error: {code: "INTEGRATION_COMMAND_INVALID"}}}; throw error;};
  await h.run();
  const failed = h.events.find(e => e.event === "retry_scheduled" && e.row.payload.channel === "hub");
  assert.equal(failed.row.last_error, "HTTP_400:INTEGRATION_COMMAND_INVALID");
  assert.doesNotMatch(failed.row.last_error, /forbidden|70000000002/);
});

// --------------------------------------------------------------------------- B13
// notifyHubSos is log-and-continue by contract, but it was awaited inside
// createOperatorCase, which sits on the guest's reply path. The hub call carries a
// 10s timeout and the rotated-secret retry can double it, so a slow hub added up
// to ~20s of silence before the guest's complaint was even acknowledged.
test("the guest never waits for the hub", async () => {
  const source = await readFile(SOURCE, "utf8");
  const create = source.slice(source.indexOf("export async function createOperatorCase"), source.indexOf("// The site gets the same signal"));
  assert.doesNotMatch(create, /await notifyHubSos\(/, "awaiting the hub blocks the reply path");
  const fireAndForget = create.match(/void notifyHubSos\(/g) || [];
  assert.equal(fireAndForget.length, 1, "the shared atomic new/reuse path must fire and forget");
  assert.match(create, /void notifyHubSos\([^;]*\)\.catch\(\(\) => undefined\)/s,
    "an unhandled rejection here would take the process down");
});

// ---------------------------------------------------------------------------- D5
// bumpOperatorCaseSignal pushed the red row and set the history TTL to 24h.
// saveToHistory only restores the 7-day TTL when it finds NO ttl at all, so it
// never repaired this - the conversations of exactly the guests who escalated were
// deleted six days early.
test("flagging a case does not shorten the chat history to 24 hours", lifecycleOptions, async () => {
  const h = await operatorLifecycleFixture();
  try {await h.create(); await h.cases.bumpOperatorCaseSignal(h.instance, h.phone);
    assert.equal(CHAT_HISTORY_TTL_SECONDS, 604800);
    assert.ok((await h.client.ttl(h.key("history"))) > CHAT_HISTORY_TTL_SECONDS - 10);
  } finally {await h.close();}
});

// --------------------------------------------------------------------------- B20
// chatwoot:inbox:{instance} was written in four places and never given a TTL, so
// it grew for the life of the deployment. The SOS index is scored by expiry and
// nothing pruned members whose score was already in the past, so it could report a
// guest as flagged an hour after their marker and unread key had expired.
test("the inbox index cannot grow forever", lifecycleOptions, async () => {
  const h = await operatorLifecycleFixture();
  try {await h.create(); await h.create({signalId: "second_signal"}); await h.cases.bumpOperatorCaseSignal(h.instance, h.phone);
    assert.ok((await h.client.ttl(h.key("inbox"))) > 604790);
    assert.equal(await h.client.zCard(h.key("inbox")), 1);
  } finally {await h.close();}
});

test("expired SOS members are pruned out of the index", lifecycleOptions, async () => {
  const h = await operatorLifecycleFixture();
  try {await h.client.zAdd(h.key("sos"), [{score: h.time() - 1, value: "77000000003"}]); await h.create();
    assert.equal(await h.client.zScore(h.key("sos"), "77000000003"), null);
    assert.ok((await h.client.zScore(h.key("sos"), h.phone))! > h.time());
  } finally {await h.close();}
});

// ------------------------------------------------------- contract regressions
test("one case retains a single delivery ledger and retries its stable signal", async () => {
  const h = operatorFixture(); await h.queue();
  let failures = 1;
  h.deps.sendHub = async (payload: any) => {h.hub.push(payload); if (failures-- > 0) throw new Error("ECONNRESET"); return {ok: true};};
  await h.run(1000); await h.queue(); await h.run(3000); await h.run(9000);
  assert.equal(h.hub.length, 2);
  assert.equal(h.hub[0].signalId, h.hub[1].signalId);
  assert.equal((await h.store.get(operatorNotificationKey("fixture", "case_fixture", "hub")))?.status, "delivered");
  assert.equal(h.sends.length, 1);
});

test("the SOS marker, unread key and index carry a shift-long SOS TTL", async () => {
  const { SOS_TTL_SECONDS, CASE_TTL_SECONDS, sosMarkerKey, sosUnreadKey, sosIndexKey } =
    await import("../src/services/operatorCase.service.js");
  // 24h, not the original 1h: a complaint raised at night was gone from the SOS column
  // before the morning shift read it, and the site's badge had no count to show
  // (owner report, 2026-08-27). whatspro-gateway/services/sosStore.js prunes the index
  // on the same number, so the two must be changed together.
  assert.equal(SOS_TTL_SECONDS, 86400);
  // Still comfortably inside the case's own life, so the red row and the SOS flag can
  // never disagree about an episode that is still live.
  assert.ok(SOS_TTL_SECONDS < CASE_TTL_SECONDS);
  assert.equal(CASE_TTL_SECONDS, 604800);
  assert.equal(sosMarkerKey("prestige", "77769156184"), "chatwoot:sos:prestige:77769156184");
  assert.equal(sosUnreadKey("prestige", "77769156184"), "chatwoot:sos-unread:prestige:77769156184");
  assert.equal(sosIndexKey("prestige"), "chatwoot:sos:prestige");
});

test("decideCaseFlag still refuses to double-flag and still expires a stale case", async () => {
  const { decideCaseFlag, CASE_FLAG_QUIET_MS } = await import("../src/services/operatorCase.service.js");
  const now = Date.now();
  assert.equal(decideCaseFlag({ markerPushedAt: now }, now), "already_flagged");
  assert.equal(decideCaseFlag({ updatedAt: now - CASE_FLAG_QUIET_MS - 1000 }, now), "stale");
  assert.equal(decideCaseFlag({ updatedAt: now - 1000 }, now), "flag");
});

test("the hub payload still carries exactly the documented SOS fields", async () => {
  const api = await readFile(new URL("../src/services/alemiApi.service.ts", import.meta.url), "utf8");
  const fn = api.slice(api.indexOf("export async function reportOperatorSos"), api.indexOf("// A 200 whose body is not a link"));
  assert.match(fn, /"operator\.sos\.raised"/);
  for (const field of ["case_id", "signal_id", "phone", "kind", "created_at"]) {
    assert.ok(fn.includes(field), `the hub contract requires ${field}`);
  }
  // A placeholder order reference voided the WHOLE command for 48h (2026-08-21).
  assert.match(fn, /realOrderReference\(input\.orderNumber\)/);
});
