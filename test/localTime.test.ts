import test from "node:test";
import assert from "node:assert/strict";
import { localTimeBlock, readLocalTime, resolveTenantTimeZone } from "../src/services/localTime.service.js";

// The agent had no clock at all: it greeted a 2am guest exactly like a lunch one and
// said "бүгін" about a day that had already ended (owner request, 2026-08-29).
const ORAL = { timezone: "Asia/Oral" };

// Asia/Oral is UTC+5, so 20:00 UTC is 01:00 the next local day - the exact case that
// used to produce "қайырлы күн" in the middle of the night.
function at(iso: string) {
  return new Date(iso);
}

test("the tenant's own timezone is used, and a broken one never throws on the hot path", () => {
  assert.equal(resolveTenantTimeZone(ORAL), "Asia/Oral");
  assert.equal(resolveTenantTimeZone({ time_zone: "Asia/Almaty" }), "Asia/Almaty");
  assert.equal(resolveTenantTimeZone({ tz: "Asia/Aqtau" }), "Asia/Aqtau");
  // A typo in one tenant config must not take that tenant's replies down.
  assert.equal(resolveTenantTimeZone({ timezone: "Mars/Olympus" }), "Asia/Almaty");
  assert.equal(resolveTenantTimeZone(null), "Asia/Almaty");
  assert.equal(resolveTenantTimeZone({}), "Asia/Almaty");
});

test("the local hour is read in the restaurant's zone, not the server's", () => {
  // 20:00 UTC = 01:00 next day in Asia/Oral (UTC+5).
  const night = readLocalTime(ORAL, at("2026-08-29T20:00:00Z"));
  assert.equal(night.hour, 1);
  assert.equal(night.clock, "01:00");
  assert.equal(night.dayPart, "night");

  // 06:00 UTC = 11:00 local.
  const midday = readLocalTime(ORAL, at("2026-08-29T06:00:00Z"));
  assert.equal(midday.hour, 11);
  assert.equal(midday.dayPart, "midday");
});

test("the greeting matches the hour in both languages", () => {
  const night = readLocalTime(ORAL, at("2026-08-29T20:00:00Z"));
  // At 01:00 a neutral greeting is the only correct one - never "қайырлы күн".
  assert.equal(night.greetingKk, "Сәлеметсіз бе");
  assert.equal(night.greetingRu, "Здравствуйте");

  const morning = readLocalTime(ORAL, at("2026-08-29T03:30:00Z")); // 08:30 local
  assert.equal(morning.dayPart, "morning");
  assert.equal(morning.greetingKk, "Қайырлы таң");
  assert.equal(morning.greetingRu, "Доброе утро");

  const evening = readLocalTime(ORAL, at("2026-08-29T14:00:00Z")); // 19:00 local
  assert.equal(evening.dayPart, "evening");
  assert.equal(evening.greetingKk, "Қайырлы кеш");
  assert.equal(evening.greetingRu, "Добрый вечер");
});

test("the meal moment follows the hour, so a set is not offered at breakfast", () => {
  assert.equal(readLocalTime(ORAL, at("2026-08-29T03:00:00Z")).mealMoment, "breakfast"); // 08:00
  assert.equal(readLocalTime(ORAL, at("2026-08-29T08:00:00Z")).mealMoment, "lunch"); // 13:00
  assert.equal(readLocalTime(ORAL, at("2026-08-29T14:00:00Z")).mealMoment, "dinner"); // 19:00
  assert.equal(readLocalTime(ORAL, at("2026-08-29T18:00:00Z")).mealMoment, "late_snack"); // 23:00
});

test("the prompt block carries the fitting greeting and forbids inventing a shortage", () => {
  const kk = localTimeBlock(ORAL, "kk", at("2026-08-29T20:00:00Z"));
  assert.equal(kk.clock, "01:00");
  assert.equal(kk.greeting_that_fits_now, "Сәлеметсіз бе");
  assert.equal(kk.day_part, "түн");

  const ru = localTimeBlock(ORAL, "ru", at("2026-08-29T20:00:00Z"));
  assert.equal(ru.greeting_that_fits_now, "Здравствуйте");
  assert.equal(ru.day_part, "ночь");

  // The clock is awareness, never authority: only the kitchen decides what sells.
  assert.match(kk.rule, /never refuse or invent a shortage because of the time/);
  // And it must not be announced unasked, or every reply would open with a time report.
  assert.match(kk.rule, /Never state the time/);
});

test("midnight does not read as hour 24", () => {
  // 19:00 UTC = 00:00 local in Asia/Oral. Some ICU builds report "24" for that hour.
  const midnight = readLocalTime(ORAL, at("2026-08-29T19:00:00Z"));
  assert.equal(midnight.hour, 0);
  assert.equal(midnight.clock, "00:00");
  assert.equal(midnight.dayPart, "night");
});
