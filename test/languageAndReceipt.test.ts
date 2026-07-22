import test from "node:test";
import assert from "node:assert/strict";
import { USER_LANG_TTL_SECONDS, languageKey, languageSetOptions, receiptFingerprintKey } from "../src/services/redis.service.js";
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
  assert.deepEqual(languageSetOptions(), { EX: 21600, NX: true });
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
  assert.equal(validateReceiptAnalysis({ ...base, bank_name: "Белгісіз банк" }, context).reason, "bank_missing");
  assert.equal(validateReceiptAnalysis({ ...base, sender_name: "Xanzada👑" }, context).reason, "sender_missing");
  assert.equal(validateReceiptAnalysis({ ...base, transaction_id: "" }, context).reason, "transaction_missing");
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
  assert.deepEqual(payload, {
    action: "add_payment_comment",
    order_id: "36",
    amount_paid: 9700,
    sender_name: "Арман Сейітов (Kaspi)",
  });
  assert.throws(
    () => buildReceiptCrmPayload({ order_id: "36", amount: 9700, sender_name: "Xanzada👑", bank_name: "Белгісіз банк" }),
    /RECEIPT_OCR_IDENTITY_REQUIRED/
  );
  assert.notEqual(receiptFingerprintKey("prestige", "abc"), receiptFingerprintKey("other", "abc"));
});
