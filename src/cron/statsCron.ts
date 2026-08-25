import { redisClient } from "../services/redis.service.js";
import { callAlemiLegacyAction } from "../services/alemiApi.service.js";
import { getAllRestaurantConfigs, getRestaurantConfig } from "../services/platformConfig.service.js";
import { notifyAllDevelopersSystemFailure, notifyDeveloperSystemFailure } from "../services/developerNotify.service.js";
import {
  buildDailyAnalyticsRow,
  hasAnalyticsBeenSent,
  localDayKey,
  markAnalyticsSent,
  normalizeLeadRows,
  pendingReportDates,
  readDailyMetrics,
  readLearningNotes,
  readSentDates,
  type DailyAnalyticsRow,
} from "../services/dailyAnalytics.service.js";
import { envNumber } from "../utils/envNumber.js";

/**
 * Daily analytics delivery.
 *
 * Two defects lived here together and made the hub's AI-аналитика table look
 * like the bot was reporting nothing (audit, 2026-08-25):
 *
 *  - The day was only ever attempted ONCE, at 23:59 local. A restart, a deploy,
 *    a network blip or a hub 5xx in that single minute lost the day for good -
 *    which is exactly what the owner saw as missing rows (2026-08-10 and
 *    2026-08-25 absent for Crazy Суши, every day absent for kabab #1 before
 *    2026-08-23). There is now a delivery ledger per tenant and a periodic
 *    reconcile that re-sends any recent day the hub never confirmed, so a missed
 *    window is caught up instead of lost.
 *  - buildDailyAnalytics() was `normalizeAnalyticsPayload({}, leads)`: an empty
 *    AI object, so the regex fallback always won and `ai_daily_advice` said the
 *    analysis was "temporarily unavailable" every single day. The real analysis
 *    now lives in dailyAnalytics.service.
 *
 * Today's row is upserted on every sweep (report_date is the hub's key, so this
 * is idempotent) and only marked final once the day is over. The owner therefore
 * sees today filling in as it happens, not at midnight.
 */

const ANALYTICS_TIMEZONE = process.env.ANALYTICS_TIMEZONE || "Asia/Almaty";
const ANALYTICS_CRON_EXPR = process.env.ANALYTICS_CRON_EXPR || "59 23 * * *";
const ANALYTICS_BACKFILL_DAYS = envNumber(process.env.ANALYTICS_BACKFILL_DAYS, 7, { min: 0, max: 30 });
const ANALYTICS_RECONCILE_INTERVAL_MS = envNumber(
  process.env.ANALYTICS_RECONCILE_INTERVAL_MS,
  6 * 60 * 60 * 1000,
  { min: 15 * 60 * 1000, max: 24 * 60 * 60 * 1000 },
);
const ANALYTICS_BOOT_DELAY_MS = envNumber(process.env.ANALYTICS_BOOT_DELAY_MS, 90_000, { min: 5_000, max: 30 * 60 * 1000 });

function tenantTimezone(config: Record<string, any> = {}) {
  const value = String(config.timezone || config.time_zone || config.tz || "").trim();
  return value || ANALYTICS_TIMEZONE;
}

function getLocalReportDate(timeZone = ANALYTICS_TIMEZONE) {
  return localDayKey(timeZone);
}

async function fetchTodayCrmLeads(config: Record<string, any>, reportDate: string) {
  const instanceId = String(config.instance_id || "").trim();
  if (!instanceId) throw new Error("missing instance_id");
  const result = await callAlemiLegacyAction(
    "get_today_crm",
    { action: "get_today_crm", restaurant_id: instanceId, date: reportDate },
    { config, timeoutMs: 15000 }
  );
  return normalizeLeadRows(result);
}

async function sendAnalyticsToSite(config: Record<string, any>, reportDate: string, analytics: DailyAnalyticsRow) {
  const instanceId = String(config.instance_id || "").trim();
  if (!instanceId) throw new Error("missing instance_id");
  await callAlemiLegacyAction(
    "save_daily_analytics",
    { action: "save_daily_analytics", restaurant_id: instanceId, report_date: reportDate, ...analytics },
    { config, timeoutMs: 20000 }
  );
  return true;
}

type TenantConfigLoader = (
  instanceId: string,
  options?: { forceRefresh?: boolean },
) => Promise<Record<string, any> | null>;

export async function hydrateAnalyticsTenantConfig(
  summaryConfig: Record<string, any>,
  loadConfig: TenantConfigLoader = getRestaurantConfig,
) {
  const instanceId = String(summaryConfig?.instance_id || summaryConfig?.instance || "").trim();
  if (!instanceId) throw new Error("ALEMI_TENANT_INSTANCE_MISSING");

  // The list endpoint may omit secrets and prime the ordinary runtime cache.
  // Analytics must hydrate the exact tenant record before signing anything.
  const runtimeConfig = await loadConfig(instanceId, { forceRefresh: true });
  if (!runtimeConfig) throw new Error("ALEMI_TENANT_CONFIG_NOT_FOUND");
  const runtimeInstance = String(runtimeConfig.instance_id || runtimeConfig.instance || "").trim();
  if (runtimeInstance !== instanceId) throw new Error("ALEMI_TENANT_CONFIG_MISMATCH");

  const hydrated: Record<string, any> = { ...summaryConfig, ...runtimeConfig, instance_id: instanceId, instance: instanceId };
  const tenantSecret = String(
    hydrated.alemi_secret || hydrated.alemiSecret || hydrated.alemi_api_secret || hydrated.alemiApiSecret || "",
  ).trim();
  if (!tenantSecret) throw new Error("ALEMI_TENANT_SECRET_NOT_CONFIGURED");
  return hydrated;
}

/** One tenant, one date: gather the facts, analyse them, deliver the row. */
export async function reportRestaurantDay(
  hydratedConfig: Record<string, any>,
  reportDate: string,
  options: { final: boolean },
) {
  const instanceId = String(hydratedConfig.instance_id || "").trim();
  if (!instanceId) return false;

  const [leads, metrics, learningNotes] = await Promise.all([
    fetchTodayCrmLeads(hydratedConfig, reportDate),
    readDailyMetrics(instanceId, reportDate),
    readLearningNotes(instanceId, reportDate),
  ]);

  const analytics = await buildDailyAnalyticsRow({
    instanceId,
    reportDate,
    brand: String(hydratedConfig.brand || ""),
    leads,
    metrics,
    learningNotes,
  });

  await sendAnalyticsToSite(hydratedConfig, reportDate, analytics);
  if (options.final) await markAnalyticsSent(instanceId, reportDate);

  console.log(
    `[CRON] analytics sent instance=${instanceId} date=${reportDate} final=${options.final} guests=${analytics.total_chats}`
    + ` orders=${analytics.intent_orders} payments=${analytics.intent_payments} complaints=${analytics.total_complaints}`
    + ` canceled=${analytics.total_canceled} escalated=${analytics.escalated_tickets} mood="${analytics.avg_mood}"`
  );
  return true;
}

/**
 * Every recent day this tenant still owes the hub, oldest first, plus today.
 * Past days are marked delivered; today is left open so later sweeps refresh it.
 */
export async function reconcileRestaurantAnalytics(config: Record<string, any>, nowDate?: string) {
  const hydratedConfig = await hydrateAnalyticsTenantConfig(config);
  const instanceId = String(hydratedConfig.instance_id || "").trim();
  if (!instanceId) return;

  const today = nowDate || getLocalReportDate(tenantTimezone(hydratedConfig));
  const sent = await readSentDates(instanceId);
  const dates = pendingReportDates(today, ANALYTICS_BACKFILL_DAYS, sent);

  for (const date of dates) {
    try {
      await reportRestaurantDay(hydratedConfig, date, { final: date !== today });
    } catch (error: any) {
      console.error(`[CRON] analytics day failed instance=${instanceId} date=${date}:`, error?.message || error);
      throw error;
    }
  }
}

async function processRestaurantAnalytics(config: Record<string, any>, reportDate: string) {
  const hydratedConfig = await hydrateAnalyticsTenantConfig(config);
  const instanceId = String(hydratedConfig.instance_id || "").trim();
  if (!instanceId) return;

  // The end-of-day run closes today, and also sweeps up any earlier day that
  // never landed - a tenant onboarded mid-week, or a hub outage last night.
  const sent = await readSentDates(instanceId);
  const backlog = pendingReportDates(reportDate, ANALYTICS_BACKFILL_DAYS, sent).filter((date) => date !== reportDate);
  for (const date of backlog) {
    try {
      await reportRestaurantDay(hydratedConfig, date, { final: true });
    } catch (error: any) {
      console.error(`[CRON] analytics backlog failed instance=${instanceId} date=${date}:`, error?.message || error);
    }
  }

  await reportRestaurantDay(hydratedConfig, reportDate, { final: true });
}

export async function processDailyAnalytics() {
  console.log("[CRON] Daily AI analytics started...");
  if (!redisClient.isOpen) return;

  const configs = await getAllRestaurantConfigs();

  if (!configs.length) {
    console.warn("[CRON] No restaurant configs found for daily analytics.");
    return;
  }

  for (const config of configs) {
    const reportDate = getLocalReportDate(tenantTimezone(config));
    try {
      await processRestaurantAnalytics(config, reportDate);
    } catch (error: any) {
      console.error(`[CRON] analytics error (${config?.instance_id || "unknown"}):`, error?.message || error);
      await notifyDeveloperSystemFailure(String(config?.instance_id || ""), error, {
        scope: "daily_analytics",
        action: "process_restaurant_analytics",
      }).catch(() => undefined);
    }
  }
}

/**
 * The safety net: runs on boot and on a slow interval, so a day is never lost
 * to a single missed 23:59. Failures are logged per tenant and never abort the
 * sweep - one tenant with a rotated secret must not hide the others.
 */
export async function reconcileDailyAnalytics() {
  if (!redisClient.isOpen) return;
  const configs = await getAllRestaurantConfigs();
  if (!configs.length) return;

  for (const config of configs) {
    try {
      await reconcileRestaurantAnalytics(config);
    } catch (error: any) {
      console.error(`[CRON] analytics reconcile error (${config?.instance_id || "unknown"}):`, error?.message || error);
    }
  }
}

/** Days already delivered, for diagnostics and tests. */
export async function analyticsDeliveryState(instanceId: string) {
  const dates = [...(await readSentDates(instanceId))].sort();
  return { instanceId, delivered: dates };
}

export async function isAnalyticsDelivered(instanceId: string, reportDate: string) {
  return hasAnalyticsBeenSent(instanceId, reportDate);
}

function parseDailyCron(expr = ANALYTICS_CRON_EXPR) {
  const [minuteRaw, hourRaw] = String(expr || "").trim().split(/\s+/);
  const minute = Number(minuteRaw);
  const hour = Number(hourRaw);
  return {
    minute: Number.isInteger(minute) && minute >= 0 && minute <= 59 ? minute : 59,
    hour: Number.isInteger(hour) && hour >= 0 && hour <= 23 ? hour : 23,
  };
}

function localTimeParts(date: Date, timeZone = ANALYTICS_TIMEZONE) {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone,
    hour12: false,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
  }).formatToParts(date);
  return Object.fromEntries(parts.map((part) => [part.type, part.value]));
}

function nextDelayMs() {
  const target = parseDailyCron();
  const now = Date.now();
  for (let offsetMinutes = 1; offsetMinutes <= 60 * 48; offsetMinutes += 1) {
    const candidate = new Date(now + offsetMinutes * 60 * 1000);
    const parts = localTimeParts(candidate);
    if (Number(parts.hour) === target.hour && Number(parts.minute) === target.minute) {
      return Math.max(1000, candidate.getTime() - now);
    }
  }
  return 24 * 60 * 60 * 1000;
}

export function startDailyCron() {
  const scheduleNext = () => {
    const delay = nextDelayMs();
    setTimeout(() => {
      processDailyAnalytics()
        .catch((error: any) => {
          console.error("[CRON] analytics fatal error:", error?.message || error);
          void notifyAllDevelopersSystemFailure(error, {
            scope: "daily_analytics_fatal",
          }).catch(() => undefined);
        })
        .finally(scheduleNext);
    }, delay);
  };

  scheduleNext();

  const sweep = () => {
    reconcileDailyAnalytics().catch((error: any) => {
      console.error("[CRON] analytics reconcile fatal:", error?.message || error);
    });
  };
  setTimeout(sweep, ANALYTICS_BOOT_DELAY_MS).unref?.();
  setInterval(sweep, ANALYTICS_RECONCILE_INTERVAL_MS).unref?.();

  console.log(
    `[CRON] Daily AI analytics scheduled: ${ANALYTICS_CRON_EXPR} ${ANALYTICS_TIMEZONE}`
    + ` reconcile_every=${Math.round(ANALYTICS_RECONCILE_INTERVAL_MS / 60000)}min backfill_days=${ANALYTICS_BACKFILL_DAYS}`
  );
}
