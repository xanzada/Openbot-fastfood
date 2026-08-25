import { connectRedis, redisClient } from "./redis.service.js";
import { getOpenRouterProvider, getTextModels } from "./llm.service.js";
import { readLearningEvents } from "./learningLoop.service.js";
import { envNumber } from "../utils/envNumber.js";

/**
 * What the restaurant owner actually opens in the hub: one row per store per
 * day in `store_daily_ai_analytics`.
 *
 * That table has fourteen bot-filled columns, and for months every text column
 * (`avg_mood`, `top_complaints_tags`, `cancellation_reasons`, `popular_items`)
 * showed "—" while `ai_daily_advice` repeated the same sentence about analysis
 * being "temporarily unavailable". Two separate reasons, both fixed together:
 *
 *  1. The wire dropped six of the fourteen fields (see mapLegacyAlemiAction).
 *  2. There was no analysis at all. buildDailyAnalytics() called
 *     normalizeAnalyticsPayload({}, leads) - an empty AI object - so the cron
 *     always fell back to counting regex hits and never once asked a model
 *     anything. The "temporarily unavailable" line was permanent.
 *
 * This service is the day's analysis: it gathers the facts that already exist
 * (per-tenant metric counters, the hub's own CRM leads, the learning-loop
 * events), computes every number deterministically, and asks one cheap model to
 * write the four judgement fields in the owner's language. The model may only
 * describe what it was given; it never invents a count. When it fails, the
 * heuristic summary stands in - and says so honestly instead of claiming the
 * analysis is missing.
 */

export interface DailyAnalyticsLead {
  phone: string;
  interest: string;
  sales_stage: string;
  psycho_analysis: string;
}

export interface DailyAnalyticsInputs {
  instanceId: string;
  reportDate: string;
  brand: string;
  leads: DailyAnalyticsLead[];
  metrics: Record<string, number>;
  learningNotes: string[];
}

export interface DailyAnalyticsRow {
  total_chats: number;
  intent_orders: number;
  intent_payments: number;
  conversion_rate: number;
  total_complaints: number;
  total_canceled: number;
  escalated_tickets: number;
  avg_mood: string;
  popular_items: string;
  top_complaints_tags: string;
  cancellation_reasons: string;
  ai_daily_advice: string;
  critical_alert: string;
}

const ORDER_STAGES = new Set([
  "MENU_SENT",
  "LINK_ISSUED",
  "CHECKING_KITCHEN",
  "PAYMENT_PENDING",
  "RECEIPT_VERIFICATION",
  "PREPARING",
  "COMPLETED",
]);

const PAYMENT_STAGES = new Set([
  "PAYMENT_PENDING",
  "RECEIPT_VERIFICATION",
  "PREPARING",
  "COMPLETED",
]);

const ANALYTICS_SENT_TTL_SECONDS = 60 * 60 * 24 * 45;

function asText(value: unknown, max = 400) {
  if (value === null || value === undefined) return "";
  const text = typeof value === "string" ? value : typeof value === "number" || typeof value === "boolean" ? String(value) : JSON.stringify(value);
  return text.replace(/\s+/g, " ").trim().slice(0, max);
}

function asCount(value: unknown) {
  const number = Number(value);
  return Number.isFinite(number) && number > 0 ? Math.trunc(number) : 0;
}

function stageOf(lead: DailyAnalyticsLead) {
  return String(lead.sales_stage || "").trim().toUpperCase();
}

/** Day boundary in the tenant's own timezone, not the server's UTC midnight. */
export function localDayKey(timeZone: string, date = new Date()) {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).formatToParts(date);
  const byType = Object.fromEntries(parts.map((part) => [part.type, part.value]));
  return `${byType.year}-${byType.month}-${byType.day}`;
}

export function normalizeLead(row: any): DailyAnalyticsLead {
  return {
    phone: asText(row?.phone_e164 || row?.phone, 32),
    interest: asText(row?.interest, 120),
    sales_stage: asText(row?.sales_stage, 60),
    psycho_analysis: asText(row?.psycho_analysis, 240),
  };
}

export function normalizeLeadRows(rows: any): DailyAnalyticsLead[] {
  const list = Array.isArray(rows) ? rows : rows?.leads || rows?.data || rows?.rows || [];
  return (Array.isArray(list) ? list : [])
    .map(normalizeLead)
    .filter((lead) => lead.phone || lead.interest || lead.sales_stage || lead.psycho_analysis);
}

/** The metric hash the reply path already increments, for one local day. */
export async function readDailyMetrics(instanceId: string, reportDate: string): Promise<Record<string, number>> {
  try {
    if (!instanceId || !reportDate) return {};
    await connectRedis();
    const key = `metrics:${instanceId}:${reportDate.replace(/-/g, "")}`;
    const raw = await redisClient.hGetAll(key).catch(() => ({} as Record<string, string>));
    return Object.fromEntries(Object.entries(raw || {}).map(([name, value]) => [name, Number(value) || 0]));
  } catch {
    return {};
  }
}

export async function readLearningNotes(instanceId: string, reportDate: string, limit = 40): Promise<string[]> {
  try {
    const events = await readLearningEvents(instanceId, 200);
    return events
      .filter((event) => String(event?.at || "").slice(0, 10) === reportDate)
      .slice(0, limit)
      .map((event) => `${event.type}: ${asText(event.detail, 160)}`)
      .filter(Boolean);
  } catch {
    return [];
  }
}

function countTop(values: string[], limit = 3) {
  const tally = new Map<string, number>();
  for (const value of values) {
    const key = value.trim().toLowerCase();
    if (!key) continue;
    tally.set(key, (tally.get(key) || 0) + 1);
  }
  return [...tally.entries()]
    .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
    .slice(0, limit)
    .map(([value, count]) => (count > 1 ? `${value} (${count})` : value));
}

/**
 * Every number in the row, derived from facts only. The model never touches
 * these: a count that a language model could reword is a count the owner cannot
 * trust.
 */
export function computeDailyFacts(inputs: DailyAnalyticsInputs) {
  const leads = inputs.leads || [];
  const metrics = inputs.metrics || {};
  const stages = leads.map(stageOf);

  const distinctGuests = new Set(leads.map((lead) => lead.phone).filter(Boolean)).size;
  const totalChats = Math.max(distinctGuests, leads.length, asCount(metrics.turns) > 0 && !leads.length ? 1 : 0);
  const intentOrders = stages.filter((stage) => ORDER_STAGES.has(stage)).length;
  const intentPayments = stages.filter((stage) => PAYMENT_STAGES.has(stage)).length;
  const totalCanceled = stages.filter((stage) => stage === "CANCELED").length;
  const totalComplaints = asCount(metrics.complaints);
  const escalatedTickets = asCount(metrics.escalations);
  // Percent, matching what the hub column has always displayed.
  const conversionRate = intentOrders > 0 ? Number(((intentPayments / intentOrders) * 100).toFixed(2)) : 0;

  return {
    total_chats: totalChats,
    intent_orders: intentOrders,
    intent_payments: intentPayments,
    conversion_rate: conversionRate,
    total_complaints: totalComplaints,
    total_canceled: totalCanceled,
    escalated_tickets: escalatedTickets,
    turns: asCount(metrics.turns),
    links_sent: asCount(metrics.links_sent),
    fallbacks: asCount(metrics.fallbacks),
  };
}

const POSITIVE_MOOD_RE = /(жақсы|ризамын|рахмет|рақмет|қуан|көңілді|довол|рад|спасибо|благодар|отличн|хорош|pleased|happy)/iu;
const NEGATIVE_MOOD_RE = /(ашулан|наразы|renjі|ренжі|шағым|қаһар|недовол|злит|раздраж|груб|жалоб|претенз|angry|upset)/iu;
const RUSHED_MOOD_RE = /(асығ|жылдам|тез|спеш|срочн|быстр|скорее|rushed|hurry)/iu;
const CONFUSED_MOOD_RE = /(түсінбе|шатас|білмей|не\s+понял|непонятн|путан|сомнева|unsure|confused)/iu;

/**
 * The judgement fields when the model is unavailable. It reads the same lead
 * notes the model would, so a bad day still reaches the owner as words rather
 * than as an apology for missing analysis.
 */
export function buildHeuristicJudgement(inputs: DailyAnalyticsInputs, facts: ReturnType<typeof computeDailyFacts>) {
  const notes = (inputs.leads || []).map((lead) => lead.psycho_analysis).filter(Boolean);
  const blob = notes.join(" ");

  let avgMood = facts.total_chats > 0 ? "Қалыпты" : "Дерек жоқ";
  if (blob) {
    if (NEGATIVE_MOOD_RE.test(blob)) avgMood = "Наразылық басым";
    else if (RUSHED_MOOD_RE.test(blob)) avgMood = "Асығыс";
    else if (CONFUSED_MOOD_RE.test(blob)) avgMood = "Күмәнді / түсінбеген";
    else if (POSITIVE_MOOD_RE.test(blob)) avgMood = "Көңілді";
  }

  const popular = countTop((inputs.leads || []).map((lead) => lead.interest).filter(Boolean));
  const complaintTags = countTop(
    (inputs.leads || [])
      .filter((lead) => NEGATIVE_MOOD_RE.test(lead.psycho_analysis || ""))
      .map((lead) => lead.psycho_analysis)
  );
  const cancelReasons = countTop(
    (inputs.leads || [])
      .filter((lead) => stageOf(lead) === "CANCELED")
      .map((lead) => lead.psycho_analysis || "себебі көрсетілмеген")
  );

  const advice: string[] = [];
  if (facts.total_chats === 0) advice.push("Бүгін ботқа жаңа диалог түспеді.");
  if (facts.total_canceled > 0) advice.push(`${facts.total_canceled} тапсырыс болдырылмады — себептерін қарау керек.`);
  if (facts.total_complaints > 0) advice.push(`${facts.total_complaints} шағым тіркелді.`);
  if (facts.intent_orders > 0 && facts.intent_payments === 0) advice.push("Тапсырыс басталды, бірақ төлемге жеткен жоқ.");
  if (facts.escalated_tickets > 0) advice.push(`${facts.escalated_tickets} рет операторға берілді.`);
  if (!advice.length && facts.total_chats > 0) advice.push("Күн тыныш өтті, ерекше мәселе байқалмады.");

  return {
    avg_mood: avgMood,
    popular_items: popular.join(", "),
    top_complaints_tags: complaintTags.join(", "),
    cancellation_reasons: cancelReasons.join(", "),
    ai_daily_advice: advice.join(" "),
    critical_alert: "",
  };
}

const ANALYST_SYSTEM_PROMPT = `You are the daily analyst of a WhatsApp ordering bot for one restaurant.
You are given the day's real facts: counters, guest funnel stages, and the bot's short notes about each guest's mood.
Write the owner-facing judgement fields. Rules:
- Use ONLY the given facts. Never invent a number, a dish, a complaint or a reason.
- Write in Kazakh, plainly, like a manager reporting to the owner. No marketing tone, no emoji.
- avg_mood: 2-4 words describing the prevailing guest mood today.
- popular_items: what guests actually asked about, comma separated. Empty string when nothing is known.
- top_complaints_tags: short complaint themes, comma separated. Empty string when there were none.
- cancellation_reasons: why orders were cancelled, comma separated. Empty string when none were.
- ai_daily_advice: 1-2 sentences the owner can act on tomorrow.
- critical_alert: only when the facts show something that needs attention TODAY (money, repeated complaints, everything failing). Otherwise empty string.
Output strict JSON with exactly these keys: avg_mood, popular_items, top_complaints_tags, cancellation_reasons, ai_daily_advice, critical_alert.
JSON only, no markdown, no commentary.`;

function analyticsModelId() {
  return String(process.env.ANALYTICS_MODEL || "").trim() || getTextModels().reserve;
}

function safeJsonObject(raw: string): Record<string, any> | null {
  const start = raw.indexOf("{");
  const end = raw.lastIndexOf("}");
  if (start < 0 || end <= start) return null;
  try {
    const parsed = JSON.parse(raw.slice(start, end + 1));
    return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

export function buildAnalystPrompt(inputs: DailyAnalyticsInputs, facts: ReturnType<typeof computeDailyFacts>) {
  const leadLines = (inputs.leads || [])
    .slice(0, 60)
    .map((lead, index) => {
      const parts = [
        `#${index + 1}`,
        lead.sales_stage ? `stage=${lead.sales_stage}` : "",
        lead.interest ? `interest=${lead.interest}` : "",
        lead.psycho_analysis ? `note=${lead.psycho_analysis}` : "",
      ].filter(Boolean);
      return parts.join(" ");
    })
    .filter((line) => line.replace(/^#\d+\s*/, "").length > 0);

  return [
    `restaurant: ${inputs.brand || inputs.instanceId}`,
    `report_date: ${inputs.reportDate}`,
    `guests: ${facts.total_chats}`,
    `bot_turns: ${facts.turns}`,
    `menu_links_sent: ${facts.links_sent}`,
    `started_ordering: ${facts.intent_orders}`,
    `reached_payment: ${facts.intent_payments}`,
    `cancelled: ${facts.total_canceled}`,
    `complaints: ${facts.total_complaints}`,
    `handed_to_operator: ${facts.escalated_tickets}`,
    `bot_reply_failures: ${facts.fallbacks}`,
    leadLines.length ? `guest_notes:\n${leadLines.join("\n")}` : "guest_notes: (none)",
    inputs.learningNotes?.length ? `internal_issues:\n${inputs.learningNotes.slice(0, 20).join("\n")}` : "internal_issues: (none)",
  ].join("\n");
}

export async function analyzeDayWithAi(
  inputs: DailyAnalyticsInputs,
  facts: ReturnType<typeof computeDailyFacts>,
  deps: { generate?: (args: { system: string; prompt: string; timeoutMs: number }) => Promise<string> } = {}
): Promise<Record<string, string> | null> {
  const timeoutMs = envNumber(process.env.ANALYTICS_MODEL_TIMEOUT_MS, 25_000, { min: 5_000, max: 60_000 });
  const prompt = buildAnalystPrompt(inputs, facts);

  try {
    const raw = deps.generate
      ? await deps.generate({ system: ANALYST_SYSTEM_PROMPT, prompt, timeoutMs })
      : await defaultGenerate({ system: ANALYST_SYSTEM_PROMPT, prompt, timeoutMs });
    const parsed = safeJsonObject(String(raw || ""));
    if (!parsed) return null;
    return {
      avg_mood: asText(parsed.avg_mood, 60),
      popular_items: asText(parsed.popular_items, 240),
      top_complaints_tags: asText(parsed.top_complaints_tags, 240),
      cancellation_reasons: asText(parsed.cancellation_reasons, 240),
      ai_daily_advice: asText(parsed.ai_daily_advice, 600),
      critical_alert: asText(parsed.critical_alert, 240),
    };
  } catch (error: any) {
    console.warn(`[ANALYTICS:AI] failed instance=${inputs.instanceId} date=${inputs.reportDate} reason=${error?.message || error}`);
    return null;
  }
}

async function defaultGenerate(args: { system: string; prompt: string; timeoutMs: number }) {
  const { generateText } = await import("ai");
  const result = await Promise.race([
    generateText({
      model: getOpenRouterProvider().chat(analyticsModelId()),
      system: args.system,
      prompt: args.prompt,
      temperature: 0,
    } as any),
    new Promise<never>((_resolve, reject) =>
      setTimeout(() => reject(new Error(`ANALYTICS_MODEL_TIMEOUT:${args.timeoutMs}ms`)), args.timeoutMs)
    ),
  ]);
  return String((result as any)?.text || "");
}

/**
 * The row the hub receives. Numbers come from facts, words from the model when
 * it answered and from the heuristic when it did not - and `critical_alert`
 * records which of the two wrote them, so a silent model degradation is visible
 * in the owner's own table instead of only in our logs.
 */
export function composeDailyAnalytics(
  inputs: DailyAnalyticsInputs,
  facts: ReturnType<typeof computeDailyFacts>,
  aiJudgement: Record<string, string> | null
): DailyAnalyticsRow {
  const heuristic = buildHeuristicJudgement(inputs, facts);
  const pick = (key: keyof typeof heuristic) => {
    const fromAi = aiJudgement ? asText(aiJudgement[key], 600) : "";
    return fromAi || heuristic[key];
  };

  // A day with no guests is a quiet day, not an incident. The model kept
  // restating "no guests today" here, which would train the owner to ignore the
  // one column that must mean something.
  const criticalAlert = facts.total_chats === 0
    ? ""
    : aiJudgement
      ? asText(aiJudgement.critical_alert, 240)
      : "AI талдау қолжетімсіз болды: сандар нақты, мәтін эвристикамен жазылды.";

  return {
    total_chats: facts.total_chats,
    intent_orders: facts.intent_orders,
    intent_payments: facts.intent_payments,
    conversion_rate: facts.conversion_rate,
    total_complaints: facts.total_complaints,
    total_canceled: facts.total_canceled,
    escalated_tickets: facts.escalated_tickets,
    avg_mood: pick("avg_mood"),
    popular_items: pick("popular_items"),
    top_complaints_tags: pick("top_complaints_tags"),
    cancellation_reasons: pick("cancellation_reasons"),
    ai_daily_advice: pick("ai_daily_advice"),
    critical_alert: criticalAlert,
  };
}

export async function buildDailyAnalyticsRow(
  inputs: DailyAnalyticsInputs,
  deps: { analyze?: typeof analyzeDayWithAi } = {}
): Promise<DailyAnalyticsRow> {
  const facts = computeDailyFacts(inputs);
  // A day nobody wrote in has nothing to analyse. Asking the model anyway spent
  // a call per tenant per empty day and came back with a different phrasing of
  // "no data" each time, so identical days read as different findings.
  if (facts.total_chats === 0) return composeDailyAnalytics(inputs, facts, buildHeuristicJudgement(inputs, facts));
  const analyze = deps.analyze || analyzeDayWithAi;
  const aiJudgement = await analyze(inputs, facts).catch(() => null);
  return composeDailyAnalytics(inputs, facts, aiJudgement);
}

/* ---------- delivery ledger: which days already reached the hub ---------- */

export function analyticsSentKey(instanceId: string) {
  return `analytics:sent:${instanceId}`;
}

export async function hasAnalyticsBeenSent(instanceId: string, reportDate: string): Promise<boolean> {
  try {
    if (!instanceId || !reportDate) return false;
    await connectRedis();
    return Boolean(await redisClient.hGet(analyticsSentKey(instanceId), reportDate));
  } catch {
    // Unknown means "send it": an upsert repeated is harmless, a day never sent
    // is a hole in the owner's table.
    return false;
  }
}

export async function markAnalyticsSent(instanceId: string, reportDate: string): Promise<void> {
  try {
    if (!instanceId || !reportDate) return;
    await connectRedis();
    await redisClient.multi()
      .hSet(analyticsSentKey(instanceId), reportDate, new Date().toISOString())
      .expire(analyticsSentKey(instanceId), ANALYTICS_SENT_TTL_SECONDS)
      .exec();
  } catch {
    // Losing the marker only costs a repeated idempotent upsert.
  }
}

/** Dates that still owe the hub a row, oldest first, today included. */
export function pendingReportDates(today: string, daysBack: number, sent: Set<string>) {
  const dates: string[] = [];
  const base = Date.parse(`${today}T12:00:00Z`);
  if (!Number.isFinite(base)) return dates;
  for (let offset = Math.max(0, daysBack); offset >= 0; offset -= 1) {
    const date = new Date(base - offset * 86_400_000).toISOString().slice(0, 10);
    if (!sent.has(date)) dates.push(date);
  }
  return dates;
}

export async function readSentDates(instanceId: string): Promise<Set<string>> {
  try {
    await connectRedis();
    const raw = await redisClient.hGetAll(analyticsSentKey(instanceId)).catch(() => ({} as Record<string, string>));
    return new Set(Object.keys(raw || {}));
  } catch {
    return new Set();
  }
}
