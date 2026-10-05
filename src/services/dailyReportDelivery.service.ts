import {
  composeDailyAnalytics, computeDailyFacts, buildHeuristicJudgement, localDayKey,
  normalizeLeadRows, readDailyMetrics, readLearningNotes, type DailyAnalyticsInputs,
} from "./dailyAnalytics.service.js";
import { callAlemiLegacyAction } from "./alemiApi.service.js";
import { redisClient } from "./redis.service.js";
import { getRestaurantConfig } from "./platformConfig.service.js";
import { sendWhatsProMessage } from "../transport/whatspro.client.js";
import {
  deliverDurableNotification, guardedAdminRecipient, redisNotificationStore,
  type NotificationStore, type NotificationRecord,
} from "./durableNotification.service.js";

export interface DailyOwnerCase {
  kind: string; status: string; createdAt: number; updatedAt?: number;
  summary?: string; assignedOperator?: unknown; resolution?: string;
}
export type DailyOwnerInputs = DailyAnalyticsInputs & {
  complaintCases?: DailyOwnerCase[]; caseDetailsAvailable?: boolean; timeZone?: string;
};
export function localReportWindow(date: string, timeZone: string) {
  const midnight = (day: string) => {
    let low = Date.parse(`${day}T00:00:00Z`) - 18 * 60 * 60 * 1000;
    let high = low + 36 * 60 * 60 * 1000;
    while (low < high) {
      const mid = Math.floor((low + high) / 2);
      if (localDayKey(timeZone, new Date(mid)) < day) low = mid + 1; else high = mid;
    }
    return low;
  };
  const nextDay = new Date(Date.parse(`${date}T12:00:00Z`) + 86_400_000).toISOString().slice(0, 10);
  return {start: midnight(date), end: midnight(nextDay) - 1};
}
export function safeComplaintDescription(summary = "") {
  if (/волос|шаш(?!л)|тырнақ|ногт|посторон/iu.test(summary)) return "Посторонний предмет в еде";
  if (/холодн|суық|суык/iu.test(summary)) return "Еда была холодной";
  if (/не тот|қате|басқа.*тапсырыс/iu.test(summary)) return "Получен другой заказ";
  if (/оплат|ақша|төле|чек|спис/iu.test(summary)) return "Требуется проверка оплаты";
  if (/кешік|кешіг|опозд|задерж|не привез/iu.test(summary)) return "Проблема с доставкой";
  if (/груб|дөрек/iu.test(summary)) return "Жалоба на обращение";
  return "Описание доступно в карточке оператора";
}
export function complaintCaseLines(inputs: DailyOwnerInputs) {
  if (!inputs.caseDetailsAvailable) return ["Детали, статус, ответственный и решение: в карточках SOS оператора. По агрегатным данным их подтвердить нельзя."];
  const cases = inputs.complaintCases || [];
  if (!cases.length) return ["В проверенной выборке за этот день карточки жалоб не найдены."];
  const tz = inputs.timeZone || "Asia/Almaty";
  return cases.slice(0, 20).map(row => {
    const occurredAt = row.updatedAt || row.createdAt;
    const time = new Intl.DateTimeFormat("en-GB", {timeZone: tz, hourCycle: "h23", hour: "2-digit", minute: "2-digit"}).format(new Date(occurredAt));
    const kind = row.kind === "critical" ? "критическая" : row.kind === "complaint" ? "жалоба" : "обращение";
    const status = row.status === "resolved" ? "решено" : row.status === "closed" ? "закрыто" : "открыто";
    const repeated = localDayKey(tz, new Date(row.createdAt)) !== inputs.reportDate ? "да (обновление прежнего случая)" : "не подтверждено";
    return `${time} · ${kind} · ${safeComplaintDescription(row.summary)} · ${status}; оператор: ${row.assignedOperator ? "назначен" : "нет данных"}; решение: ${row.resolution ? "зафиксировано в карточке" : "нет данных"}; повтор: ${repeated}.`;
  });
}
async function readOwnerCases(instanceId: string, date: string, timeZone: string) {
  try {
    const window = localReportWindow(date, timeZone);
    const ids = await redisClient.zRangeByScore(`operator_cases:${instanceId}`, window.start, window.end, {LIMIT: {offset: 0, count: 100}});
    const rows = await Promise.all(ids.map(id => redisClient.get(`operator_case:${instanceId}:${id}`)));
    const complaintCases = rows.filter(Boolean).map(raw => JSON.parse(raw!))
      .filter(row => row.instanceId === instanceId && ["complaint", "critical"].includes(row.kind)) as DailyOwnerCase[];
    return {complaintCases, caseDetailsAvailable: true};
  } catch {return {complaintCases: [], caseDetailsAvailable: false};}
}
export const dailyReportKey = (instance: string, date: string) => `daily_report:${instance}:${date}`;
const pendingIndex = (instance: string) => `daily_report_pending:${instance}`;
export function analyticsTenantEnabled(config: Record<string, any>) {
  return !["false", "0", "no", "off"].includes(String(config.bot_enabled ?? "").trim().toLowerCase());
}
export function ownerReportDates(config: Record<string, any>, now: Date) {
  const timezone = String(config.timezone || config.time_zone || config.tz || process.env.ANALYTICS_TIMEZONE || "Asia/Almaty");
  const today = localDayKey(timezone, now);
  const yesterday = new Date(Date.parse(`${today}T12:00:00Z`) - 86_400_000).toISOString().slice(0, 10);
  const parts = new Intl.DateTimeFormat("en-GB", {timeZone: timezone, hourCycle: "h23", hour: "2-digit", minute: "2-digit"}).formatToParts(now);
  const time = Object.fromEntries(parts.map(p => [p.type, p.value]));
  return Number(time.hour) === 23 && Number(time.minute) === 59 ? [today, yesterday] : [yesterday];
}
function count(value: unknown) {
  if (value === undefined || value === null || (typeof value === "string" && value.trim() === "")) return null;
  const number = Number(value); return Number.isFinite(number) && number >= 0 ? Math.trunc(number) : null;
}
function metricLabel(metrics: Record<string, number>, name: string) {
  const value = count(metrics[name]); return value === null ? "нет данных" : String(value);
}
/** Owner message is deterministic, contains no customer notes, phone numbers or model-written facts. */
export function buildDailyOwnerText(inputs: DailyOwnerInputs) {
  const facts = computeDailyFacts(inputs);
  const metrics = inputs.metrics;
  const cancelled = inputs.leads.filter(lead => String(lead.sales_stage).toUpperCase() === "CANCELED").length;
  const summary = [
    `Ежедневный отчёт — ${inputs.reportDate}`,
    `Ресторан: ${String(inputs.brand || inputs.instanceId).replace(/[\r\n]/g, " ").slice(0, 100)}`,
    `Лидов в CRM: ${inputs.leads.length}. Уникальных клиентов в CRM: ${new Set(inputs.leads.map(l => l.phone).filter(Boolean)).size}.`,
    `Новых лидов: ${metricLabel(metrics, "new_leads")}. Сообщений боту: ${metricLabel(metrics, "turns")}.`,
    `Намерений заказать: ${facts.intent_orders}. Дошли до оплаты: ${facts.intent_payments}.`,
    `Созданных заказов: ${metricLabel(metrics, "orders_created")}. Завершено: ${metricLabel(metrics, "orders_completed")}. Отменено в CRM: ${cancelled}.`,
    `Сумма заказов: ${metricLabel(metrics, "orders_total")}. Оплат: ${metricLabel(metrics, "payments")}. Списано бонусов: ${metricLabel(metrics, "bonus_spent")}.`,
    `Передано оператору: ${metricLabel(metrics, "escalations")}. SOS: ${metricLabel(metrics, "sos")}.`,
    `Среднее время ответа (мс): ${metricLabel(metrics, "response_avg_ms")}.`,
    `Ошибки LLM: ${metricLabel(metrics, "llm_errors")}. Ошибки STT: ${metricLabel(metrics, "stt_errors")}. Резервных ответов: ${metricLabel(metrics, "fallbacks")}.`,
    `Ссылок отправлено: ${metricLabel(metrics, "links_sent")}. Не выдано ссылок: ${metricLabel(metrics, "missing_links")}. Недоставленных уведомлений: ${metricLabel(metrics, "undelivered_notifications")}.`,
    "",
    `Жалобы: ${metricLabel(metrics, "complaints")}.`,
    ...(inputs.caseDetailsAvailable ? [`Карточек жалоб в проверенной выборке за день: ${inputs.complaintCases?.length || 0}.`, "Источник деталей: выборка из первых 100 карточек обращений за день."] : []),
  ];
  const details = inputs.complaintCases?.length || facts.total_complaints ? complaintCaseLines(inputs)
    : count(metrics.complaints) === 0 ? ["За день жалобы не зарегистрированы."]
    : inputs.caseDetailsAvailable ? complaintCaseLines(inputs)
    : ["Подтвердить количество жалоб по доступным источникам нельзя."];
  const totalCaseRows = inputs.caseDetailsAvailable ? inputs.complaintCases?.length || 0 : 0;
  const footer = [
    "",
    facts.total_complaints ? "Рекомендация: проверить открытые жалобы и результаты работы оператора."
      : facts.fallbacks ? "Рекомендация: проверить причины резервных ответов."
      : "Рекомендация: продолжить проверку доставки уведомлений и завершения заказов.",
    "Общие вопросы и проблемы: в агрегатном источнике не представлены.",
  ];
  const render = () => [
    ...summary, ...details,
    ...(totalCaseRows > details.length ? [`Показано ${details.length} из ${totalCaseRows} карточек выборки; остальные доступны в SOS.`] : []),
    ...footer,
  ].join("\n");
  // The gateway accepts at most4096 UTF-16 code units. Keep all numeric facts
  // and budget only optional case rows, with an explicit omission count.
  while (render().length > 4096 && totalCaseRows > 0 && details.length > 0) details.pop();
  const text = render();
  if (text.length > 4096) throw new Error("DAILY_REPORT_TEXT_TOO_LONG");
  return text;
}
async function defaultReadFacts(config: Record<string, any>, date: string): Promise<DailyOwnerInputs> {
  const instanceId = String(config.instance_id || "");
  const timezone = String(config.timezone || config.time_zone || config.tz || "Asia/Almaty");
  const [rawLeads, metrics, learningNotes, cases] = await Promise.all([
    callAlemiLegacyAction("get_today_crm", {action: "get_today_crm", restaurant_id: instanceId, date}, {config, timeoutMs: 15000}),
    readDailyMetrics(instanceId, date), readLearningNotes(instanceId, date, 40, timezone), readOwnerCases(instanceId, date, timezone),
  ]);
  return {instanceId, reportDate: date, brand: String(config.brand || config.name || instanceId),
    leads: normalizeLeadRows(rawLeads), metrics, learningNotes, timeZone: timezone, ...cases};
}
type OwnerDeps = {
  store?: NotificationStore;
  loadConfig?: (instance: string) => Promise<Record<string, any> | null>;
  readFacts?: typeof defaultReadFacts;
  send?: typeof sendWhatsProMessage;
  saveHub?: (config: Record<string, any>, inputs: DailyAnalyticsInputs) => Promise<void>;
  log?: (event: string, record: NotificationRecord) => void;
};
async function defaultSaveHub(config: Record<string, any>, inputs: DailyAnalyticsInputs) {
  const facts = computeDailyFacts(inputs);
  const row = composeDailyAnalytics(inputs, facts, buildHeuristicJudgement(inputs, facts));
  await callAlemiLegacyAction("save_daily_analytics",
    {action: "save_daily_analytics", restaurant_id: inputs.instanceId, report_date: inputs.reportDate, ...row},
    {config, timeoutMs: 20000});
}
export async function processDailyOwnerReports(configs: Record<string, any>[], now = new Date(), deps: OwnerDeps = {}) {
  const store = deps.store || redisNotificationStore;
  const outcomes: Array<{instance: string; date?: string; status: string}> = [];
  for (const summary of configs) {
    const instanceId = String(summary.instance_id || summary.instance || "").trim();
    if (!instanceId || !analyticsTenantEnabled(summary)) continue;
    try {
      // The list may omit timezone/recipient fields. Resolve the exact tenant
      // record before deciding which local date is due.
      const runtimeConfig = await (deps.loadConfig || ((id: string) => getRestaurantConfig(id, {forceRefresh: true})))(instanceId);
      if (!runtimeConfig || String(runtimeConfig.instance_id || runtimeConfig.instance || "") !== instanceId) throw new Error("TENANT_CONFIG_MISMATCH");
      if (!analyticsTenantEnabled(runtimeConfig)) continue;
      const due = await store.due(pendingIndex(instanceId), now.getTime());
      const dates = [...new Set([...ownerReportDates(runtimeConfig, now), ...due.map(key => key.split(":").at(-1)!)])];
      for (const date of dates) {
        try {
          let config: Record<string, any> | null = runtimeConfig;
          let facts: DailyOwnerInputs | null = null;
          const load = async () => {
            config ||= await (deps.loadConfig || ((id: string) => getRestaurantConfig(id, {forceRefresh: true})))(instanceId);
            if (!config || String(config.instance_id || config.instance || "") !== instanceId) throw new Error("TENANT_CONFIG_MISMATCH");
            if (!analyticsTenantEnabled(config)) throw new Error("TENANT_DISABLED");
            return config;
          };
          const record = await deliverDurableNotification({
            key: dailyReportKey(instanceId, date), index: pendingIndex(instanceId), instanceId, now: now.getTime(), store, initialPayload: {report_date: date},
            prepare: async () => {
              const current = await load();
              facts = await (deps.readFacts || defaultReadFacts)(current, date);
              const recipient = guardedAdminRecipient(current, facts.leads.map(l => l.phone), true);
              // Preserve Hub upsert; its legacy delivered marker is independent of WhatsApp acceptance.
              await (deps.saveHub || defaultSaveHub)(current, facts);
              return {recipient, text: buildDailyOwnerText(facts), payload: {report_date: date}};
            },
            validate: async (record) => {
              const current = await load();
              facts ||= await (deps.readFacts || defaultReadFacts)(current, date);
              if (guardedAdminRecipient(current, facts.leads.map(l => l.phone), true) !== record.recipient) throw new Error("ADMIN_RECIPIENT_CHANGED");
            },
            send: async (record, requestId) => {
              const result = await (deps.send || sendWhatsProMessage)({instanceId, phone: record.recipient, text: record.text, requestId});
              return "acknowledged" in result && result.acknowledged === true && result.queued !== true;
            },
            log: deps.log || ((event, record) => {
              if (event === "prepared" && date !== localDayKey(String(runtimeConfig.timezone || runtimeConfig.time_zone || runtimeConfig.tz || "Asia/Almaty"), now)) {
                console.log(`[DAILY_REPORT] catch_up instance=${instanceId} date=${date}`);
              }
              console.log(`[DAILY_REPORT] ${event} instance=${instanceId} date=${date} attempts=${record.attempts} recipient=***${record.recipient.slice(-2)} error=${record.last_error || "-"}`);
            }),
          });
          outcomes.push({instance: instanceId, date, status: record?.status || "locked"});
        } catch { console.error(`[DAILY_REPORT] failed instance=${instanceId} date=${date} error=SOURCE_OR_STORE_UNAVAILABLE`); outcomes.push({instance: instanceId, date, status: "failed"}); }
      }
    } catch { console.error(`[DAILY_REPORT] failed instance=${instanceId} error=TENANT_OR_STORE_UNAVAILABLE`); outcomes.push({instance: instanceId, status: "failed"}); }
  }
  return outcomes;
}

