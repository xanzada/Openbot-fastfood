import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

process.env.REDIS_URL = "redis://127.0.0.1:1";
process.env.REDIS_CONNECT_TIMEOUT_MS = "500";
process.env.REDIS_OPERATION_TIMEOUT_MS = "500";

const { redisClient } = await import("../src/services/redis.service.js");
test.after(() => {
  if (redisClient.isOpen) redisClient.destroy();
});

const { classifyKitchenSalesPolicy } = await import("../src/services/kitchenPolicy.service.js");
const read = (relative: string) => readFile(new URL(relative, import.meta.url), "utf8");

// Found live on kebab1, 2026-08-23: the bot answered every closed state with "по важной
// ТЕХНИЧЕСКОЙ причине". The hub had said exactly why it was closed -
// closed_reason: "service_channels_disabled" - and the policy dropped it. Nothing was
// broken: the owner simply had not switched delivery/pickup on yet. That is the state
// EVERY newly onboarded restaurant starts in, so every one of them would have greeted its
// first guests with a false failure notice.

test("the policy carries the reason the hub gave", () => {
  const channelsOff = classifyKitchenSalesPolicy({
    accepting_orders: false,
    closed_reason: "service_channels_disabled",
    delivery: false,
    pickup: false,
    within_work_hours: true,
  });
  assert.equal(channelsOff.closedReason, "service_channels_disabled");
  assert.equal(channelsOff.blocksAllSales, true, "it is still closed - only the wording changes");

  // The reason arrives at the top level or nested, like every other field here.
  const nested = classifyKitchenSalesPolicy({
    accepting_orders: false,
    kitchen_status: { closed_reason: "service_channels_disabled" },
    delivery: false,
    pickup: false,
    within_work_hours: true,
  });
  assert.equal(nested.closedReason, "service_channels_disabled");

  assert.equal(
    classifyKitchenSalesPolicy({ accepting_orders: false, closed_reason: "emergency_stop", is_emergency: true, within_work_hours: true }).closedReason,
    "emergency_stop"
  );
  assert.equal(
    classifyKitchenSalesPolicy({ accepting_orders: false, closed_reason: "outside_work_hours", within_work_hours: false }).closedReason,
    "outside_work_hours"
  );
  // An open kitchen has no reason to report.
  assert.equal(classifyKitchenSalesPolicy({ accepting_orders: true, delivery: true, pickup: true }).closedReason, "");
});

test("a reason we cannot read does not become a wrong one", () => {
  // No runtime at all, and a runtime that simply omits the field: neither may invent
  // "service_channels_disabled" or "emergency".
  assert.equal(classifyKitchenSalesPolicy(null).closedReason, "");
  assert.equal(classifyKitchenSalesPolicy({ runtime_available: true }).closedReason, "");
  // And the reason is bounded, since it goes into a guest-visible decision.
  const long = classifyKitchenSalesPolicy({ closed_reason: "x".repeat(400), accepting_orders: false, within_work_hours: true });
  assert.ok(long.closedReason.length <= 120);
});

test("'technical' is reserved for the one case where it is true", async () => {
  const route = await read("../src/routes/whatsappWebhook.route.ts");
  const fn = route.slice(route.indexOf("function closedKitchenReply"));
  const body = fn.slice(0, fn.indexOf("\n}"));

  // The channels-off branch must exist and must not blame a technical fault.
  assert.match(body, /const channelsOff = reason\.includes\("service_channels_disabled"\)/);
  assert.match(body, /ни доставка, ни самовывоз не доступны/);
  assert.match(body, /жеткізу де, алып кету де қолжетімсіз/);

  // An emergency stop is a real halt, so saying so is honest - but it is its own branch,
  // not the default for everything.
  assert.match(body, /const emergency = policy\.isEmergency \|\| reason\.includes\("emergency"\)/);
  assert.match(body, /Кухня временно остановлена/);
  assert.match(body, /Асүй уақытша тоқтатылды/);

  // The words that were wrong for every state but one are gone from the fallbacks.
  assert.doesNotMatch(body, /важной технической причине/);
  assert.doesNotMatch(body, /техникалық себепке байланысты/);
});

test("every closed reply still tells the guest what they CAN do", async () => {
  const route = await read("../src/routes/whatsappWebhook.route.ts");
  const fn = route.slice(route.indexOf("function closedKitchenReply"));
  const body = fn.slice(0, fn.indexOf("\n}"));
  // The off_hours wording learned this in 2026-08-12 and the rest did not: a closed
  // notice with no next step is why guests gave up. Each non-vacation branch offers the
  // menu or invites them back.
  const branches = body.split("\n").filter((line) => line.includes("return "));
  const closedBranches = branches.filter((line) => /(Сейчас|Кухня|Қазір|Асүй)/.test(line));
  assert.ok(closedBranches.length >= 6, `expected both languages x branches, got ${closedBranches.length}`);
  for (const line of closedBranches) {
    assert.ok(
      // Any form of "write to us" counts, and жаз- covers жазыңыз / жазсаңыз / қайта жазып.
      /(Меню|Мәзірді|напиш|Напиш|жаз)/.test(line),
      `a closed reply must leave the guest something to do: ${line.trim().slice(0, 90)}`
    );
  }
});

test("the channels-off wording also fires when the hub sends no reason at all", async () => {
  // Older hub builds and the Redis fallback can leave closed_reason empty while both
  // channels are plainly off. The reply must not fall through to the generic line.
  const route = await read("../src/routes/whatsappWebhook.route.ts");
  const fn = route.slice(route.indexOf("function closedKitchenReply"));
  const body = fn.slice(0, fn.indexOf("\n}"));
  assert.match(body, /\|\| \(!policy\.delivery && !policy\.pickup\)/);
});
