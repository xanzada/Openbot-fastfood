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

// B29, found 2026-08-23: a guest whose confirmation failed to send was accused of
// resending their receipt.
//
// The chain: deliverReceiptToClient succeeds and markReceiptSeen is written, so the
// operator HAS the receipt. Then sendCustomerReplyAndFinish throws
// WHATSPRO_SEQUENCE_NOT_ACKNOWLEDGED - before its own markInboundDone - so the catch
// clears the processing lock, msg_done is never set, and the fingerprint stays claimed.
// The guest, who saw no confirmation, sends the receipt again and is told "Бұл чек бұрын
// жіберілген. Бір чекті қайта жібермеңіз." - blamed for spamming a receipt they were
// never confirmed for, after their money had already left.

test("a claimed fingerprint plus a receipt the operator has is OUR silence, not a duplicate", async () => {
  const route = await read("../src/routes/whatsappWebhook.route.ts");
  const branch = route.slice(route.indexOf("const fingerprint = createReceiptFingerprint"));
  const body = branch.slice(0, branch.indexOf("const receiptOrderNumber"));

  // receipt_seen is written only once the receipt actually reached the operator card, so
  // it is the one signal that tells the two cases apart.
  assert.match(body, /hasReceiptSeen\(ctx\.instanceId, priorOrderNumber\)/);
  assert.match(body, /const alreadyWithOperator =/);
  // And it must apologise for our own failure rather than accuse the guest.
  assert.match(body, /Ваш чек у оператора, он на проверке/);
  assert.match(body, /Чегіңіз операторда, тексеруде/);
  assert.match(body, /Извините, что подтверждение не дошло сразу/);
  assert.match(body, /Растауы бірден жетпегені үшін кешіріңіз/);
});

test("a genuine immediate resend still gets the plain duplicate answer", async () => {
  const route = await read("../src/routes/whatsappWebhook.route.ts");
  const branch = route.slice(route.indexOf("const fingerprint = createReceiptFingerprint"));
  const body = branch.slice(0, branch.indexOf("const receiptOrderNumber"));
  // Without receipt_seen the fingerprint clash is a real double-send during the first
  // pass, and the old wording is correct there.
  assert.match(body, /Этот чек уже был отправлен/);
  assert.match(body, /Бұл чек бұрын жіберілген/);
  // The two paths must be chosen by the flag, not merged.
  assert.match(body, /alreadyWithOperator\s*\n?\s*\?/);
});

test("the two outcomes are distinguishable in the logs", async () => {
  const route = await read("../src/routes/whatsappWebhook.route.ts");
  const branch = route.slice(route.indexOf("const fingerprint = createReceiptFingerprint"));
  const body = branch.slice(0, branch.indexOf("const receiptOrderNumber"));
  // A support question about "why was I told not to resend" has to be answerable from the
  // history source, so the confirmation-resend case gets its own label.
  assert.match(body, /"payment_receipt_confirmation_resent"/);
  assert.match(body, /"payment_receipt_duplicate"/);
});

test("a missing order number cannot make the check throw or lie", async () => {
  const route = await read("../src/routes/whatsappWebhook.route.ts");
  const branch = route.slice(route.indexOf("const fingerprint = createReceiptFingerprint"));
  const body = branch.slice(0, branch.indexOf("const receiptOrderNumber"));
  // No order number means we cannot know, and "cannot know" must not become "already with
  // the operator" - that would tell a genuine repeat-sender their receipt is being checked.
  assert.match(body, /priorOrderNumber\s*\n?\s*\?\s*await hasReceiptSeen/);
  assert.match(body, /:\s*false;/);
  // A Redis failure degrades the same way.
  assert.match(body, /\.catch\(\(\) => false\)/);
});

test("hasReceiptSeen is imported, not referenced out of thin air", async () => {
  const route = await read("../src/routes/whatsappWebhook.route.ts");
  assert.match(route, /^\s+hasReceiptSeen,$/m);
  const { hasReceiptSeen } = await import("../src/services/redis.service.js");
  assert.equal(typeof hasReceiptSeen, "function");
  // With Redis unreachable it must answer false rather than throwing into the receipt lane.
  assert.equal(await hasReceiptSeen("probe", "order-1"), false);
  assert.equal(await hasReceiptSeen("", ""), false);
});
