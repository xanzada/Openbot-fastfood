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

const { derivedInboundId } = await import("../src/services/inboundGuard.service.js");
const read = (relative: string) => readFile(new URL(relative, import.meta.url), "utf8");

// Three inbound-pipeline defects, all found 2026-08-23. Each one loses or duplicates a
// guest message, and none of them is visible in a log line.

// ---------------------------------------------------------------------------- B24
test("every fromMe shape the gateway can send is recognised as our own message", async () => {
  const route = await read("../src/routes/whatsappWebhook.route.ts");
  const fn = route.slice(route.indexOf("function isOwnWhatsAppMessage"));
  const body = fn.slice(0, fn.indexOf("\n}"));

  // The miss that mattered: extractMessageId and isGroupMessage both accept a TOP-LEVEL
  // body.key, so {key:{fromMe:true,id:...}} reached the pipeline with fromMe:false. The
  // bot then answered its own outbound text, replied to that, and the spam counter muted
  // the real guest for 15 minutes.
  assert.match(body, /body\?\.key\?\.fromMe === true/);
  // The shapes that already worked must not have been dropped.
  assert.match(body, /body\?\.fromMe === true/);
  assert.match(body, /body\?\.isFromMe === true/);
  assert.match(body, /eventData\?\.key\?\.fromMe === true/);
  // And the two remaining nestings the other extractors accept.
  assert.match(body, /eventData\?\.fromMe === true/);
  assert.match(body, /body\?\.message\?\.key\?\.fromMe === true/);
});

test("the own-message check reads the same nestings the id extractor accepts", async () => {
  const guard = await read("../src/services/inboundGuard.service.ts");
  const route = await read("../src/routes/whatsappWebhook.route.ts");
  const extractor = guard.slice(guard.indexOf("export function extractMessageId"));
  const extractorBody = extractor.slice(0, extractor.indexOf("\n}"));
  const own = route.slice(route.indexOf("function isOwnWhatsAppMessage"));
  const ownBody = own.slice(0, own.indexOf("\n}"));

  // If the id extractor accepts a nesting the fromMe check does not, that nesting is a
  // loop waiting to happen. This asserts the pairing rather than a list of strings.
  for (const [label, extractorPath, ownPath] of [
    ["top-level key", /body\?\.key\?\.id/, /body\?\.key\?\.fromMe/],
    ["data.key", /body\?\.data\?\.key\?\.id/, /eventData\?\.key\?\.fromMe/],
    ["message.key", /body\?\.message\?\.key\?\.id/, /body\?\.message\?\.key\?\.fromMe/],
  ] as [string, RegExp, RegExp][]) {
    if (extractorPath.test(extractorBody)) {
      assert.ok(ownPath.test(ownBody), `${label}: accepted by extractMessageId but not checked for fromMe`);
    }
  }
});

// ---------------------------------------------------------------------------- B27
test("a payload with no id still gets a stable dedupe key", () => {
  const a = derivedInboundId("prestige", "77000000000", "Сәлем, пицца бар ма?");
  const b = derivedInboundId("prestige", "77000000000", "Сәлем, пицца бар ма?");
  assert.ok(a, "an id-less payload must still be deduplicable");
  assert.equal(a, b, "the same message must produce the same key on a replay");
  assert.match(a, /^derived:[0-9a-f]{40}$/);
});

test("different messages, phones and tenants never collide", () => {
  const base = derivedInboundId("prestige", "77000000000", "бір");
  assert.notEqual(base, derivedInboundId("prestige", "77000000000", "екі"), "different text");
  assert.notEqual(base, derivedInboundId("prestige", "77000000001", "бір"), "different phone");
  assert.notEqual(base, derivedInboundId("kabab-1", "77000000000", "бір"), "different tenant");
});

test("case and padding do not create a second key for one message", () => {
  assert.equal(
    derivedInboundId("prestige", "77000000000", "  Пицца БАР ма?  "),
    derivedInboundId("prestige", "77000000000", "пицца бар ма?")
  );
});

test("two captionless photos are two messages, not one", () => {
  // Without media metadata in the hash, a guest sending two photos back to back would
  // have the second one silently swallowed as a duplicate.
  const first = derivedInboundId("prestige", "77000000000", "", { mediaId: "AAA", timestamp: 111 });
  const second = derivedInboundId("prestige", "77000000000", "", { mediaId: "BBB", timestamp: 222 });
  assert.ok(first && second);
  assert.notEqual(first, second);
});

test("a payload with neither text nor media yields no key", () => {
  // Hashing nothing would make every empty event collide, blocking unrelated traffic.
  assert.equal(derivedInboundId("prestige", "77000000000", ""), "");
  assert.equal(derivedInboundId("prestige", "77000000000", "   ", {}), "");
});

test("the lock and the done-marker use the same key, so nothing stays locked", async () => {
  const guard = await read("../src/services/inboundGuard.service.ts");
  // The first version took the lock under the derived id and then marked the raw
  // messageId done - empty for exactly these payloads - which left a 180s processing lock
  // nobody released and only moved the replay window from 5s to 180s.
  assert.match(guard, /const dedupeId = messageId \|\| derivedInboundId\(/);
  assert.match(guard, /msg_done:\$\{instanceId\}:\$\{dedupeId\}/);
  assert.match(guard, /msg_processing:\$\{instanceId\}:\$\{dedupeId\}/);
  // No branch inside the guard may still mark the raw id.
  const fn = guard.slice(guard.indexOf("export async function guardIncomingMessage"));
  const body = fn.slice(0, fn.indexOf("\n}\n"));
  assert.doesNotMatch(body, /markInboundDone\(instanceId, messageId\)/);
  // And the id must reach the caller, which owns the rest of the turn.
  assert.match(guard, /dedupeId\?: string;/);
  assert.match(guard, /return \{ blocked: false, dedupeId \};/);

  const route = await read("../src/routes/whatsappWebhook.route.ts");
  assert.match(route, /if \(guard\.dedupeId\) messageId = guard\.dedupeId;/);
  assert.match(route, /let messageId = extractMessageId\(body\);/);
});

// ---------------------------------------------------------------------------- B23
test("a requeued part arms the latest-token marker in both storage paths", async () => {
  const guard = await read("../src/services/inboundGuard.service.ts");
  const fn = guard.slice(guard.indexOf("export async function requeueInboundText"));
  const body = fn.slice(0, fn.indexOf("\n}\n"));
  // Without this the part sat in a list no leader was waiting on, and the finishing turn
  // deleted it - so "nothing the guest wrote is silently lost" was not true.
  assert.match(body, /const latestKey = `inbound_buffer_latest:/);
  assert.match(body, /\.set\(latestKey, token, \{ EX: INBOUND_BUFFER_SECONDS \}\)/);
  // The Redis-unavailable fallback has to do the same, or the defect survives an outage.
  assert.match(body, /current\.latestToken = token;/);
});

test("parts that arrive mid-turn are re-armed, not swept away", async () => {
  const route = await read("../src/routes/whatsappWebhook.route.ts");
  // The end-of-turn sweep called drainInboundBuffer and discarded the rows. Anything
  // requeued DURING the turn was in those rows, so the guest's message vanished with no
  // reply at all.
  assert.match(route, /arrived mid-turn, re-arming/);
  assert.match(route, /await requeueInboundText\(\{ instanceId: ctx\.instanceId, phone: ctx\.phone, messageId: "", text: part \}\)/);
  // The sweep must still happen - leftovers from the burst we just answered have to go,
  // or they become a second reply.
  assert.match(route, /void drainInboundBuffer\(ctx\.instanceId, ctx\.phone\)/);
});
