import test from "node:test";
import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { readFile } from "node:fs/promises";

process.env.REDIS_URL = "redis://127.0.0.1:1";
process.env.REDIS_CONNECT_TIMEOUT_MS = "500";
process.env.REDIS_OPERATION_TIMEOUT_MS = "500";

const { redisClient } = await import("../src/services/redis.service.js");

test.after(() => {
  if (redisClient.isOpen) redisClient.destroy();
});

const read = (relative: string) => readFile(new URL(relative, import.meta.url), "utf8");

// The last of the audit findings: dead code that still reaches the internet, two
// vocabularies in one funnel, invented timestamps, an outbox nobody drained, an
// unbounded list, a misleading diagnostic, and tests whose result depended on the
// checkout shape. All found 2026-08-22.

// ---------------------------------------------------------------------------- A26
test("the unused web-search tool is gone, not just unregistered", async () => {
  // It was never in skills/index.ts and searchWeb had no caller, but it held a live
  // outbound HTTP path and a TAVILY_API_KEY that nothing audits. The owner confirmed
  // the agent does not need it.
  assert.equal(
    existsSync(new URL("../src/skills/tavilySearch.skill.ts", import.meta.url)),
    false,
    "the file must be deleted so nobody can wire an unaudited web tool back in"
  );
  const index = await read("../src/skills/index.ts");
  assert.doesNotMatch(index, /tavily/i);
  assert.doesNotMatch(index, /searchWeb/);
});

test("the nine real tools are still all registered", async () => {
  const { FAST_FOOD_SKILL_NAMES, createFastFoodSkills } = await import("../src/skills/index.js");
  assert.equal(FAST_FOOD_SKILL_NAMES.length, 9);
  const tools = createFastFoodSkills({ instanceId: "t", phone: "77000000001", language: "kk", config: {}, text: "" } as any);
  assert.equal(tools.length, 9);
});

// ---------------------------------------------------------------------------- A27
test("the CRM stage default matches the enum the tool declares", async () => {
  const writer = await read("../src/services/dle.service.ts");
  const tool = await read("../src/skills/crm.skill.ts");
  // The funnel groups on this value; defaulting to Kazakh literals split every stage
  // across two vocabularies and made stage analytics undercount.
  assert.match(writer, /sales_stage: data\.sales_stage \|\| "NEW"/);
  assert.doesNotMatch(writer, /sales_stage: data\.sales_stage \|\| "жаңа"/);
  assert.match(tool, /"NEW"/, "the tool still declares the uppercase enum");
});

// ---------------------------------------------------------------------------- A28
test("a stale kitchen read is never stamped with the current time", async () => {
  const skill = await read("../src/skills/runtimeStatus.skill.ts");
  // fetched_at fell back to "now" while is_last_known was true, so the model could
  // present a ten-minute-old kitchen state as read this second.
  assert.match(skill, /fetched_at: status\?\.fetched_at \|\| null/);
  assert.doesNotMatch(
    skill.split("\n").filter((line) => !line.trim().startsWith("//")).join("\n"),
    /fetched_at: status\?\.fetched_at \|\| new Date\(\)\.toISOString\(\)/
  );
});

// ---------------------------------------------------------------------------- D12
test("the developer-alert outbox is actually drained", async () => {
  const notify = await import("../src/services/developerNotify.service.js");
  assert.equal(typeof (notify as any).drainDeveloperAlertOutbox, "function",
    "an outbox nothing reads is a lie, not a retry");

  const source = await read("../src/services/developerNotify.service.ts");
  // A delivered alert must be removed from both the entry key and the index, or it
  // would be re-sent forever.
  assert.match(source, /\.del\(entryKey\)\.zRem\(indexKey, incidentId\)/);
  // A still-failing alert must be kept, not dropped.
  assert.match(source, /\/\/ Still failing\. Leave it for the next pass/);
  // And one dead tenant must not burn the whole budget.
  assert.match(source, /DEV_ALERT_RETRY_LIMIT/);
});

test("the drain has a caller, on a tick that already walks every tenant", async () => {
  const watch = await read("../src/cron/runtimeWatch.ts");
  assert.match(watch, /import \{ drainDeveloperAlertOutbox \}/);
  assert.match(watch, /await drainDeveloperAlertOutbox\(tenant\.instanceId\)/);
  // No NEW timer and no second tenant enumeration were introduced: the drain rides
  // the existing tick. runtimeWatch schedules itself with setTimeout and reschedules
  // in a finally block precisely so ticks cannot overlap, so the count to hold steady
  // is that one self-reschedule.
  assert.equal((watch.match(/setInterval/g) || []).length, 0, "this worker does not use setInterval");
  // The two known timers are the self-reschedule and the warm-up on boot. The drain
  // must not have added a third.
  assert.match(watch, /setTimeout\(tick, intervalMs\)\.unref\(\)/, "the self-reschedule");
  assert.match(watch, /setTimeout\(tick, 5_000\)\.unref\(\)/, "the boot warm-up");
  assert.equal((watch.match(/setTimeout\(/g) || []).length, 2, "no third timer was introduced");
  assert.equal((watch.match(/getAllRestaurantConfigs\(/g) || []).length, 1, "one tenant enumeration per tick");
});

// ---------------------------------------------------------------------------- D13
test("the daily CRM log cannot grow without bound inside its TTL", async () => {
  const redis = await read("../src/services/redis.service.ts");
  assert.match(redis, /const DAILY_LOG_MAX_ITEMS = Number\(process\.env\.DAILY_LOG_MAX_ITEMS \|\| 1000\)/);
  const fn = redis.slice(redis.indexOf("export async function saveDailyLog"), redis.indexOf("export async function saveDailyLog") + 900);
  assert.match(fn, /\.lTrim\(key, -DAILY_LOG_MAX_ITEMS, -1\)/);
  // Trim and TTL in one pipeline, so a lost round trip cannot leave the list untrimmed.
  assert.match(fn, /redisClient\.multi\(\)/);
  assert.match(fn, /\.expire\(key, DAILY_LOG_TTL_SECONDS\)/);
});

// ---------------------------------------------------------------------------- D18
test("a platform outage is not reported as a tenant misconfiguration", async () => {
  const diagnostics = await read("../src/services/diagnostics.service.ts");
  // When hydrate rejects, config is null and EVERY tenant was reported as carrying no
  // alemi_secret - sending the operator to fix tenant rows while the real fault was
  // the platform token.
  assert.match(diagnostics, /let configLoadError: unknown = null;/);
  assert.match(diagnostics, /tenant config could not be loaded/);
  // The genuine "field is empty" message must still exist for the case it describes.
  assert.match(diagnostics, /tenant carries no alemi_secret/);
  const order = diagnostics.indexOf("tenant config could not be loaded");
  const empty = diagnostics.indexOf("tenant carries no alemi_secret");
  assert.ok(order < empty, "the load failure must be checked before the empty-field case");
});

// ---------------------------------------------------------------------------- D22
test("deployment-artefact tests skip instead of deciding the suite result", async () => {
  const backup = await read("../test/backup.test.ts");
  const hygiene = await read("../test/repositoryHygiene.test.ts");
  // docker-compose.yml, backup/*.sh and scripts/agentSmoke.ts are not copied into the
  // container image, and repositoryHygiene shells out to git. Reading them at import
  // time made the suite result depend on the checkout shape and could never run in the
  // deployed image.
  assert.match(backup, /const artefactsPresent = artefacts\.every/);
  assert.match(backup, /skip: artefactsPresent \? false :/);
  assert.match(hygiene, /const hasRepository = \(\(\) => \{/);
  assert.match(hygiene, /skip: skipWithoutRepository/);
  // They must still assert something when the artefacts ARE there.
  assert.match(backup, /assert\.match\(compose, /);
  assert.match(hygiene, /assert\.equal\(trackedFiles\("\.env"\), ""/);
});
