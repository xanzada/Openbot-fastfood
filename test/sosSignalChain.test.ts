import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

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

const SOURCE = new URL("../src/services/operatorCase.service.ts", import.meta.url);

// --------------------------------------------------------------------------- B10
// The NX claim distinguishes "somebody already notified the site for this case"
// from "Redis could not answer". Both used to yield null, and null meant "do not
// send" - so one transient blip silently suppressed the site notification for the
// remaining 7 days of that case. The operator saw the red row; the site never
// heard. That is the shape of the 2026-08-21 incident.
test("a Redis error on the dedupe claim does not suppress the site notification", async () => {
  const source = await readFile(SOURCE, "utf8");
  const fn = source.slice(source.indexOf("async function notifyHubSos"), source.indexOf("// A case already sitting on the operator board"));
  assert.match(fn, /\.catch\(\(\) => "CLAIM_UNAVAILABLE" as const\)/, "a failed claim must be distinguishable from a taken one");
  assert.match(fn, /if \(claimed === null\) return;/, "only a genuinely taken claim stops the send");
  assert.doesNotMatch(fn, /if \(claimed !== "OK"\) return;/, "the old conflation must be gone");
});

test("only a claim we actually took is released on failure", async () => {
  const source = await readFile(SOURCE, "utf8");
  const fn = source.slice(source.indexOf("async function notifyHubSos"), source.indexOf("// A case already sitting on the operator board"));
  assert.match(fn, /const claimHeld = claimed === "OK";/);
  assert.match(fn, /if \(claimHeld\) await redisClient\.del\(dedupeKey\)/,
    "deleting a claim we never held would let the next signal double-notify the site");
});

// --------------------------------------------------------------------------- B11
// 400 INTEGRATION_COMMAND_INVALID (payload) and 401 INTEGRATION_SIGNATURE_INVALID
// (credential) are completely different faults. axios throws before
// assertAlemiResponse runs, so error.code was unset and both logged as the bare
// axios message - indistinguishable from a dropped connection. That is how the
// order_number:"not_found" payload regression survived 48 hours.
test("an SOS hub failure logs the status and the hub error code", async () => {
  const source = await readFile(SOURCE, "utf8");
  const fn = source.slice(source.indexOf("async function notifyHubSos"), source.indexOf("// A case already sitting on the operator board"));
  assert.match(fn, /error\?\.statusCode \?\? error\?\.response\?\.status/, "the HTTP status must be logged");
  assert.match(fn, /response\?\.data\?\.error\?\.code/, "the hub's own error code must be logged");
  assert.match(fn, /status=\$\{status\} hubCode=\$\{hubCode\}/, "both must appear in one greppable line");
  assert.match(fn, /case=\$\{args\.caseId\}/, "and the case id, so a suppressed case can be found");
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
  assert.equal(fireAndForget.length, 2, "both the new-case and the reuse branch must fire and forget");
  assert.match(create, /void notifyHubSos\([^;]*\)\.catch\(\(\) => undefined\)/s,
    "an unhandled rejection here would take the process down");
});

// ---------------------------------------------------------------------------- D5
// bumpOperatorCaseSignal pushed the red row and set the history TTL to 24h.
// saveToHistory only restores the 7-day TTL when it finds NO ttl at all, so it
// never repaired this - the conversations of exactly the guests who escalated were
// deleted six days early.
test("flagging a case does not shorten the chat history to 24 hours", async () => {
  const source = await readFile(SOURCE, "utf8");
  assert.match(source, /\.expire\(`history:\$\{instanceId\}:\$\{customerPhone\}`, CHAT_HISTORY_TTL_SECONDS\)/,
    "the red-row push must preserve the 7-day history TTL");
  assert.doesNotMatch(source, /\.expire\(`history:[^`]*`, 24 \* 60 \* 60\)/, "the 24h shortening must be gone");
  assert.equal(CHAT_HISTORY_TTL_SECONDS, 604800, "7 days, the value saveToHistory uses");
});

// --------------------------------------------------------------------------- B20
// chatwoot:inbox:{instance} was written in four places and never given a TTL, so
// it grew for the life of the deployment. The SOS index is scored by expiry and
// nothing pruned members whose score was already in the past, so it could report a
// guest as flagged an hour after their marker and unread key had expired.
test("the inbox index cannot grow forever", async () => {
  const source = await readFile(SOURCE, "utf8");
  const writes = source.match(/zAdd\(`chatwoot:inbox:\$\{[a-zA-Z.]+\}`/g) || [];
  const ttls = source.match(/expire\(`chatwoot:inbox:\$\{[a-zA-Z.]+\}`, CASE_TTL_SECONDS\)/g) || [];
  assert.ok(writes.length >= 4, `expected every inbox write to be found, saw ${writes.length}`);
  assert.equal(ttls.length, writes.length, "every inbox write must set the TTL alongside it");
});

test("expired SOS members are pruned out of the index", async () => {
  const source = await readFile(SOURCE, "utf8");
  const activate = source.slice(source.indexOf("async function activateSos"), source.indexOf("// The clarify-first gate needs to know"));
  assert.match(activate, /zRemRangeByScore\(sosIndexKey\(input\.instanceId\), 0, now\)/,
    "the index is scored by expiry, so anything scored in the past is dead and must go");
});

// ------------------------------------------------------- contract regressions
test("the per-case dedupe key and its release are unchanged", async () => {
  const source = await readFile(SOURCE, "utf8");
  // One case = one site notification, for the case's whole life. This is the
  // 2026-08-21 badge-showed-4 fix and must not regress.
  assert.match(source, /sos_hub_sent:\$\{args\.instanceId\}:\$\{args\.caseId\}/);
  assert.match(source, /EX: CASE_TTL_SECONDS, NX: true/);
  assert.match(source, /redisClient\.del\(dedupeKey\)/);
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
