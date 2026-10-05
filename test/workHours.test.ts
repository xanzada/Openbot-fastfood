import test from "node:test";
import assert from "node:assert/strict";
import { evaluateWorkHours } from "../src/services/workHours.service.js";

// Helper to create a fixed Date in Asia/Almaty (UTC+5)
// In UTC+5, 03:10 local is 22:10 UTC previous day
function createAlmatyDate(year: number, month: number, day: number, hour: number, minute: number): Date {
  // Asia/Almaty is UTC+5 with no DST
  const utcDate = new Date(Date.UTC(year, month - 1, day, hour - 5, minute, 0));
  return utcDate;
}

test("workHours: overnight range (09:00 - 03:00) like prestige", () => {
  const schedule = "09:00 - 03:00";
  const tz = "Asia/Almaty";

  // 02:59 local -> OPEN
  const at0259 = evaluateWorkHours(schedule, tz, createAlmatyDate(2026, 10, 5, 2, 59));
  assert.equal(at0259.withinWorkHours, true, "02:59 should be open");
  assert.equal(at0259.currentClock, "02:59");
  assert.equal(at0259.reason, "");

  // 03:00 local -> CLOSED
  const at0300 = evaluateWorkHours(schedule, tz, createAlmatyDate(2026, 10, 5, 3, 0));
  assert.equal(at0300.withinWorkHours, false, "03:00 should be closed");
  assert.equal(at0300.currentClock, "03:00");
  assert.equal(at0300.reason, "outside_work_hours");

  // 03:10 local -> CLOSED (the exact bug incident)
  const at0310 = evaluateWorkHours(schedule, tz, createAlmatyDate(2026, 10, 5, 3, 10));
  assert.equal(at0310.withinWorkHours, false, "03:10 should be closed");
  assert.equal(at0310.currentClock, "03:10");
  assert.equal(at0310.reason, "outside_work_hours");

  // 08:59 local -> CLOSED
  const at0859 = evaluateWorkHours(schedule, tz, createAlmatyDate(2026, 10, 5, 8, 59));
  assert.equal(at0859.withinWorkHours, false, "08:59 should be closed");

  // 09:00 local -> OPEN
  const at0900 = evaluateWorkHours(schedule, tz, createAlmatyDate(2026, 10, 5, 9, 0));
  assert.equal(at0900.withinWorkHours, true, "09:00 should be open");

  // 14:00 local -> OPEN
  const at1400 = evaluateWorkHours(schedule, tz, createAlmatyDate(2026, 10, 5, 14, 0));
  assert.equal(at1400.withinWorkHours, true, "14:00 should be open");

  // 23:59 local -> OPEN
  const at2359 = evaluateWorkHours(schedule, tz, createAlmatyDate(2026, 10, 5, 23, 59));
  assert.equal(at2359.withinWorkHours, true, "23:59 should be open");

  // 00:00 local -> OPEN
  const at0000 = evaluateWorkHours(schedule, tz, createAlmatyDate(2026, 10, 5, 0, 0));
  assert.equal(at0000.withinWorkHours, true, "00:00 should be open");
});

test("workHours: daytime range (10:00 - 23:00)", () => {
  const schedule = "10:00 - 23:00";
  const tz = "Asia/Almaty";

  // 09:59 -> CLOSED
  assert.equal(evaluateWorkHours(schedule, tz, createAlmatyDate(2026, 10, 5, 9, 59)).withinWorkHours, false);

  // 10:00 -> OPEN
  assert.equal(evaluateWorkHours(schedule, tz, createAlmatyDate(2026, 10, 5, 10, 0)).withinWorkHours, true);

  // 22:59 -> OPEN
  assert.equal(evaluateWorkHours(schedule, tz, createAlmatyDate(2026, 10, 5, 22, 59)).withinWorkHours, true);

  // 23:00 -> CLOSED
  assert.equal(evaluateWorkHours(schedule, tz, createAlmatyDate(2026, 10, 5, 23, 0)).withinWorkHours, false);
});

test("workHours: 24/7 continuous and unconfigured fallbacks", () => {
  const tz = "Asia/Almaty";
  const date = createAlmatyDate(2026, 10, 5, 3, 10);

  // 24/7
  assert.equal(evaluateWorkHours("24/7", tz, date).withinWorkHours, true);
  assert.equal(evaluateWorkHours("тәулік бойы", tz, date).withinWorkHours, true);
  assert.equal(evaluateWorkHours("00:00 - 24:00", tz, date).withinWorkHours, true);

  // empty or null
  assert.equal(evaluateWorkHours("", tz, date).withinWorkHours, true);
  assert.equal(evaluateWorkHours(null, tz, date).withinWorkHours, true);
});
