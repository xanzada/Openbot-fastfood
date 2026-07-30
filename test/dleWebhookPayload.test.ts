import test from "node:test";
import assert from "node:assert/strict";
import { normalizeDlePayload } from "../src/routes/dleWebhook.route.js";

function req(body: Record<string, any>) {
  return { body, query: {} } as any;
}

test("a note arriving as an OBJECT keeps its real text, never '[object Object]'", () => {
  const r = req({
    action: "create_shift_note",
    instance: "prestige",
    note: { id: 5, text: "Пицца уақытша жоқ", expires_at: "2026-07-31 18:00" },
  });
  normalizeDlePayload(r);
  assert.equal(r.body.action, "shift_note_created");
  assert.equal(r.body.text, "Пицца уақытша жоқ");
  assert.notEqual(r.body.text, "[object Object]");
  assert.equal(r.body.note_id, 5);
  assert.equal(r.body.expires_at, "2026-07-31 18:00");
});

test("a note arriving as a plain string still works", () => {
  const r = req({ action: "shift_note_created", instance: "prestige", note: "Донер болмайды" });
  normalizeDlePayload(r);
  assert.equal(r.body.text, "Донер болмайды");
});

test("a top-level text field wins over everything else", () => {
  const r = req({ action: "shift_note_created", instance: "prestige", text: "Курица жоқ", note: { id: 7, text: "Басқа" } });
  normalizeDlePayload(r);
  assert.equal(r.body.text, "Курица жоқ");
  assert.equal(r.body.note_id, 7);
});

test("delete signal normalizes the same way so delete-by-text can match", () => {
  const r = req({ action: "delete_shift_note", instance: "prestige", note: { id: 5, text: "Пицца уақытша жоқ" } });
  normalizeDlePayload(r);
  assert.equal(r.body.action, "shift_note_deleted");
  assert.equal(r.body.text, "Пицца уақытша жоқ");
  assert.equal(r.body.note_id, 5);
});

test("order actions keep their aliases and fields", () => {
  const r = req({ action: "create_order", instance: "prestige", phone: "77001112233", order: { id: 456, status: "paid", total: 3200 } });
  normalizeDlePayload(r);
  assert.equal(r.body.action, "new_order");
  assert.equal(r.body.order_id, 456);
  assert.equal(r.body.new_status, "paid");
  assert.equal(r.body.total_price, 3200);
  assert.equal(r.body.phone, "77001112233");
});

test("unknown actions pass through untouched", () => {
  const r = req({ action: "something_future", instance: "prestige" });
  normalizeDlePayload(r);
  assert.equal(r.body.action, "something_future");
});
