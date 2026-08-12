import test from "node:test";
import assert from "node:assert/strict";
import { classifyKitchenSalesPolicy, detectKitchenConsentAnswer } from "../src/services/kitchenPolicy.service.js";

const NOW = 1_785_000_000_000;
const nowSec = Math.floor(NOW / 1000);

function runtime(kitchen: Record<string, any>) {
  return { kitchen_status: { delivery: true, pickup: true, is_emergency: false, reset_at: 0, ...kitchen } };
}

test("a calm kitchen sells normally", () => {
  const p = classifyKitchenSalesPolicy(runtime({ wait_time: 40 }), NOW);
  assert.equal(p.mode, "normal");
  assert.equal(p.blocksAllSales, false);
  assert.equal(p.requiresConsent, false);
});

test("with a known reopening time the 41..180 band asks the guest to consent", () => {
  const soon = nowSec + 2 * 3600;
  for (const wait of [41, 60, 120, 180]) {
    const p = classifyKitchenSalesPolicy(runtime({ wait_time: wait, reset_at: soon }), NOW);
    assert.equal(p.mode, "busy", `wait=${wait} must be busy`);
    assert.equal(p.requiresConsent, true);
    assert.equal(p.blocksAllSales, false, `wait=${wait} must still allow selling`);
  }
});

test("only above 180 does a known-end restriction become critical", () => {
  const soon = nowSec + 2 * 3600;
  const at180 = classifyKitchenSalesPolicy(runtime({ wait_time: 180, reset_at: soon }), NOW);
  const at181 = classifyKitchenSalesPolicy(runtime({ wait_time: 181, reset_at: soon }), NOW);
  assert.equal(at180.mode, "busy", "exactly 180 is busy, per the constitution");
  assert.equal(at181.mode, "critical", "only greater than 180 is critical");
  assert.equal(at181.blocksAllSales, true);
});

test("an emergency stop or a closed channel pair blocks everything", () => {
  assert.equal(classifyKitchenSalesPolicy(runtime({ wait_time: 10, is_emergency: true }), NOW).blocksAllSales, true);
  assert.equal(
    classifyKitchenSalesPolicy(runtime({ wait_time: 10, delivery: false, pickup: false }), NOW).blocksAllSales,
    true
  );
});

test("one channel open is reported as channel_limited, not as a stop", () => {
  const p = classifyKitchenSalesPolicy(runtime({ wait_time: 10, delivery: false, pickup: true }), NOW);
  assert.equal(p.mode, "channel_limited");
  assert.equal(p.blocksAllSales, false);
});

test("a closure lasting a day or more reads as vacation", () => {
  const p = classifyKitchenSalesPolicy(
    runtime({ wait_time: 10, is_emergency: true, reset_at: nowSec + 3 * 86400 }),
    NOW
  );
  assert.equal(p.mode, "vacation");
  assert.equal(p.remainingDays, 3);
  assert.equal(p.blocksAllSales, true);
});

test("a long queue is never mistaken for a closure, however long it is scheduled", () => {
  const p = classifyKitchenSalesPolicy(runtime({ wait_time: 60, reset_at: nowSec + 3 * 86400 }), NOW);
  assert.equal(p.mode, "busy", "a slow kitchen is not a closed one");
  assert.equal(p.blocksAllSales, false);
  assert.equal(p.requiresConsent, true);
});

// reset_at defaults to 0 in api_bot.php and the expiry reset restores it, so
// "45 minutes, no reopening time entered" is an everyday state. It must still
// let the guest decide instead of quietly closing the restaurant.
test("a queue with no reopening time still asks the guest instead of stopping sales", () => {
  for (const wait of [41, 90, 180]) {
    const p = classifyKitchenSalesPolicy(runtime({ wait_time: wait, reset_at: 0 }), NOW);
    assert.equal(p.mode, "busy", `wait=${wait} without reset_at must stay busy`);
    assert.equal(p.blocksAllSales, false, `wait=${wait} must not block sales`);
    assert.equal(p.requiresConsent, true, `wait=${wait} must ask the guest`);
  }
});

test("beyond three hours it stops being a queue and sales close", () => {
  const p = classifyKitchenSalesPolicy(runtime({ wait_time: 200, reset_at: 0 }), NOW);
  assert.equal(p.mode, "critical");
  assert.equal(p.blocksAllSales, true);
  assert.equal(p.requiresConsent, false, "no point asking a guest to wait nearly four hours");
});

test("a closed restaurant with no reopening time is still indefinite", () => {
  const p = classifyKitchenSalesPolicy(runtime({ wait_time: 10, is_emergency: true, reset_at: 0 }), NOW);
  assert.equal(p.mode, "indefinite");
  assert.equal(p.blocksAllSales, true);
});

test("consent answers are read in both languages", () => {
  for (const yes of ["иә", "жарайды", "күтемін", "да", "хорошо", "подожду"]) {
    assert.equal(detectKitchenConsentAnswer(yes), "yes", yes);
  }
  for (const no of ["жоқ", "керек емес", "нет", "не буду ждать", "отмена"]) {
    assert.equal(detectKitchenConsentAnswer(no), "no", no);
  }
  assert.equal(detectKitchenConsentAnswer("пицца қанша тұрады"), "unknown");
});

// Every closed state used to share one reply that blamed "a technical reason", so
// a guest writing at 03:00 was told the restaurant was broken (audit, 2026-08-12).
test("being closed for the night is its own mode, not a breakdown", () => {
  const p = classifyKitchenSalesPolicy({ ...runtime({ wait_time: 10 }), within_work_hours: false }, NOW);
  assert.equal(p.mode, "off_hours");
  assert.equal(p.blocksAllSales, true);
  assert.equal(p.isEmergency, false, "closing time is not an emergency");
  assert.equal(p.requiresConsent, false);
});

test("a closure longer than a day is a vacation even when it starts outside work hours", () => {
  const p = classifyKitchenSalesPolicy(
    { ...runtime({ wait_time: 10, reset_at: nowSec + 2 * 86400 }), within_work_hours: false },
    NOW
  );
  assert.equal(p.mode, "vacation");
});

test("off hours outranks a long queue - a closed kitchen has no queue to consent to", () => {
  const p = classifyKitchenSalesPolicy({ ...runtime({ wait_time: 90 }), within_work_hours: false }, NOW);
  assert.equal(p.mode, "off_hours");
  assert.equal(p.requiresConsent, false);
  assert.equal(p.waitMinutes, 90, "the number is still reported, it is just not sellable");
});
