import test from "node:test";
import assert from "node:assert/strict";
import {
  handleDleWebhook,
  isIgnoredAlemiEvent,
  mapIncomingAlemiInstance,
  normalizeDlePayload,
  resolveIncomingAlemiTenant,
} from "../src/routes/dleWebhook.route.js";
import { isValidOrderId } from "../src/controllers/kanban.js";
import { findRestaurantConfigByAlemiInstance } from "../src/services/platformConfig.service.js";

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

test("Alemi order events flatten envelope data and preserve UUID identifiers", () => {
  const r = req({
    event_type: "order.created",
    event_id: "evt-01HX",
    request_id: "req-01HX",
    payload: {
      instance_id: "prestige",
      data: {
        order: {
          id: "018f0df2-11aa-7bb2-8cc3-0123456789ab",
          customer_phone: "+7 700 111 22 33",
          total: 5400,
          items: [{ name: "Doner", qty: 2 }],
        },
      },
    },
  });

  normalizeDlePayload(r);

  assert.equal(r.body.action, "new_order");
  assert.equal(r.body.instance, "prestige");
  assert.equal(r.body.order_id, "018f0df2-11aa-7bb2-8cc3-0123456789ab");
  assert.equal(r.body.phone, "+7 700 111 22 33");
  assert.equal(r.body.total_price, 5400);
  assert.deepEqual(r.body.items, [{ name: "Doner", qty: 2 }]);
  assert.equal(r.body.event_id, "evt-01HX");
  assert.equal(r.body.request_id, "req-01HX");
  assert.equal(isValidOrderId(r.body.order_id), true);
});

test("Hub restaurant instance aliases to the internal WhatsPro tenant", () => {
  assert.equal(mapIncomingAlemiInstance("storefront_test_fe6d775", {
    ALEMI_INSTANCE_ALIASES_JSON: JSON.stringify({ storefront_test_fe6d775: "prestige" }),
  } as NodeJS.ProcessEnv), "prestige");
  assert.equal(mapIncomingAlemiInstance("already_internal", {
    ALEMI_INSTANCE_ALIASES_JSON: "not-json",
  } as NodeJS.ProcessEnv), "already_internal");
});

test("Alemi tenant lookup resolves a second restaurant from runtime config without env aliases", async () => {
  const configs = [
    { instance_id: "prestige", alemi_instance: "hub-prestige" },
    { instance_id: "second-restaurant", alemi_instance: "hub-second", alemi_secret: "test-only-secret" },
  ];
  const matched = findRestaurantConfigByAlemiInstance("hub-second", configs);
  assert.equal(matched?.instance_id, "second-restaurant");

  const r = req({ action: "order.created", instance: "hub-second" });
  const response = { statusCode: 200, body: undefined as any };
  const res = {
    status(code: number) { response.statusCode = code; return this; },
    json(body: any) { response.body = body; return this; },
  } as any;
  let nextCalls = 0;
  await resolveIncomingAlemiTenant(r, res, (() => { nextCalls += 1; }) as any, async (incoming) => {
    return findRestaurantConfigByAlemiInstance(incoming, configs);
  });

  assert.equal(r.body.instance, "second-restaurant");
  assert.equal((r as any).resolvedRestaurantConfig, matched);
  assert.equal(nextCalls, 1);
  assert.equal(response.body, undefined);
});

test("Alemi tenant lookup accepts an exact internal instance id", () => {
  const config = { instance_id: "second-restaurant", alemi_instance: "hub-second" };
  assert.equal(findRestaurantConfigByAlemiInstance("second-restaurant", [config]), config);
  assert.equal(findRestaurantConfigByAlemiInstance("Hub-Second", [config]), null);
});

test("Alemi tenant lookup fails closed when an incoming instance is ambiguous", async () => {
  const configs = [
    { instance_id: "restaurant-a", alemi_instance: "shared-hub-instance" },
    { instance_id: "restaurant-b", alemi_instance: "shared-hub-instance" },
  ];
  assert.throws(
    () => findRestaurantConfigByAlemiInstance("shared-hub-instance", configs),
    /ALEMI_INSTANCE_AMBIGUOUS/,
  );

  const r = req({ action: "order.created", instance: "shared-hub-instance" });
  const response = { statusCode: 200, body: undefined as any };
  const res = {
    status(code: number) { response.statusCode = code; return this; },
    json(body: any) { response.body = body; return this; },
  } as any;
  let nextCalls = 0;
  await resolveIncomingAlemiTenant(r, res, (() => { nextCalls += 1; }) as any, async (incoming) => {
    return findRestaurantConfigByAlemiInstance(incoming, configs);
  });

  assert.equal(response.statusCode, 409);
  assert.deepEqual(response.body, { ok: false, error: "ALEMI_INSTANCE_AMBIGUOUS" });
  assert.equal(nextCalls, 0);
});

test("order-id validation preserves legacy numbers and accepts only canonical UUIDs", () => {
  assert.equal(isValidOrderId("456"), true);
  assert.equal(isValidOrderId("018f0df2-11aa-7bb2-8cc3-0123456789ab"), true);
  assert.equal(isValidOrderId("018f0df211aa7bb28cc30123456789ab"), false);
  assert.equal(isValidOrderId("1234567890123"), false);
});

test("Alemi event aliases map exactly once and normalization is idempotent", () => {
  const mappings = [
    ["order.created", "new_order"],
    ["order.status_changed", "status_changed"],
    ["order.rejected", "order_rejected"],
    ["shift_note.created", "shift_note_created"],
    ["shift_note.deleted", "shift_note_deleted"],
  ] as const;

  for (const [eventType, action] of mappings) {
    const r = req({
      eventType,
      data: {
        instanceId: "prestige",
        order: { id: "018f0df2-11aa-7bb2-8cc3-0123456789ab", phone: "77001112233", status: "paid" },
        note: { id: "note-1", text: "Kitchen note" },
      },
    });
    normalizeDlePayload(r);
    normalizeDlePayload(r);
    assert.equal(r.body.action, action, eventType);
  }
});

test("external-document Alemi events are classified for safe acknowledgement", () => {
  for (const eventType of ["external-document.created", "external_document.updated", "external.document.deleted", "externalDocument.synced"]) {
    assert.equal(isIgnoredAlemiEvent(eventType), true, eventType);
  }
  assert.equal(isIgnoredAlemiEvent("order.created"), false);
});

test("external-document delivery is acknowledged without entering customer notification flow", async () => {
  const r = req({
    event_type: "external-document.created",
    event_id: "evt-doc-1",
    data: { instance: "prestige", document: { media: "sensitive-body-must-not-be-logged" } },
  });
  normalizeDlePayload(r);
  const response = { statusCode: 200, body: undefined as any };
  const res = {
    status(code: number) { response.statusCode = code; return this; },
    json(body: any) { response.body = body; return this; },
  } as any;

  await handleDleWebhook(r, res);

  assert.equal(response.statusCode, 200);
  assert.deepEqual(response.body, { success: true, ignored: true, event_id: "evt-doc-1" });
});

test("ignored events still require a strict valid instance", async () => {
  const r = req({ event_type: "external-document.updated", event_id: "evt-doc-2", data: { instance: "../bad" } });
  normalizeDlePayload(r);
  const response = { statusCode: 200, body: undefined as any };
  const res = {
    status(code: number) { response.statusCode = code; return this; },
    json(body: any) { response.body = body; return this; },
  } as any;

  await handleDleWebhook(r, res);

  assert.equal(response.statusCode, 400);
  assert.deepEqual(response.body, { success: false, error: "BAD_INSTANCE" });
});

test("Alemi shift-note envelope flattens note fields", () => {
  const r = req({
    event_type: "shift_note.created",
    payload: {
      instance: "prestige",
      note: {
        id: "018f0e00-aaaa-7bbb-8ccc-0123456789ab",
        text: "No chicken after 22:00",
        expires_at: "2026-08-10T22:00:00Z",
      },
    },
  });
  normalizeDlePayload(r);
  assert.equal(r.body.action, "shift_note_created");
  assert.equal(r.body.note_id, "018f0e00-aaaa-7bbb-8ccc-0123456789ab");
  assert.equal(r.body.text, "No chicken after 22:00");
  assert.equal(r.body.expires_at, "2026-08-10T22:00:00Z");
});

test("Hub shift_note field is normalized into the existing note flow", () => {
  const r = req({
    event_type: "shift_note.created",
    data: {
      instance: "prestige",
      shift_note: {
        id: "note-120",
        note_text: "Күту уақыты 120 минут",
        expires_at: "2026-08-10T22:00:00Z",
      },
    },
  });
  normalizeDlePayload(r);
  assert.equal(r.body.action, "shift_note_created");
  assert.equal(r.body.note_id, "note-120");
  assert.equal(r.body.text, "Күту уақыты 120 минут");
  assert.equal(r.body.expires_at, "2026-08-10T22:00:00Z");
});

// 2026-08-12: a note posted with `event` instead of `event_type` was answered
// 400 BAD_ACTION and dropped. Only the spelling differed, so an integration
// that names its field the obvious way lost every note it sent.
test("an event named `event` or `type` is recognised, not dropped as BAD_ACTION", () => {
  const byEvent = req({ instance: "prestige", event: "shift_note.created", note: { id: "n1", text: "Лаваш жоқ" } });
  normalizeDlePayload(byEvent);
  assert.equal(byEvent.body.action, "shift_note_created");
  assert.equal(byEvent.body.text, "Лаваш жоқ");

  const byType = req({ instance: "prestige", type: "shift_note.deleted", note: { id: "n1" } });
  normalizeDlePayload(byType);
  assert.equal(byType.body.action, "shift_note_deleted");

  // event_type still wins when both are present, and an unknown name is still
  // not silently promoted to a known action.
  const both = req({ instance: "prestige", event_type: "order.created", event: "shift_note.created" });
  normalizeDlePayload(both);
  assert.equal(both.body.action, "new_order");

  const unknown = req({ instance: "prestige", event: "something.else" });
  normalizeDlePayload(unknown);
  assert.equal(unknown.body.action, "something.else");
});
