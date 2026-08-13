import assert from "node:assert/strict";
import test from "node:test";
import { normalizeRuntimeStatus } from "../src/services/dle.service.js";

test("Hub current runtime fields preserve the live kitchen wait instead of defaulting to normal", () => {
  const runtime = normalizeRuntimeStatus({
    current: {
      current_wait_minutes: 120,
      emergency: false,
      delivery_enabled: true,
      pickup_enabled: true,
    },
  });

  assert.equal(runtime.wait_time, 120);
  assert.equal(runtime.kitchen_status.wait_time, 120);
  assert.equal(runtime.delivery, true);
  assert.equal(runtime.pickup, true);
});

test("canonical Platform runtime fields drive kitchen state and recover shift notes", () => {
  const runtime = normalizeRuntimeStatus({
    accepting_orders: false,
    closed_reason: "manual_pause",
    fulfillment: [
      { type: "delivery", enabled: false },
      { type: "pickup", enabled: true },
    ],
    wait_time_minutes: 75,
    reset_at: "2026-08-14T18:30:00.000Z",
    workload_emergency: true,
    shift_notes: [{
      id: "018f0e00-aaaa-7bbb-8ccc-0123456789ab",
      text: "Кола закончилась, предлагай пепси",
      expires_at: "2026-08-14T20:00:00.000Z",
    }],
  });

  assert.equal(runtime.is_accepting_orders, false);
  assert.equal(runtime.delivery, false);
  assert.equal(runtime.pickup, true);
  assert.equal(runtime.wait_time, 75);
  assert.equal(runtime.reset_at, Date.parse("2026-08-14T18:30:00.000Z") / 1000);
  assert.equal(runtime.is_emergency, true);
  assert.deepEqual(runtime.shift_notes, [{
    noteId: "018f0e00-aaaa-7bbb-8ccc-0123456789ab",
    text: "Кола закончилась, предлагай пепси",
    expiresAt: Date.parse("2026-08-14T20:00:00.000Z"),
  }]);
});
