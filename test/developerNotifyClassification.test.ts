import { test } from "node:test";
import assert from "node:assert/strict";
import { developerAlertInternals } from "../src/services/developerNotify.service.js";

const { buildAlertText, isCustomerPhone } = developerAlertInternals;

test("daily analytics failure is classified without claiming a Docker restart", () => {
  const text = buildAlertText(
    "restaurant-1",
    new Error("analytics API unavailable"),
    { scope: "daily_analytics", action: "process_restaurant_analytics" },
    "incident-1",
    new Date("2026-08-16T12:00:00.000Z")
  );

  assert.match(text, /Түрі: Фондық тапсырма ақауы/);
  assert.doesNotMatch(text, /Docker|қайта іске қос/i);
});

test("startup dependency failure is diagnostics, not a restart event", () => {
  const text = buildAlertText(
    "restaurant-1",
    new Error("hub unavailable"),
    { scope: "startup_dependency", dependency: "alemi_hub", status: "FAIL" },
    "incident-2",
    new Date("2026-08-16T12:00:00.000Z")
  );

  assert.match(text, /Түрі: Іске қосу диагностикасы/);
  assert.doesNotMatch(text, /Docker|қайта іске қос/i);
});

test("a restart is reported only when the caller explicitly confirms it", () => {
  const text = buildAlertText(
    "restaurant-1",
    new Error("process recovered"),
    { scope: "process_restart", restartOccurred: true },
    "incident-3",
    new Date("2026-08-16T12:00:00.000Z")
  );

  assert.match(text, /Қайта іске қосу: расталды/);
});

test("the current event customer can never receive a developer diagnostic", () => {
  assert.equal(
    isCustomerPhone(
      { whatsapp_phone: "77769156184" },
      "77476884956",
      { customerPhone: "+7 747 688 49 56" }
    ),
    true
  );
});
