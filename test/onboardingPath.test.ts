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

// Three onboarding-path defects, found 2026-08-23. All three bite exactly when a new
// restaurant is added - the moment the SaaS needs to look flawless.

// ---------------------------------------------------------------------------- D26
test("missing payment requisites no longer promise an operator who was never told", async () => {
  const kanban = await read("../src/controllers/kanban.ts");
  // The old wording ("подождите ответ оператора") fired precisely when nobody had been
  // told anything: payment_details empty is the normal state before kitchen settings are
  // filled in, and the only record was an audit line.
  assert.match(kanban, /Төлем реквизиттері қазір нақтылануда/);
  assert.match(kanban, /Реквизиты для оплаты сейчас уточняются/);
  assert.doesNotMatch(kanban, /Реквизиты пока не настроены\. Пожалуйста, подождите ответ оператора/);
});

// ---------------------------------------------------------------------------- D27
test("an unresolved tenant is reported, not logged as bot_paused", async () => {
  const route = await read("../src/routes/whatsappWebhook.route.ts");
  const block = route.slice(route.indexOf("if (!instanceId) {"));
  const body = block.slice(0, block.indexOf("if (!(await isTenantBotEnabled"));
  // A message from a real number that no tenant claims means either a misconfigured gateway
  // or a new tenant whose config has not landed - both need a human.
  assert.match(body, /TENANT_UNRESOLVED_FOR_INBOUND/);
  assert.match(body, /notifyDeveloperSystemFailure/);
  assert.match(body, /no tenant config matches this WhatsApp number/);
  // The message still ends there (there is nowhere to reply), but visibly.
  assert.match(body, /scope: "tenant_resolution"/);
});

test("the bot_paused branch cannot swallow an unresolved tenant any more", async () => {
  const route = await read("../src/routes/whatsappWebhook.route.ts");
  const unresolved = route.indexOf("if (!instanceId) {");
  const paused = route.indexOf('reason=bot_paused');
  assert.ok(unresolved > 0 && paused > unresolved, "the unresolved guard must precede bot_paused");
  // And between them, instanceId is guaranteed non-empty, so bot_paused only fires for a
  // real paused tenant.
  const between = route.slice(unresolved, paused);
  assert.ok(between.includes("isTenantBotEnabled"), "the paused check comes after resolution");
});

// ---------------------------------------------------------------------------- D28
test("a newly attached WhatsApp number triggers one refresh on a cache miss", async () => {
  const pc = await read("../src/services/platformConfig.service.ts");
  const fn = pc.slice(pc.indexOf("export async function getRestaurantConfigByWhatsAppPhone"));
  const body = fn.slice(0, fn.indexOf("function findRestaurantConfigByWhatsAppPhone"));
  // Same onboarding contract the alemi-instance lane already has.
  assert.match(body, /getAllRestaurantConfigs\(\{ forceRefresh: Boolean\(options\.forceRefresh\) \}\)/);
  assert.match(body, /getAllRestaurantConfigs\(\{ forceRefresh: true \}\)/);
  // The second attempt must not loop forever.
  assert.match(body, /if \(options\.forceRefresh\) return null;/);
  // The lookup logic is shared, not duplicated.
  assert.match(pc, /findRestaurantConfigByWhatsAppPhone\(normalized, configs\)/);
});

test("the phone lookup helper returns null, not undefined, on a miss", async () => {
  const pc = await read("../src/services/platformConfig.service.ts");
  const helper = pc.slice(
    pc.indexOf("function findRestaurantConfigByWhatsAppPhone"),
    pc.indexOf("export function findRestaurantConfigByAlemiInstance")
  );
  // `|| null` without the closing paren was a syntax error in the first attempt; and the
  // helper must return null so the caller's force-refresh path can distinguish "not yet".
  assert.match(helper, /return match \|\| null;/);
});
