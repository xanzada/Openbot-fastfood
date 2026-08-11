import test from "node:test";
import assert from "node:assert/strict";
import { splitWhatsProResponse } from "../src/transport/whatspro.client.js";

// Live round 3, 2026-08-11: the menu answer reached the guest as two messages -
// "Міне мәзір сілтемесі:" and then the bare URL. A person sends that as one.
const MAGIC = "https://storefront-test-0805.alemi.kz/auth/whatsapp#token=" + "a".repeat(220);

test("a short answer carrying one link is one message, link on its own line", () => {
  const chunks = splitWhatsProResponse(`Міне мәзір сілтемесі:\n${MAGIC}`);
  assert.equal(chunks.length, 1);
  assert.equal(chunks[0], `Міне мәзір сілтемесі:\n${MAGIC}`);
});

test("a bare link is still just the link", () => {
  assert.deepEqual(splitWhatsProResponse(MAGIC), [MAGIC]);
});

test("two links still go as separate messages", () => {
  const chunks = splitWhatsProResponse(`Мәзір: https://a.example.kz/menu, төлем: https://b.example.kz/pay`);
  assert.equal(chunks.length, 3);
  assert.ok(chunks.includes("https://a.example.kz/menu"));
  assert.ok(chunks.includes("https://b.example.kz/pay"));
});

test("a long body with one link keeps chunking the prose", () => {
  const sentence = "Бұл сөйлем клиентке толық түсіндірме беріп жатыр және ұзақ жазылған.";
  const chunks = splitWhatsProResponse(`${Array(8).fill(sentence).join(" ")} ${MAGIC}`);
  assert.ok(chunks.length > 2);
  assert.equal(chunks[chunks.length - 1], MAGIC);
});
