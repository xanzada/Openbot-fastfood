import { readLocalTime, resolveTenantTimeZone } from "./localTime.service.js";

export interface WorkHoursEvaluation {
  configured: boolean;
  raw: string;
  withinWorkHours: boolean;
  opensAtClock: string;
  closesAtClock: string;
  currentClock: string;
  timeZone: string;
  reason: string;
}

/**
 * Normalizes and checks whether the current moment falls within a restaurant's operating schedule.
 *
 * Supported formats from WhatsPro:
 * - "09:00 - 03:00", "09:00-03:00" (overnight schedule spanning across midnight)
 * - "10:00 - 23:00", "10:00-22:00" (same-day schedule)
 * - "10 - 22", "9-3" (hour-only ranges)
 * - "24/7", "тәулік бойы", "круглосуточно", "00:00 - 24:00", "00:00 - 00:00" (continuous)
 */
export function evaluateWorkHours(
  workHoursRaw: string | undefined | null,
  configOrTimeZone?: Record<string, any> | string | null,
  now: Date = new Date()
): WorkHoursEvaluation {
  const timeZone = typeof configOrTimeZone === "string" && configOrTimeZone.trim()
    ? configOrTimeZone.trim()
    : resolveTenantTimeZone(typeof configOrTimeZone === "object" ? configOrTimeZone : null);

  const localReading = readLocalTime({ timezone: timeZone }, now);
  const currentTotalMinutes = localReading.hour * 60 + localReading.minute;
  const currentClock = localReading.clock;

  const raw = String(workHoursRaw ?? "").replace(/[\r\n\t]+/g, " ").trim();

  // If no hours are configured, treat as open to prevent unexpected downtime
  if (!raw) {
    return {
      configured: false,
      raw: "",
      withinWorkHours: true,
      opensAtClock: "",
      closesAtClock: "",
      currentClock,
      timeZone,
      reason: "",
    };
  }

  // 24/7 continuous operations
  if (/(24\s*[\/:]\s*7|тәулік|круглосут|00:00\s*[-–—]\s*24:00|00:00\s*[-–—]\s*00:00)/iu.test(raw)) {
    return {
      configured: true,
      raw,
      withinWorkHours: true,
      opensAtClock: "00:00",
      closesAtClock: "24:00",
      currentClock,
      timeZone,
      reason: "",
    };
  }

  // Range matching: "09:00 - 03:00" or "09:00-03:00" or "10 - 22"
  const rangeMatch = raw.match(/(\d{1,2})(?::(\d{2}))?\s*[-–—]\s*(\d{1,2})(?::(\d{2}))?/u);
  if (!rangeMatch) {
    return {
      configured: true,
      raw,
      withinWorkHours: true,
      opensAtClock: "",
      closesAtClock: "",
      currentClock,
      timeZone,
      reason: "",
    };
  }

  const startHour = Number(rangeMatch[1]);
  const startMinute = Number(rangeMatch[2] || 0);
  const endHour = Number(rangeMatch[3]);
  const endMinute = Number(rangeMatch[4] || 0);

  const startTotalMinutes = startHour * 60 + startMinute;
  const endTotalMinutes = endHour * 60 + endMinute;

  const opensAtClock = `${String(startHour).padStart(2, "0")}:${String(startMinute).padStart(2, "0")}`;
  const closesAtClock = `${String(endHour).padStart(2, "0")}:${String(endMinute).padStart(2, "0")}`;

  let withinWorkHours: boolean;

  if (startTotalMinutes === endTotalMinutes) {
    // 24-hour operation (e.g. 09:00 to 09:00)
    withinWorkHours = true;
  } else if (endTotalMinutes < startTotalMinutes) {
    // Overnight operation (e.g. 09:00 to 03:00)
    // Open if cur >= start (e.g. 09:00 to 23:59) OR cur < end (00:00 to 02:59)
    withinWorkHours = currentTotalMinutes >= startTotalMinutes || currentTotalMinutes < endTotalMinutes;
  } else {
    // Standard daytime operation (e.g. 10:00 to 23:00)
    withinWorkHours = currentTotalMinutes >= startTotalMinutes && currentTotalMinutes < endTotalMinutes;
  }

  return {
    configured: true,
    raw,
    withinWorkHours,
    opensAtClock,
    closesAtClock,
    currentClock,
    timeZone,
    reason: withinWorkHours ? "" : "outside_work_hours",
  };
}
