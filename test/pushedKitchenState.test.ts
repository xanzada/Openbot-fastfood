import test from "node:test";
import assert from "node:assert/strict";
import { overlayPushedKitchenState, runtimeFromKitchenStatus } from "../src/services/dle.service.js";

const NOW = 1_785_000_000_000;
const nowSec = Math.floor(NOW / 1000);

function hubStatus(extra: Record<string, any> = {}) {
  return {
    is_accepting_orders: true,
    within_work_hours: true,
    closed_reason: "",
    delivery: true,
    pickup: true,
    wait_time: 15,
    reset_at: 0,
    is_emergency: false,
    kitchen_status: { wait_time: 15, reset_at: 0, delivery: true, pickup: true, is_emergency: false },
    fetched_settings: { wait_time: 15, is_emergency: false, source: "dle_runtime_status" },
    source: "dle_runtime_status",
    runtime_available: true,
    ...extra,
  };
}

function pushed(extra: Record<string, any> = {}) {
  return {
    wait_time: 0,
    reset_at: 0,
    delivery: true,
    pickup: true,
    is_emergency: false,
    is_accepting_orders: true,
    within_work_hours: true,
    closed_reason: "",
    payment_details: [],
    source: "kanban_webhook",
    synced_at: new Date(NOW - 60_000).toISOString(),
    ...extra,
  } as any;
}

// The panel wrote the pause to Redis, but Redis was only read when the hub was
// unreachable - so while the hub answered, an operator raising the wait changed
// nothing a guest could see (audit, 2026-08-12).
test("a fresh push raises the wait the hub reported", () => {
  const out = overlayPushedKitchenState(hubStatus(), pushed({ wait_time: 70 }), NOW);
  assert.equal(out.wait_time, 70);
  assert.equal(out.kitchen_status.wait_time, 70);
  assert.equal(out.pushed_kitchen_override, true);
});

test("a push may only tighten - a lower pushed wait never shortens the hub's", () => {
  const out = overlayPushedKitchenState(hubStatus({ wait_time: 90 }), pushed({ wait_time: 10 }), NOW);
  assert.equal(out.wait_time, 90);
  assert.equal(out.pushed_kitchen_override, undefined, "nothing changed, so nothing is overlaid");
});

test("a pushed emergency stops sales even while the hub says all is well", () => {
  const out = overlayPushedKitchenState(hubStatus(), pushed({ is_emergency: true }), NOW);
  assert.equal(out.is_emergency, true);
  assert.equal(out.is_accepting_orders, false);
});

test("a channel switched off in the panel is off for the guest too", () => {
  const out = overlayPushedKitchenState(hubStatus(), pushed({ delivery: false }), NOW);
  assert.equal(out.delivery, false);
  assert.equal(out.pickup, true);
  assert.equal(out.is_accepting_orders, true, "pickup alone still sells");
});

test("a push that is neither scheduled nor fresh is ignored", () => {
  const stale = pushed({ wait_time: 70, synced_at: new Date(NOW - 90 * 60_000).toISOString() });
  assert.equal(overlayPushedKitchenState(hubStatus(), stale, NOW).wait_time, 15);
});

test("a stale push with a reset time still in the future is still in effect", () => {
  const scheduled = pushed({
    wait_time: 70,
    reset_at: nowSec + 1800,
    synced_at: new Date(NOW - 90 * 60_000).toISOString(),
  });
  const out = overlayPushedKitchenState(hubStatus(), scheduled, NOW);
  assert.equal(out.wait_time, 70);
  assert.equal(out.reset_at, nowSec + 1800);
});

// getRuntimeStatus writes the hub's own answer back into the same Redis key, so
// without this guard the overlay would read its own echo and pin the state.
test("the hub's own echo is never overlaid on the hub", () => {
  for (const source of ["dle_runtime_status", "redis_kitchen_status_reset"]) {
    const out = overlayPushedKitchenState(hubStatus(), pushed({ wait_time: 70, source }), NOW);
    assert.equal(out.wait_time, 15, source);
  }
});

test("no push at all leaves the hub answer untouched", () => {
  const status = hubStatus();
  assert.equal(overlayPushedKitchenState(status, null, NOW), status);
});

// within_work_hours used to be hard-coded true in the Redis fallback, so whenever
// the hub was unreachable a closed restaurant looked open and the bot sold through
// the night (audit, 2026-08-12).
test("the Redis fallback reproduces a closed restaurant instead of assuming an open one", () => {
  const runtime = runtimeFromKitchenStatus("prestige", pushed({ within_work_hours: false, is_accepting_orders: false }));
  assert.equal(runtime.within_work_hours, false);
  assert.equal(runtime.is_accepting_orders, false);
  assert.equal(runtime.closed_reason, "outside_work_hours");
});

test("the Redis fallback keeps an open restaurant open", () => {
  const runtime = runtimeFromKitchenStatus("prestige", pushed({ wait_time: 25 }));
  assert.equal(runtime.within_work_hours, true);
  assert.equal(runtime.is_accepting_orders, true);
  assert.equal(runtime.closed_reason, "");
  assert.equal(runtime.wait_time, 25);
});

test("a paused kitchen in the fallback names the pause, not the clock", () => {
  const runtime = runtimeFromKitchenStatus("prestige", pushed({ is_emergency: true }));
  assert.equal(runtime.is_accepting_orders, false);
  assert.equal(runtime.closed_reason, "emergency_stop");
});
