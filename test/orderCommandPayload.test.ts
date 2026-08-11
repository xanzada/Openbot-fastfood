import { test } from "node:test";
import assert from "node:assert/strict";
import { mapLegacyAlemiAction } from "../src/services/alemiApi.service.js";

// Hub rejects the whole command with 400 INTEGRATION_COMMAND_INVALID as soon as
// `order_id` is present, so a guest who quoted their order number was told the
// status could not be read. Verified against the live hub 2026-08-11.
test("order context is requested by phone only, never by order id", () => {
  const mapped = mapLegacyAlemiAction("get_order_context", { phone: "77769156184", order_id: "13" });
  assert.equal(mapped.command, "order.context.get");
  assert.deepEqual(mapped.data, { phone_e164: "+77769156184", limit: 5 });
});

test("order status is requested by phone only, never by order id", () => {
  const mapped = mapLegacyAlemiAction("check_status", { phone: "+7 776 915 6184", orderId: 13 });
  assert.equal(mapped.command, "order.status.get");
  assert.deepEqual(mapped.data, { phone_e164: "+77769156184" });
});

test("a phoneless order lookup fails fast instead of spending a 400 round trip", () => {
  assert.throws(() => mapLegacyAlemiAction("get_order_context", { order_id: "13" }), /PHONE_REQUIRED/);
  assert.throws(() => mapLegacyAlemiAction("check_status", { order_id: "13" }), /PHONE_REQUIRED/);
});
