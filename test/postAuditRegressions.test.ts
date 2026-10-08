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

const guard = await import("../src/services/inboundGuard.service.js");
const { claimReceiptFingerprint } = await import("../src/services/redis.service.js");
const read = (relative: string) => readFile(new URL(relative, import.meta.url), "utf8");

// Four defects found 2026-08-23 by a fresh audit of the post-26-wave tree. Two of them are
// regressions of earlier waves in this same campaign, which is why they are covered here
// rather than trusted.

// ---------------------------------------------------------------------------- D23
test("the detailed health view is not public", async () => {
  const source = await read("../src/routes/system.route.ts");
  // Verified live before the fix: https://openbot.alemi.kz/health/detailed answered 200 to
  // an anonymous GET with every tenant id, the Redis host:port, which secrets are present,
  // the model chain and per-tenant hub status.
  assert.match(source, /router\.get\("\/health\/detailed", verifySecret\("webhook"\)/);
  // The plain /health probe must stay public - an uptime checker has no token.
  const plain = source.slice(source.indexOf('router.get("/health"'));
  assert.match(plain.slice(0, 120), /router\.get\("\/health", \(_req, res\)/);
});

test("the detailed view is also an amplifier, so the gate matters twice", async () => {
  const diagnostics = await read("../src/services/diagnostics.service.ts");
  // One anonymous request fans out a SIGNED hub call per tenant. With 30 restaurants that
  // is 30 outbound calls against the partner's API per hit, which is the reason this is P0
  // and not a tidiness issue.
  assert.match(diagnostics, /getAllRestaurantConfigs\(\)/);
  assert.match(diagnostics, /alemi_hub\[/);
});

// --------------------------------------------------------------------------- B27b
test("senderMeta actually carries the media fields the dedupe hashes", async () => {
  // My own regression from ea32304: derivedInboundId hashed senderMeta.mediaId /
  // mediaSha256 / mediaUrl / messageTimestamp, and extractSenderMeta returned none of them.
  // mediaMark was therefore always empty, so two uncaptioned photos hashed identically -
  // the first set msg_done for 24h and the second was dropped as duplicate_done. A guest
  // paying in two transfers lost their second receipt. The original test passed only
  // because it fed those fields by hand.
  const meta = guard.extractSenderMeta({
    pushName: "Айгүл",
    messageTimestamp: 1787500000,
    message: {
      imageMessage: { id: "MEDIA-AAA", fileSha256: "sha-aaa", url: "https://x/y.enc" },
    },
  });
  assert.equal(meta.mediaId, "MEDIA-AAA");
  assert.equal(meta.mediaSha256, "sha-aaa");
  assert.equal(meta.mediaUrl, "https://x/y.enc");
  assert.equal(meta.messageTimestamp, "1787500000");
  // The contact fields must survive untouched.
  assert.equal(meta.pushName, "Айгүл");
});

test("two uncaptioned photos are two messages, end to end", () => {
  // The real shape: no caption, so both carry the same placeholder text. Before the fix
  // both produced the same derived id.
  const first = guard.derivedInboundId(
    "prestige",
    "77000000000",
    "[Photo sent]",
    guard.extractSenderMeta({ message: { imageMessage: { id: "AAA", fileSha256: "sha-a" } }, messageTimestamp: 1 })
  );
  const second = guard.derivedInboundId(
    "prestige",
    "77000000000",
    "[Photo sent]",
    guard.extractSenderMeta({ message: { imageMessage: { id: "BBB", fileSha256: "sha-b" } }, messageTimestamp: 2 })
  );
  assert.ok(first && second);
  assert.notEqual(first, second, "the second receipt must not be swallowed as a duplicate");
});

test("a media payload with nothing stable to hash is not deduped at all", () => {
  // Collapsing two unidentifiable photos into one id loses the second, so no key is issued
  // and the older per-message protections apply instead.
  assert.equal(guard.derivedInboundId("prestige", "77000000000", "[Photo sent]", {}), "");
  assert.equal(guard.derivedInboundId("prestige", "77000000000", "[Media sent]", {}), "");
  // Real text is still deduped normally.
  assert.notEqual(guard.derivedInboundId("prestige", "77000000000", "пицца бар ма?", {}), "");
});

// ---------------------------------------------------------------------------- D24
test("an unreadable receipt claim is not read as a duplicate", async () => {
  // Redis is unreachable in this suite, so this is the real path.
  assert.equal(await claimReceiptFingerprint("probe", "fp-1"), "error");

  const route = await read("../src/routes/whatsappWebhook.route.ts");
  // false means "already claimed"; "error" means we could not tell. Only false may produce
  // the "do not send one receipt twice" answer, because that answer accuses the guest.
  assert.match(route, /const fingerprintClaim = await claimReceiptFingerprint\(/);
  assert.match(route, /if \(fingerprintClaim === false && strictFilter\)/);
  // The old truthiness test would have treated "error" as claimed.
  assert.doesNotMatch(route, /if \(!\(await claimReceiptFingerprint\(/);
});

// ---------------------------------------------------------------------------- B33
test("finishing an order does not erase the conversation", async () => {
  const kanban = await read("../src/controllers/kanban.ts");
  // history:{instance}:{phone} is the SHARED key: whatspro's legacyHistory, the store for
  // openbot_operator_case red-row markers, and what lastCustomerLanguage and
  // lastDiscussedOrderNumber read. Deleting it on completion meant a guest who complained a
  // minute later was greeted as a stranger with an empty operator thread.
  // Terminal pointer clearing now commits atomically with preserved history and cursor.
  assert.match(kanban, /clearOrderPointer: newStatus === "completed" \|\| newStatus === "cancelled" \|\| action === "order_rejected"/);
  assert.doesNotMatch(kanban, /del\(\[`history:\$\{instance\}:\$\{phone\}`/);
  const redis = await read("../src/services/redis.service.ts");
  const finishStart = redis.indexOf("export async function finishSiteNotification(");
  const finishEnd = redis.indexOf("function languageKey(", finishStart);
  assert.ok(finishStart >= 0 && finishEnd > finishStart);
  const finish = redis.slice(finishStart, finishEnd);
  assert.ok(finish.includes('keys: [claim.key, claim.leaseKey, historyKey(s.instance, s.payload?.phone || "no_send"), orderNotifyCursorKey(s.instance, s.orderId), `last_order:${s.instance}:${s.payload?.phone || "no_send"}`]'));
  assert.match(finish, /result !== 1[\s\S]*?NOTIFICATION_EFFECTS_NOT_COMMITTED/);
  const luaStart = redis.indexOf("const siteNotificationFinishLua =");
  const luaEnd = redis.indexOf("function validSiteNotificationPayload(", luaStart);
  assert.ok(luaStart >= 0 && luaEnd > luaStart);
  const lua = redis.slice(luaStart, luaEnd);
  assert.ok(lua.includes("redis.call('RPUSH',KEYS[3],entry);redis.call('LTRIM',KEYS[3],-tonumber(ARGV[6]),-1)"));
  assert.ok(lua.includes("if ttl<tonumber(ARGV[7]) then redis.call('EXPIRE',KEYS[3],ARGV[7]) end"));
  // The same terminal effect is now guarded by the currently cached order identity.
  const pointerStart = lua.indexOf("  if s.payload.clearOrderPointer then\n");
  const pointerEnd = lua.indexOf("\n  s.phase='complete'", pointerStart);
  assert.ok(pointerStart >= 0 && pointerEnd > pointerStart);
  const pointer = lua.slice(pointerStart, pointerEnd);
  assert.ok(lua.includes("if s.phase~='acknowledged' or not s.payload or not s.acknowledgedAt then return 0 end"));
  assert.ok(pointer.includes("local cacheType=redis.pcall('TYPE',KEYS[5])"));
  assert.ok(pointer.includes("local cacheRaw=cacheType.ok=='string' and redis.pcall('GET',KEYS[5]) or false"));
  assert.ok(pointer.includes("if type(cacheRaw)=='string' then decoded,c=pcall(cjson.decode,cacheRaw) end"));
  assert.match(pointer, /if decoded and type\(c\)=='table' then[\s\S]*?local matching=false;local proven=true/);
  assert.ok(pointer.includes("if id=='' or id~=s.orderId then proven=false else matching=true end"));
  assert.ok(pointer.includes("if c.order_id~=nil then checkId(c.order_id) end"));
  assert.ok(pointer.includes("for _,field in ipairs({'active_order','order'}) do"));
  assert.ok(pointer.includes("if type(c[field])~='table' or c[field].id==nil then proven=false"));
  assert.ok(pointer.includes("else checkId(c[field].id) end"));
  assert.ok(pointer.includes("if matching and proven then redis.call('DEL',KEYS[5]) end"));
  assert.equal((pointer.match(/redis\.call\('DEL',KEYS\[5\]\)/g) || []).length, 1);
  assert.doesNotMatch(lua, /redis\.call\('DEL',KEYS\[3\]\)/);
});
