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

const read = (relative: string) => readFile(new URL(relative, import.meta.url), "utf8");

// C33 (whatspro) + C34 (openbot), found 2026-08-23. Neither loses a message outright; both
// degrade badly under conditions that WILL happen at 20-30 tenants.

// ---------------------------------------------------------------------------- C33
test("the media ladder treats an early miss as a wait, not a verdict", async () => {
  const source = await readFile(new URL("../services/whatsappManager.js", `file://${__filename}`), "utf8");
  const fn = source.slice(source.indexOf("function scheduleMediaPersist"));
  const body = fn.slice(0, fn.indexOf("\n}"));

  // The defect: hasAuthoritativeMessage was checked on the FIRST tick (1s), before the WAL
  // had written the message, and a false answer was treated as permanent. That disarmed the
  // whole 1s/3s/7s/15s/30s ladder on its own first step.
  assert.match(body, /const isLastTick = delayMs === delays\[delays\.length - 1\]/);
  assert.match(body, /if \(isLastTick\) permanentMediaFailures\.add\(failureKey\)/);

  // The permanent marker must NOT fire before the last tick.
  const earlyBranch = body.slice(body.indexOf("hasAuthoritativeMessage"), body.indexOf("isLastTick"));
  assert.doesNotMatch(earlyBranch, /permanentMediaFailures\.add/);
});

test("the last tick still gives up, so a truly dead media cannot loop forever", async () => {
  const source = await readFile(new URL("../services/whatsappManager.js", `file://${__filename}`), "utf8");
  const fn = source.slice(source.indexOf("function scheduleMediaPersist"));
  assert.match(fn, /delays = \[1000, 3000, 7000, 15000, 30000\]/);
  // After the final delay the verdict becomes permanent, as intended.
  assert.match(fn, /if \(isLastTick\) permanentMediaFailures\.add\(failureKey\)/);
});

// ---------------------------------------------------------------------------- C34
test("the customer outbox has the same brakes as the developer-alert outbox", async () => {
  const source = await read("../src/transport/whatspro.client.ts");
  const drain = source.slice(source.indexOf("export async function drainWhatsProOutbox"));

  // Cap on attempts (D12 gave this to dev alerts; customer replies never got it).
  assert.match(drain, /OPENBOT_OUTBOX_MAX_ATTEMPTS, 5/);
  assert.match(drain, /attempts >= MAX_ATTEMPTS/);
  // Age ceiling: a reply to a question from six hours ago is worse than no reply.
  assert.match(drain, /OPENBOT_OUTBOX_MAX_AGE_MS, 6 \* 60 \* 60_000/);
  assert.match(drain, /ageMs > AGE_LIMIT_MS/);
  // Abandonment must be greppable in production logs.
  assert.match(drain, /OPENBOT:OUTBOX:ABANDONED/);
});

test("an abandoned outbox entry is removed, not left as a file forever", async () => {
  const source = await read("../src/transport/whatspro.client.ts");
  const drain = source.slice(source.indexOf("OPENBOT:OUTBOX:ABANDONED"), source.indexOf("OPENBOT:OUTBOX:ABANDONED") + 600);
  // Before, only success removed the file copy, so every abandoned attempt left one behind
  // until the disk filled.
  assert.match(drain, /await removeOutbox\(record\.id\)/);
  // And it skips to the next record rather than retrying the same one again.
  assert.match(drain, /continue;/);
});
