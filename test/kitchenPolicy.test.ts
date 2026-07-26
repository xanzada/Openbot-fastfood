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

test("a restriction lasting a day or more reads as vacation", () => {
  const p = classifyKitchenSalesPolicy(runtime({ wait_time: 60, reset_at: nowSec + 3 * 86400 }), NOW);
  assert.equal(p.mode, "vacation");
  assert.equal(p.remainingDays, 3);
  assert.equal(p.blocksAllSales, true);
});

// --- The boundary that behaves against the written rule -------------------
// reset_at defaults to 0 in api_bot.php, and the expiry reset puts it back to
// 0. So "wait 45 minutes, no reopening time" is an everyday state, not an edge
// case. This test records what actually happens today.
test("REGRESSION GUARD: without a reopening time, a 41-minute wait stops all sales", () => {
  const p = classifyKitchenSalesPolicy(runtime({ wait_time: 41, reset_at: 0 }), NOW);
  assert.equal(p.mode, "indefinite");
  assert.equal(p.blocksAllSales, true);
  assert.equal(p.requiresConsent, false, "the guest is never asked whether they would wait");

  const p180 = classifyKitchenSalesPolicy(runtime({ wait_time: 180, reset_at: 0 }), NOW);
  assert.equal(p180.mode, "indefinite", "even exactly 180 blocks, though the rule calls 180 busy");
  assert.equal(p180.blocksAllSales, true);
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
