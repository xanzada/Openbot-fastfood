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

const { decideCaseFlag, CASE_FLAG_QUIET_MS, CASE_TTL_SECONDS } = await import("../src/services/operatorCase.service.js");
const { saveCaseMedia, getCaseMedia } = await import("../src/services/redis.service.js");
const read = (relative: string) => readFile(new URL(relative, import.meta.url), "utf8");

// Two escalation-lifetime defects, found 2026-08-23. Both let an operator case outlive
// the thing it depends on.

// ---------------------------------------------------------------------------- B25
test("a flagged case can still go stale, so it eventually ends", () => {
  const now = Date.now();
  const day = 24 * 60 * 60 * 1000;
  const past = now - CASE_FLAG_QUIET_MS - 60_000;

  // The defect: the flag test ran BEFORE the quiet-window test, so a case that had been
  // flagged could never be reported stale. Measured pre-fix: a 6-day-old flagged case
  // still answered "already_flagged".
  assert.equal(decideCaseFlag({ updatedAt: past, markerPushedAt: past }, now), "stale");
  assert.equal(decideCaseFlag({ updatedAt: now - 3 * day, markerPushedAt: now - 3 * day }, now), "stale");
  assert.equal(decideCaseFlag({ createdAt: past, markerPushedAt: past }, now), "stale");
});

test("a live case is still flagged exactly once", () => {
  const now = Date.now();
  // One SOS = one notification has to survive the reordering: a fresh flagged case must
  // not raise a second red row just because the chat scrolled.
  assert.equal(decideCaseFlag({ createdAt: now - 60_000, markerPushedAt: now - 60_000 }, now), "already_flagged");
  assert.equal(decideCaseFlag({ updatedAt: now - 60_000 }, now), "flag");
  // And a case just inside the window keeps its flag.
  assert.equal(
    decideCaseFlag({ updatedAt: now - (CASE_FLAG_QUIET_MS - 60_000), markerPushedAt: now - 60_000 }, now),
    "already_flagged"
  );
});

test("an unflagged stale case is still swept, as before", () => {
  const now = Date.now();
  assert.equal(decideCaseFlag({ updatedAt: now - CASE_FLAG_QUIET_MS - 1 }, now), "stale");
  // A record with no timestamps at all must not be swept on a guess.
  assert.equal(decideCaseFlag({}, now), "flag");
  assert.equal(decideCaseFlag({ markerPushedAt: now }, now), "already_flagged");
});

test("sweeping a case releases the hub dedupe claim with the phone", async () => {
  const source = await read("../src/services/operatorCase.service.ts");
  const fn = source.slice(source.indexOf("export async function bumpOperatorCaseSignal"));
  const stale = fn.slice(fn.indexOf('if (decision === "stale")'));
  const body = stale.slice(0, stale.indexOf("\n  }") + 4);
  // Releasing the phone is what lets the next complaint open a NEW case, and a new case
  // id is what makes notifyHubSos speak to the site again - it dedupes per case for the
  // case's whole 7-day life.
  assert.match(body, /\.del\(activeKey\(instanceId, customerPhone\)\)/);
  assert.match(body, /\.del\(`sos_hub_sent:\$\{instanceId\}:\$\{caseId\}`\)/);
});

test("the staleness test precedes the flag test in the source", async () => {
  const source = await read("../src/services/operatorCase.service.ts");
  const fn = source.slice(source.indexOf("export function decideCaseFlag"));
  // Comments explain the defect and therefore mention both names in the other order;
  // only the executable lines decide behaviour.
  const code = fn
    .slice(0, fn.indexOf("\n}"))
    .split("\n")
    .filter((line) => !line.trim().startsWith("//"))
    .join("\n");
  // Ordering IS the fix, so assert the ordering rather than only the outcomes.
  assert.ok(
    code.indexOf('return "stale"') < code.indexOf('return "already_flagged"'),
    "the quiet-window check must come first, or a flagged case can never end"
  );
});

// ---------------------------------------------------------------------------- B26
test("photo evidence is kept for as long as the case that cites it", async () => {
  const source = await read("../src/services/redis.service.ts");
  // whatspro does store every inbound media on arrival and the panel renders it - that
  // part of the original report was wrong and was verified live (7 media keys per tenant).
  // The real defect is the lifetime: chat media lives STANDARD_TTL_SECONDS = 24h while a
  // case lives CASE_TTL_SECONDS = 7 days, so a two-day-old red row said hasMedia:true
  // with nothing behind it.
  assert.match(source, /const CASE_MEDIA_TTL_SECONDS = 7 \* 24 \* 60 \* 60;/);
  assert.match(source, /operator_case_media:\$\{instanceId\}:\$\{caseId\}/);
  assert.equal(CASE_TTL_SECONDS, 7 * 24 * 60 * 60, "the two lifetimes must be equal by construction");
});

test("the scratch copy is promoted before it is cleared", async () => {
  const source = await read("../src/services/complaintRouting.service.ts");
  const save = source.indexOf("await saveCaseMedia(");
  const clear = source.indexOf("await clearComplaintMedia(ctx.instanceId, ctx.phone)");
  assert.ok(save > 0 && clear > 0, "both calls must exist");
  assert.ok(save < clear, "deleting the only copy before promoting it is the defect itself");
  // Promotion is keyed on the case, so it cannot happen when no case was created.
  assert.match(source, /if \(media\?\.base64 && operatorCase\?\.id\)/);
});

test("the evidence helpers degrade quietly when Redis is unreachable", async () => {
  // This runs with REDIS_URL pointed at a closed port, so these are the real fallbacks.
  assert.equal(await saveCaseMedia("probe", "oc_1", { base64: "AAA", mimeType: "image/jpeg" }), false);
  assert.equal(await getCaseMedia("probe", "oc_1"), null);
  // Missing arguments must never reach Redis in the first place.
  assert.equal(await saveCaseMedia("", "oc_1", { base64: "AAA" }), false);
  assert.equal(await saveCaseMedia("probe", "", { base64: "AAA" }), false);
  assert.equal(await saveCaseMedia("probe", "oc_1", { base64: "" }), false);
  assert.equal(await getCaseMedia("probe", ""), null);
});
