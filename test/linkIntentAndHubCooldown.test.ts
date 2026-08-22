import test from "node:test";
import assert from "node:assert/strict";

process.env.REDIS_URL = "redis://127.0.0.1:1";
process.env.REDIS_CONNECT_TIMEOUT_MS = "500";
process.env.REDIS_OPERATION_TIMEOUT_MS = "500";

const {
  hasExplicitMenuLinkIntent,
  isMenuLinkResendRequest,
  wantsMenuAsText,
  hasBrokenLinkReport,
} = await import("../src/utils/magicLink.js");
const { hubAuthCooldownState, clearHubAuthCooldown } = await import("../src/services/dle.service.js");
const { redisClient } = await import("../src/services/redis.service.js");

test.after(() => {
  clearHubAuthCooldown();
  if (redisClient.isOpen) redisClient.destroy();
});

// ---------------------------------------------------------------------------- A2
// The link matchers compared RAW text only, while toolPolicy folds Kazakh through
// intentMatches. So "мазир жибер" (Kazakh typed on a Russian keyboard) pinned
// sendMenuLink but never made preloadContext mint the link: the skill found
// ctx.magicLink === null and answered link_not_needed with a null message. The
// guest asked for the ordering link and got a reply with no link and no reason.

test("Kazakh typed without Kazakh letters still asks for the link", () => {
  for (const text of [
    "мазир жибер",
    "мазирди жиберинiз",
    "силтемени жибер",
    "силтеме берши",
    "мазирди корсет",
  ]) {
    assert.equal(hasExplicitMenuLinkIntent(text), true, text);
  }
});

test("the properly spelled Kazakh still works - the fold must not replace it", () => {
  for (const text of ["мәзірді жіберіңіз", "сілтемені жіберіңіз", "мәзір бер", "тапсырыс берейін"]) {
    assert.equal(hasExplicitMenuLinkIntent(text), true, text);
  }
});

// A second, independent gap in the same file: the Russian words were spelled in the
// NOMINATIVE, so the accusative a guest actually types matched nothing. Kazakh
// worked by accident because its suffixes follow the stem.
test("Russian case endings are matched by stem, not only the dictionary form", () => {
  for (const text of [
    "ссылку скинь",
    "дайте ссылку",
    "ссылку отправьте",
    "ссылка",
    "меню скинь",
    "меню отправьте",
    "корзину открой",
  ]) {
    assert.equal(hasExplicitMenuLinkIntent(text), true, text);
  }
});

test("a resend request folds too", () => {
  assert.equal(isMenuLinkResendRequest("мазирди кайта жибер"), true);
  assert.equal(isMenuLinkResendRequest("силтеме жогалды"), true);
  assert.equal(isMenuLinkResendRequest("ссылку еще раз"), true);
  // "just now" still suppresses it, in both spellings.
  assert.equal(isMenuLinkResendRequest("жана гана силтеме келди"), false);
  assert.equal(isMenuLinkResendRequest("жаңа ғана сілтеме келді"), false);
});

test("asking for the menu IN WRITING is still not a link request", () => {
  // The 2026-08-12 defect: "мәзір" appears in the sentence, so every matcher used
  // to read it as a link request and the guest got the same URL twice. Both
  // spellings must be caught, or the folded form reopens the defect.
  for (const text of ["мазирди жазып жибер", "мәзірді жазып жіберіңіз"]) {
    assert.equal(wantsMenuAsText(text), true, text);
    assert.equal(hasExplicitMenuLinkIntent(text), false, text);
  }
  // wantsMenuAsText deliberately needs TWO signals (see the comment in
  // magicLink.ts): the "write it out" phrase AND either a declined link or a menu
  // word. "напишите список текстом" names no menu, so it is not a menu-as-text
  // request - but it must not trigger the link either, and that is the property
  // that matters here.
  assert.equal(hasExplicitMenuLinkIntent("напишите список текстом"), false);
});

test("a broken-link report is recognised in both spellings", () => {
  assert.equal(hasBrokenLinkReport("силтеме ашылмайды"), true);
  assert.equal(hasBrokenLinkReport("сілтеме ашылмайды"), true);
  assert.equal(hasBrokenLinkReport("ссылка не открывается"), true);
  // The short-message-plus-history shape must keep working.
  assert.equal(hasBrokenLinkReport("ол жасамай калды", ["мына силтеме: https://x.kz/?phone=77000000000&hash=ab"]), true);
  assert.equal(hasBrokenLinkReport("рахмет"), false);
});

test("ordinary conversation never asks for a link", () => {
  for (const text of ["салам", "рахмет", "қашан жеткізесіз", "калай жумыс жасайсыздар", "оператор керек"]) {
    assert.equal(hasExplicitMenuLinkIntent(text), false, text);
  }
});

// ---------------------------------------------------------------------------- D4
// runtimeWatch polls every enabled tenant every 45s, and getRuntimeStatus swallows
// the failure to return the Redis fallback - so the watcher could never learn to
// back off. One tenant whose hub credential is not accepted produced 477 identical
// error lines per 6 hours, ~480 platform reads and ~960 hub calls, burying every
// other error in the log. This is what EVERY new restaurant looks like between
// being registered in the hub and having its secret configured, so the SaaS gets
// one storm per onboarding.

test("the hub auth cooldown is per tenant and starts clear", () => {
  clearHubAuthCooldown();
  assert.equal(hubAuthCooldownState("kabab-1"), null);
  assert.equal(hubAuthCooldownState("prestige"), null);
});

test("the cooldown is exported so it can be inspected and cleared", () => {
  // An operator who fixes the secret must be able to clear the window rather than
  // wait it out, and a health report must be able to show which tenants are parked.
  assert.equal(typeof hubAuthCooldownState, "function");
  assert.equal(typeof clearHubAuthCooldown, "function");
  clearHubAuthCooldown("kabab-1");
  clearHubAuthCooldown();
});

test("only a 401 arms the cooldown, and the fallback answer is shared", async () => {
  const source = await import("node:fs/promises").then((fs) =>
    fs.readFile(new URL("../src/services/dle.service.ts", import.meta.url), "utf8"));

  // The classification: 401 backs off, anything else keeps its per-call log line.
  assert.match(source, /if \(status === 401\) noteHubAuthRejection\(instanceId, domain, error\);/);
  assert.match(source, /else auditError\("DLE runtime status read failed", error, \{ instanceId, domain \}\);/);

  // A tenant on cooldown must answer EXACTLY like one whose call just failed,
  // otherwise backing off would change behaviour instead of only the retry rate.
  assert.match(source, /return runtimeStatusFallback\(instanceId, backupKey, cacheKey\);/);
  const fallbackCalls = source.match(/return runtimeStatusFallback\(/g) || [];
  assert.equal(fallbackCalls.length, 2, "the cooldown path and the catch path must share one fallback");

  // The Redis kitchen record still comes first, then the stale backup.
  const fallback = source.slice(source.indexOf("async function runtimeStatusFallback"));
  assert.match(fallback, /getKitchenStatus\(instanceId\)/);
  assert.match(fallback, /stale_runtime_backup: true/);

  // And the log line says what an operator should actually do.
  assert.match(source, /configure alemi_secret for this tenant/);
});

test("the cooldown window is bounded and configurable", async () => {
  const source = await import("node:fs/promises").then((fs) =>
    fs.readFile(new URL("../src/services/dle.service.ts", import.meta.url), "utf8"));
  assert.match(source, /HUB_AUTH_COOLDOWN_MS = Math\.max\(60_000, Number\(process\.env\.HUB_AUTH_COOLDOWN_MS \|\| 30 \* 60 \* 1000\)\)/,
    "never shorter than a minute, so a misconfigured env cannot restore the storm");
});
