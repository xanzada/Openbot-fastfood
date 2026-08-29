/**
 * What time it is where the RESTAURANT stands, and what that means for the reply.
 *
 * The agent had no clock at all. It could read work_hours as a string but never knew
 * whether "now" was 07:00 or 23:00, so it greeted a 2am guest exactly like a lunch
 * one, said "бүгін" about a day that had already ended, and could not tell a
 * breakfast question from a late-night one (owner request, 2026-08-29).
 *
 * Everything here is derived from the tenant's own timezone with Intl - no model
 * call, no latency, no new source of truth. It is awareness, never authority: the
 * kitchen's own status still decides whether an order can start.
 */

export type DayPart = "night" | "early_morning" | "morning" | "midday" | "afternoon" | "evening" | "late_evening";

export interface LocalTimeReading {
  timeZone: string;
  hour: number;
  minute: number;
  clock: string;
  weekday: string;
  isWeekend: boolean;
  dayPart: DayPart;
  dayPartKk: string;
  dayPartRu: string;
  greetingKk: string;
  greetingRu: string;
  mealMoment: "breakfast" | "lunch" | "dinner" | "late_snack" | "none";
}

const FALLBACK_TIMEZONE = "Asia/Almaty";

/**
 * The tenant's timezone, or Kazakhstan's most common one.
 *
 * An unknown zone must never throw on the hot path: Intl rejects a bad identifier,
 * and one bad tenant config would then take the whole reply down.
 */
export function resolveTenantTimeZone(config: Record<string, any> | null | undefined): string {
  const candidate = String(
    config?.timezone ?? config?.time_zone ?? config?.tz ?? ""
  ).trim();
  if (!candidate) return FALLBACK_TIMEZONE;
  try {
    new Intl.DateTimeFormat("en-US", { timeZone: candidate }).format(new Date());
    return candidate;
  } catch {
    return FALLBACK_TIMEZONE;
  }
}

// The boundaries a person actually feels, not clean six-hour quarters. A fast-food
// restaurant's night runs well past midnight, and 17:00 is still afternoon here.
function classifyDayPart(hour: number): DayPart {
  if (hour < 5) return "night";
  if (hour < 8) return "early_morning";
  if (hour < 11) return "morning";
  if (hour < 14) return "midday";
  if (hour < 17) return "afternoon";
  if (hour < 21) return "evening";
  return "late_evening";
}

const DAY_PART_KK: Record<DayPart, string> = {
  night: "түн",
  early_morning: "таңғы ерте",
  morning: "таңертең",
  midday: "түс",
  afternoon: "түстен кейін",
  evening: "кеш",
  late_evening: "кеш батқан",
};

const DAY_PART_RU: Record<DayPart, string> = {
  night: "ночь",
  early_morning: "раннее утро",
  morning: "утро",
  midday: "полдень",
  afternoon: "после обеда",
  evening: "вечер",
  late_evening: "поздний вечер",
};

// The greeting a Kazakh or Russian speaker would actually pick at this hour. The
// agent still composes its own sentence - this names the RIGHT one so it stops
// saying "қайырлы күн" at one in the morning.
const GREETING_KK: Record<DayPart, string> = {
  night: "Сәлеметсіз бе",
  early_morning: "Қайырлы таң",
  morning: "Қайырлы таң",
  midday: "Қайырлы күн",
  afternoon: "Қайырлы күн",
  evening: "Қайырлы кеш",
  late_evening: "Қайырлы кеш",
};

const GREETING_RU: Record<DayPart, string> = {
  night: "Здравствуйте",
  early_morning: "Доброе утро",
  morning: "Доброе утро",
  midday: "Добрый день",
  afternoon: "Добрый день",
  evening: "Добрый вечер",
  late_evening: "Добрый вечер",
};

// What people eat at this hour, so a recommendation can fit the moment instead of
// offering a family set at 7am.
function classifyMealMoment(hour: number): LocalTimeReading["mealMoment"] {
  if (hour >= 6 && hour < 11) return "breakfast";
  if (hour >= 11 && hour < 16) return "lunch";
  if (hour >= 16 && hour < 22) return "dinner";
  if (hour >= 22 || hour < 3) return "late_snack";
  return "none";
}

export function readLocalTime(
  config: Record<string, any> | null | undefined,
  now: Date = new Date()
): LocalTimeReading {
  const timeZone = resolveTenantTimeZone(config);
  // formatToParts, not string parsing: a locale-formatted string differs per
  // environment, and hour arithmetic on it is how off-by-one-hour bugs are born.
  const parts = new Intl.DateTimeFormat("en-GB", {
    timeZone,
    hour12: false,
    hour: "2-digit",
    minute: "2-digit",
    weekday: "long",
  }).formatToParts(now);
  const lookup = (type: string) => parts.find((part) => part.type === type)?.value || "";
  // "24" is what hour12:false reports at midnight in some ICU versions.
  const hour = Math.min(23, Math.max(0, Number(lookup("hour") || 0) % 24));
  const minute = Math.min(59, Math.max(0, Number(lookup("minute") || 0)));
  const weekday = lookup("weekday") || "";
  const dayPart = classifyDayPart(hour);

  return {
    timeZone,
    hour,
    minute,
    clock: `${String(hour).padStart(2, "0")}:${String(minute).padStart(2, "0")}`,
    weekday,
    isWeekend: ["Saturday", "Sunday"].includes(weekday),
    dayPart,
    dayPartKk: DAY_PART_KK[dayPart],
    dayPartRu: DAY_PART_RU[dayPart],
    greetingKk: GREETING_KK[dayPart],
    greetingRu: GREETING_RU[dayPart],
    mealMoment: classifyMealMoment(hour),
  };
}

/**
 * The FACTS_CONTEXT block. Deliberately small: an hour, what to call it, the
 * greeting that fits, and one rule.
 */
export function localTimeBlock(config: Record<string, any> | null | undefined, language: "kk" | "ru", now = new Date()) {
  const reading = readLocalTime(config, now);
  const kk = language === "kk";
  return {
    clock: reading.clock,
    day_part: kk ? reading.dayPartKk : reading.dayPartRu,
    weekday: reading.weekday,
    is_weekend: reading.isWeekend,
    greeting_that_fits_now: kk ? reading.greetingKk : reading.greetingRu,
    meal_moment: reading.mealMoment,
    rule: [
      "This is the real local time at the restaurant right now. Greet with the greeting that fits this hour and never with one that does not - a guest writing at night must not be told \"қайырлы күн\" / \"добрый день\".",
      "Say \"today\", \"tonight\" or \"tomorrow\" against THIS clock, not against the guest's wording.",
      "Let the hour colour a recommendation when it genuinely helps (something light in the morning, a full set in the evening), but never refuse or invent a shortage because of the time - only the kitchen state and operator notes decide what can be sold.",
      "Never state the time, the day part or the day of week unless the guest asks, and never mention that you were told them.",
    ].join(" "),
  };
}
