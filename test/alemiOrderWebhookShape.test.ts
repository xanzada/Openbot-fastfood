import assert from "node:assert/strict";
import test from "node:test";
import { describeBodyShape, normalizeDlePayload } from "../src/routes/dleWebhook.route.js";
import { buildLegacyNewOrderMessage } from "../src/controllers/kanban.js";

// The verbatim vocabulary hub.alemi.kz sends. The first real order was dropped
// with `invalid phone` because every one of these names was unknown to us, so
// the shape below is the contract these tests defend.
function hubOrderCreated(overrides: Record<string, any> = {}) {
  return {
    id: "evt_01KZRKYGXWANR0N24A0ZGK0QND",
    event_type: "order.created",
    instance: "prestige",
    order: {
      id: "019ff13f-43b3-706d-bff2-da6c3a12dcee",
      order_number: "1042",
      status: "new",
      phone_e164: "+77015550101",
      fulfillment_type: "delivery",
      address: "Абая 10, кв 5",
      comment: "Побольше соуса",
      currency: "KZT",
      total_amount_minor: 8200,
      subtotal_amount_minor: 7200,
      delivery_amount_minor: 1000,
      discount_amount_minor: 0,
      bonus_spent_amount_minor: 300,
      cutlery_count: 2,
      wait_time_minutes: 45,
      items: [
        { name: { ru: "Филадельфия", kk: "Филадельфия" }, quantity: 2, line_total_amount_minor: 6000 },
        { name: { ru: "Кола" }, quantity: 1, line_total_amount_minor: 1200 },
      ],
      ...overrides,
    },
  };
}

function normalize(body: Record<string, any>) {
  const req = { body, query: {}, headers: {} } as any;
  normalizeDlePayload(req);
  return req.body as Record<string, any>;
}

test("A hub order.created event yields the phone the kitchen pipeline requires", () => {
  const body = normalize(hubOrderCreated());

  assert.equal(body.action, "new_order");
  assert.equal(body.phone, "+77015550101");
  assert.equal(body.order_id, "019ff13f-43b3-706d-bff2-da6c3a12dcee");
  assert.equal(body.instance, "prestige");
});

test("Money, fulfillment and extras arrive under the names the message builder reads", () => {
  const body = normalize(hubOrderCreated());

  assert.equal(Number(body.total_price), 8200);
  assert.equal(Number(body.delivery_price), 1000);
  assert.equal(Number(body.bonus), 300);
  assert.equal(Number(body.persons), 2);
  assert.equal(Number(body.wait_time), 45);
  assert.equal(body.order_number, "1042");
  assert.equal(body.is_pickup, "delivery");
});

test("A pickup order is recognised from fulfillment_type", () => {
  const body = normalize(hubOrderCreated({ fulfillment_type: "pickup" }));

  assert.equal(body.is_pickup, "pickup");
});

test("A guest phone stored on a separate customer object is still found", () => {
  const raw = hubOrderCreated();
  delete (raw.order as any).phone_e164;
  (raw.order as any).customer = { phone_e164: "+77012223344", name: "Айгүл" };

  assert.equal(normalize(raw).phone, "+77012223344");
});

test("The event survives being wrapped in data.order the way a queue may deliver it", () => {
  const inner = hubOrderCreated();
  const body = normalize({ event_type: inner.event_type, id: inner.id, data: { instance: "prestige", order: inner.order } });

  assert.equal(body.phone, "+77015550101");
  assert.equal(Number(body.total_price), 8200);
});

test("The cart lists real dish names instead of [object Object]", () => {
  const body = normalize(hubOrderCreated());
  const message = buildLegacyNewOrderMessage(body, "ru", String(body.order_number), false);

  assert.match(message, /Филадельфия x2 = 6000 ₸/);
  assert.match(message, /Кола x1 = 1200 ₸/);
  assert.doesNotMatch(message, /\[object Object\]/);
  assert.match(message, /ИТОГО: 8200 ₸/);
  assert.match(message, /№1042/);
  assert.match(message, /Доставка:\* 1000 ₸/);
  assert.match(message, /бонус:\* 300 ₸/);
});

test("A Kazakh guest sees the Kazakh dish name when hub sends one", () => {
  const body = normalize(hubOrderCreated({
    items: [{ name: { ru: "Кола", kk: "Кола сусыны" }, quantity: 1, line_total_amount_minor: 1200 }],
  }));
  const message = buildLegacyNewOrderMessage(body, "kk", "1042", true);

  assert.match(message, /Кола сусыны x1 = 1200 ₸/);
});

test("The missing-field diagnostic reports key names and types, never guest values", () => {
  const shape = describeBodyShape(hubOrderCreated());

  assert.match(shape, /event_type:string/);
  assert.match(shape, /order:\{/);
  assert.match(shape, /phone_e164:string/);
  assert.doesNotMatch(shape, /77015550101/);
  assert.doesNotMatch(shape, /Абая/);
});
