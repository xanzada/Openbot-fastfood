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
