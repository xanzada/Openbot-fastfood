import assert from "node:assert/strict";
import test from "node:test";
import { normalizeDlePayload } from "../src/routes/dleWebhook.route.js";
import { legacyStatusTemplates, resolveStatusTemplateKey } from "../src/controllers/kanban.js";

// A live sweep of every event name hub.alemi.kz can emit answered 400 BAD_ACTION
// for eight of them and 200-but-silent for five more. Both are invisible failures:
// the operator pressed «подтверждение» and the guest heard nothing. This table is
// the contract that keeps every one of those names mapped.
function normalize(body: Record<string, any>) {
  const req = { body, query: {}, headers: {} } as any;
  normalizeDlePayload(req);
  return req.body as Record<string, any>;
}

function event(eventType: string, order: Record<string, any> = {}) {
  return {
    id: `evt_${eventType}`,
    event_type: eventType,
    instance: "prestige",
    order: {
      id: "019ff13f-43b3-706d-bff2-da6c3a12dcee",
      order_number: 13,
      phone_e164: "+77015550101",
      fulfillment_type: "delivery",
      total_amount_minor: 6000,
      ...order,
    },
  };
}

const ACTION_MAP: Array<[string, string]> = [
  ["order.created", "new_order"],
  ["order.confirmed", "request_payment"],
  ["order.accepted", "request_payment"],
  ["payment.requested", "request_payment"],
  ["payment.request", "request_payment"],
  ["order.paid", "status_changed"],
  ["payment.received", "status_changed"],
  ["order.updated", "status_changed"],
  ["order.ready", "status_changed"],
  ["order.completed", "status_changed"],
  ["order.delivered", "status_changed"],
  ["order.status_changed", "status_changed"],
  ["order.rejected", "order_rejected"],
  ["order.cancelled", "order_rejected"],
  ["order.canceled", "order_rejected"],
  ["kitchen.status_changed", "update_kitchen_status"],
  ["kitchen.updated", "update_kitchen_status"],
  ["shift_note.created", "shift_note_created"],
  ["shift_note.updated", "shift_note_created"],
  ["shift_note.deleted", "shift_note_deleted"],
  ["shift_note.expired", "shift_note_deleted"],
];

for (const [eventType, expected] of ACTION_MAP) {
  test(`hub event ${eventType} maps to ${expected}`, () => {
    const body = normalize(event(eventType, { status: eventType.split(".")[1] }));
    assert.equal(body.action, expected);
  });
}

test("a confirm delivered as a status transition collapses onto request_payment", () => {
  for (const status of ["confirmed", "accepted", "approved", "CONFIRMED"]) {
    const body = normalize(event("order.status_changed", { status }));
    assert.equal(body.action, "request_payment", `status=${status}`);
  }
});

test("a non-confirm status transition stays status_changed", () => {
  for (const status of ["preparing", "ready", "delivery", "completed", "cancelled", "paid"]) {
    const body = normalize(event("order.status_changed", { status }));
    assert.equal(body.action, "status_changed", `status=${status}`);
    assert.equal(body.new_status, status);
  }
});

test("legacy snake_case actions still work alongside the new event names", () => {
  const body = normalize({ instance: "prestige", action: "request_payment", order: { id: "13", phone: "+77015550101" } });
  assert.equal(body.action, "request_payment");
});

// Every status hub emits must produce a guest message except `pending`, which is
// already covered by the new_order message the guest just received.
test("each hub status resolves to an existing template", () => {
  const cases: Array<[string, boolean, string]> = [
    ["preparing", false, "preparing"],
    ["cooking", false, "preparing"],
    ["ready", false, "ready_delivery"],
    ["ready", true, "pickup_ready"],
    ["on_the_way", false, "delivery"],
    ["delivering", false, "delivery"],
    ["delivery", false, "delivery"],
    ["completed", false, "completed"],
    ["completed", true, "pickup_ready"],
    ["delivered", false, "completed"],
    ["cancelled", false, "cancelled"],
    ["canceled", false, "cancelled"],
    ["review", false, "review"],
    ["paid", false, "paid"],
  ];
  for (const [status, isPickup, expectedKey] of cases) {
    const key = resolveStatusTemplateKey(status, isPickup);
    assert.equal(key, expectedKey, `${status} pickup=${isPickup}`);
    for (const lang of ["kk", "ru"] as const) {
      assert.ok(legacyStatusTemplates[lang][key], `missing ${lang} template for ${key}`);
    }
  }
});

test("pending stays silent so the guest is not messaged twice", () => {
  const key = resolveStatusTemplateKey("pending", false);
  assert.equal(legacyStatusTemplates.kk[key], undefined);
  assert.equal(legacyStatusTemplates.ru[key], undefined);
});

test("both languages carry exactly the same template keys", () => {
  assert.deepEqual(
    Object.keys(legacyStatusTemplates.kk).sort(),
    Object.keys(legacyStatusTemplates.ru).sort(),
  );
});
