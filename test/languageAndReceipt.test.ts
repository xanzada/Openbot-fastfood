import test from "node:test";
import assert from "node:assert/strict";
import { USER_LANG_TTL_SECONDS, languageKey, receiptFingerprintKey } from "../src/services/redis.service.js";
import { resolveLockedLanguage } from "../src/utils/language.js";
import {
  receiptFilterEnabled,
  validateReceiptAnalysis,
} from "../src/services/mediaAnalysis.service.js";
import { buildReceiptCrmPayload } from "../src/services/dle.service.js";

test("language is tenant scoped and locked for exactly six hours", () => {
  assert.equal(USER_LANG_TTL_SECONDS, 6 * 60 * 60);
  assert.equal(languageKey("prestige", "77470000000"), "lang:prestige:77470000000");
  assert.notEqual(languageKey("prestige", "77470000000"), languageKey("other", "77470000000"));
  assert.equal(resolveLockedLanguage("ru", "kk"), "ru");
  assert.equal(resolveLockedLanguage(null, "kk"), "kk");
});

test("receipt AI filter toggle defaults on and accepts explicit false", () => {
  assert.equal(receiptFilterEnabled({}), true);
  assert.equal(receiptFilterEnabled({ RECEIPT_AI_FILTER_ENABLED: "true" }), true);
  assert.equal(receiptFilterEnabled({ RECEIPT_AI_FILTER_ENABLED: "false" }), false);
});

test("receipt validation accepts a fresh matching receipt and rejects old or wrong receipts", () => {
  const now = Date.parse("2026-07-22T18:00:00.000Z");
  const base = {
    type: "receipt",
    is_valid_receipt: true,
    amount: 9700,
    bank_name: "Kaspi",
    sender_name: "Арман Сейітов",
    transaction_id: "KZ-123456",
    date_time: "2026-07-22T17:50:00.000Z",
  };
  const context = {
    expectedAmount: 9700,
    orderCreatedAt: "2026-07-22T17:30:00.000Z",
    nowMs: now,
  };

  assert.equal(validateReceiptAnalysis(base, context).valid, true);
  assert.equal(validateReceiptAnalysis({ ...base, date_time: "2026-07-20T17:50:00.000Z" }, context).reason, "receipt_too_old");
  assert.equal(validateReceiptAnalysis({ ...base, amount: 100 }, context).reason, "amount_mismatch");
  assert.equal(validateReceiptAnalysis({ ...base, sender_name: "Белгісіз" }, context).reason, "sender_missing");
});

test("CRM receipt payload uses only OCR sender and bank fields", () => {
  const payload = buildReceiptCrmPayload({
    order_id: "36",
    amount: 9700,
    sender_name: "Арман Сейітов",
    bank_name: "Kaspi",
    date_time: "2026-07-22T17:50:00.000Z",
    transaction_id: "KZ-123456",
  });
  assert.equal(payload.sender_name, "Арман Сейітов (Kaspi)");
  assert.doesNotMatch(payload.sender_name, /Xanzada/);
  assert.equal(payload.amount_paid, 9700);
  assert.notEqual(receiptFingerprintKey("prestige", "abc"), receiptFingerprintKey("other", "abc"));
});
