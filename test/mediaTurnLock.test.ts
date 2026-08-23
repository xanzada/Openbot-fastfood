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

// B22, found 2026-08-23: the turn lock lived inside `if (!mediaContext && text)`, so a
// photo, a voice note or a receipt took no lock at all. Everything after that block is
// shared with the text lane - preloadContext, media analysis, the receipt lane, the agent,
// the send sequence - so a guest who sent a photo and then typed had two turns running over
// one conversation: two replies, and in the receipt lane two analyses of one payment.

test("the media lane acquires the turn lock too", async () => {
  const route = await read("../src/routes/whatsappWebhook.route.ts");
  // Two acquisition sites now: the text lane inside the buffer block, and the media lane
  // just before anything shared runs.
  assert.equal((route.match(/turnLockOwner = await waitForTurnLock\(\)/g) || []).length, 2);
  assert.match(route, /if \(!turnLockOwner\) \{\s*\n\s*turnLockOwner = await waitForTurnLock\(\);/);
});

test("the lock is taken before any shared work", async () => {
  const route = await read("../src/routes/whatsappWebhook.route.ts");
  const mediaAcquire = route.indexOf("media turn proceeding without the lock");
  const hydrate = route.indexOf("mediaContext = await hydrateInboundMedia(body, mediaContext)");
  const preload = route.indexOf("const ctx = await preloadContext(");
  assert.ok(mediaAcquire > 0 && hydrate > 0 && preload > 0);
  // Taking it after hydration or after preload would leave the expensive, stateful part of
  // the turn unprotected, which is the whole defect.
  assert.ok(mediaAcquire < hydrate, "the lock must precede media hydration");
  assert.ok(hydrate < preload, "and hydration still precedes preload");
});

test("the wait is shared, so the two lanes cannot drift apart", async () => {
  const route = await read("../src/routes/whatsappWebhook.route.ts");
  const fn = route.slice(route.indexOf("const waitForTurnLock = async () =>"));
  const body = fn.slice(0, fn.indexOf("\n    };"));
  // Same bounded wait the text lane always had: 45s in 1.5s steps.
  assert.match(body, /waited < 45_000; waited \+= 1_500/);
  assert.match(body, /acquireTurnLock\(instanceId, phone\)/);
  // Exactly one definition - a copied loop is how the two lanes would diverge.
  assert.equal((route.match(/const waitForTurnLock = async \(\) =>/g) || []).length, 1);
});

test("a media turn that cannot get the lock is not requeued as text", async () => {
  const route = await read("../src/routes/whatsappWebhook.route.ts");
  const media = route.slice(route.indexOf("media turn proceeding without the lock") - 900);
  const block = media.slice(0, media.indexOf("hydrateInboundMedia"));
  // A photo is not a text fragment, and dropping a paid receipt because a text turn was
  // busy would be worse than a rare double - the receipt lane has its own fingerprint
  // claim for that. So it proceeds, but says so.
  assert.doesNotMatch(block, /requeueInboundText/);
  assert.match(block, /console\.warn\(/);
  assert.match(block, /OPENBOT:TURN/);
});

test("both lanes release through the same finally", async () => {
  const route = await read("../src/routes/whatsappWebhook.route.ts");
  // One release site, keyed on the owner, so a media turn cannot leak the lock for its
  // whole TTL and block the conversation.
  assert.equal((route.match(/releaseTurnLock\(instanceId, phone, turnLockOwner\)/g) || []).length, 1);
  const fin = route.slice(route.lastIndexOf("} finally {"));
  assert.match(fin, /if \(turnLockOwner\) \{/);
  assert.match(fin, /turnLockOwner = null;/);
});
