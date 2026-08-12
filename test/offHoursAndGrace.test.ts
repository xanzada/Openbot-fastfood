import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

const webhook = await readFile(new URL("../src/routes/whatsappWebhook.route.ts", import.meta.url), "utf8");
const redis = await readFile(new URL("../src/services/redis.service.ts", import.meta.url), "utf8");

// Closed for the night is not a breakdown: saying "по технической причине" made a
// normal closing time sound like a failure and left the guest nothing to do about
// it (audit, 2026-08-12).
test("a guest who writes after closing time is told the hours, not blamed on a fault", () => {
  const branch = webhook.slice(webhook.indexOf("function closedKitchenReply"));
  const body = branch.slice(0, 2600);
  const offHours = body.split('policy.mode === "off_hours"');
  assert.equal(offHours.length, 3, "both languages need an off_hours answer");
  assert.match(offHours[1], /Сейчас мы закрыты/u);
  assert.match(offHours[1], /рабочие часы/u);
  assert.doesNotMatch(offHours[1].split("\n")[0], /технической/u);
  assert.match(offHours[2], /Қазір жабықпыз/u);
  assert.match(offHours[2], /жұмыс уақытында/u);
});

test("the closed answer still points at the menu, so the guest can plan", () => {
  const branch = webhook.slice(webhook.indexOf("function closedKitchenReply"), webhook.indexOf("function closedKitchenReply") + 2600);
  const lines = branch.split('policy.mode === "off_hours"');
  assert.match(lines[1], /Меню/u);
  assert.match(lines[2], /Мәзірді/u);
});

// A fixed 30-minute window meant a guest still choosing dishes was asked to accept
// the same wait a second time, which reads like the bot forgot the conversation.
test("the consent grace window slides on every turn that finds the same kitchen", () => {
  const fn = redis.slice(redis.indexOf("export async function getKitchenCheckoutFingerprint"));
  const body = fn.slice(0, 600);
  assert.match(body, /redisClient\.expire\(kitchenCheckoutGraceKey\(instanceId, phone\), KITCHEN_CHECKOUT_GRACE_TTL_SECONDS\)/);
  assert.ok(body.indexOf("if (!value) return null;") < body.indexOf("expire("), "an absent key must not be resurrected");
});

test("the turn that reads the wait for a status answer takes it from the live kitchen first", () => {
  const fn = webhook.slice(webhook.indexOf("function ctxKitchenWaitMinutes"));
  const body = fn.slice(0, 500);
  assert.match(body, /live\.wait_time \?\? runtime\.wait_time \?\? runtime\.kitchen_status\?\.wait_time/);
  assert.equal((webhook.match(/ctxKitchenWaitMinutes\(ctx\)/g) || []).length, 2, "both status call sites must pass it");
});
