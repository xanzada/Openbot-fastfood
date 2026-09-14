import assert from "node:assert/strict";
import test from "node:test";
import { fastParseDigitalReceipt } from "../src/services/mediaAdapter/universalMediaAdapter.js";
import { extractPdfText } from "../src/services/mediaAdapter/pdfExtractor.js";

test("fastParseDigitalReceipt parses standard Kaspi digital receipt text accurately", () => {
  const text = `
    Kaspi.kz
    Квитанция об оплате
    Перевод клиенту Kaspi
    Сумма 12 500 ₸
    Отправитель: Айдар Б.
    Номер перевода: 8934271891
    Дата: 14.09.2026 13:45:12
    Успешно отправлено
  `;

  const res = fastParseDigitalReceipt(text);
  assert(res !== null);
  assert.equal(res.amount, 12500);
  assert.equal(res.bank_name, "Kaspi");
  assert.equal(res.sender_name, "Айдар Б.");
  assert.equal(res.transaction_id, "8934271891");
  assert.equal(res.is_valid_receipt, true);
});

test("fastParseDigitalReceipt parses Halyk Bank digital receipt", () => {
  const text = `
    Halyk Bank
    Төлем түбіртегі
    Сомасы: 7 800,00 ₸
    Жіберуші: Нұрлан Қ.
    Аударым нөмірі: TXN-99887766
    Уақыты: 14.09.2026 14:10
  `;

  const res = fastParseDigitalReceipt(text);
  assert(res !== null);
  assert.equal(res.amount, 7800);
  assert.equal(res.bank_name, "Halyk");
  assert.equal(res.sender_name, "Нұрлан Қ.");
  assert.equal(res.transaction_id, "TXN-99887766");
});

test("fastParseDigitalReceipt safely returns null for non-receipt messages", () => {
  assert.equal(fastParseDigitalReceipt(""), null);
  assert.equal(fastParseDigitalReceipt("Сәлем, мәзірді жіберіңізші"), null);
  assert.equal(fastParseDigitalReceipt("Жеткізу қай уақытта болады?"), null);
});

test("extractPdfText safely returns null for empty or corrupt buffer", async () => {
  const empty = await extractPdfText(Buffer.alloc(0));
  assert.equal(empty, null);
  const corrupt = await extractPdfText(Buffer.from("invalid-pdf-data"));
  assert.equal(corrupt, null);
});
