import assert from "node:assert/strict";
import test from "node:test";
import {
  buildAnalystPrompt,
  buildHeuristicJudgement,
  composeDailyAnalytics,
  computeDailyFacts,
  localDayKey,
  normalizeLeadRows,
  pendingReportDates,
  type DailyAnalyticsInputs,
} from "../src/services/dailyAnalytics.service.js";
import { buildDailyAnalyticsRow } from "../src/services/dailyAnalytics.service.js";

function inputs(overrides: Partial<DailyAnalyticsInputs> = {}): DailyAnalyticsInputs {
  return {
    instanceId: "prestige",
    reportDate: "2026-08-25",
    brand: "Crazy Суши",
    leads: [],
    metrics: {},
    learningNotes: [],
    ...overrides,
  };
}

test("hub lead shapes all normalize, whether wrapped or bare", () => {
  assert.deepEqual(
    normalizeLeadRows({
      date: "2026-08-25",
      leads: [
        { phone_e164: "+77009000606", interest: "суши", sales_stage: "CANCELED", psycho_analysis: "Тапсырысты болдырғысы келеді" },
        { phone_e164: "", interest: "", sales_stage: "", psycho_analysis: "" },
      ],
    }),
    [{ phone: "+77009000606", interest: "суши", sales_stage: "CANCELED", psycho_analysis: "Тапсырысты болдырғысы келеді" }],
  );

  assert.equal(normalizeLeadRows([{ phone: "77001112233", sales_stage: "link_issued" }]).length, 1);
  assert.deepEqual(normalizeLeadRows(null), []);
  assert.deepEqual(normalizeLeadRows({ rows: [{ interest: "донер" }] })[0].interest, "донер");
});

test("every number in the row comes from facts, never from a model", () => {
  const facts = computeDailyFacts(inputs({
    leads: [
      { phone: "+7700000001", interest: "суши", sales_stage: "link_issued", psycho_analysis: "" },
      { phone: "+7700000002", interest: "донер", sales_stage: "PAYMENT_PENDING", psycho_analysis: "асығыс" },
      { phone: "+7700000003", interest: "пицца", sales_stage: "COMPLETED", psycho_analysis: "ризамын" },
      { phone: "+7700000004", interest: "", sales_stage: "CANCELED", psycho_analysis: "күте алмады" },
    ],
    metrics: { turns: 31, complaints: 2, escalations: 1, links_sent: 3, fallbacks: 0 },
  }));

  assert.equal(facts.total_chats, 4);
  // link_issued, PAYMENT_PENDING and COMPLETED are all "started ordering".
  assert.equal(facts.intent_orders, 3);
  assert.equal(facts.intent_payments, 2);
  assert.equal(facts.total_canceled, 1);
  assert.equal(facts.total_complaints, 2);
  assert.equal(facts.escalated_tickets, 1);
  assert.equal(facts.conversion_rate, 66.67);
  assert.equal(facts.turns, 31);
});

test("a day with turns but no hub leads still counts as a served day", () => {
  const facts = computeDailyFacts(inputs({ metrics: { turns: 5 } }));
  assert.equal(facts.total_chats, 1);
  assert.equal(facts.conversion_rate, 0);
});

test("an empty day reports zero without inventing a funnel", () => {
  const facts = computeDailyFacts(inputs());
  assert.deepEqual(
    { chats: facts.total_chats, orders: facts.intent_orders, rate: facts.conversion_rate },
    { chats: 0, orders: 0, rate: 0 },
  );
  const judgement = buildHeuristicJudgement(inputs(), facts);
  assert.equal(judgement.avg_mood, "Дерек жоқ");
  assert.match(judgement.ai_daily_advice, /жаңа диалог түспеді/);
});

test("the heuristic reads the guest notes instead of apologising for missing analysis", () => {
  const day = inputs({
    leads: [
      { phone: "+7700000001", interest: "донер", sales_stage: "CANCELED", psycho_analysis: "Кешігуге наразы" },
      { phone: "+7700000002", interest: "донер", sales_stage: "MENU_SENT", psycho_analysis: "асығыс" },
    ],
    metrics: { turns: 9, complaints: 1 },
  });
  const facts = computeDailyFacts(day);
  const judgement = buildHeuristicJudgement(day, facts);

  assert.equal(judgement.avg_mood, "Наразылық басым");
  assert.match(judgement.popular_items, /донер \(2\)/);
  assert.match(judgement.top_complaints_tags, /наразы/i);
  assert.match(judgement.cancellation_reasons, /наразы/i);
  assert.match(judgement.ai_daily_advice, /болдырылмады/);
  // The old cron wrote this sentence every single day. It must never come back.
  assert.doesNotMatch(judgement.ai_daily_advice, /уақытша қолжетімсіз/);
});

test("model words are used, model numbers are ignored", () => {
  const day = inputs({
    leads: [{ phone: "+7700000001", interest: "суши", sales_stage: "COMPLETED", psycho_analysis: "ризамын" }],
    metrics: { turns: 4 },
  });
  const facts = computeDailyFacts(day);
  const row = composeDailyAnalytics(day, facts, {
    avg_mood: "Көңілді",
    popular_items: "филадельфия",
    top_complaints_tags: "",
    cancellation_reasons: "",
    ai_daily_advice: "Филадельфия сұранысы жоғары, қорын алдын ала дайындаңыз.",
    critical_alert: "",
    total_chats: "999",
  } as any);

  assert.equal(row.avg_mood, "Көңілді");
  assert.equal(row.popular_items, "филадельфия");
  assert.equal(row.total_chats, 1);
  assert.equal(row.intent_orders, 1);
  assert.equal(row.critical_alert, "");
});

test("a failed model degrades to the heuristic and says so in the row", () => {
  const day = inputs({ leads: [{ phone: "+7700000001", interest: "суши", sales_stage: "MENU_SENT", psycho_analysis: "" }] });
  const facts = computeDailyFacts(day);
  const row = composeDailyAnalytics(day, facts, null);

  assert.equal(row.avg_mood, "Қалыпты");
  assert.match(row.critical_alert, /AI талдау қолжетімсіз/);
  assert.equal(row.total_chats, 1);
});

test("an empty day with no model does not raise a false alarm", () => {
  const facts = computeDailyFacts(inputs());
  assert.equal(composeDailyAnalytics(inputs(), facts, null).critical_alert, "");
});

test("buildDailyAnalyticsRow survives an analyzer that throws", async () => {
  const day = inputs({ metrics: { turns: 2 } });
  const row = await buildDailyAnalyticsRow(day, {
    analyze: async () => {
      throw new Error("MODEL_DOWN");
    },
  });
  assert.equal(row.total_chats, 1);
  assert.match(row.critical_alert, /AI талдау қолжетімсіз/);
});

test("a day nobody wrote in is not sent to the model at all", async () => {
  let called = false;
  const row = await buildDailyAnalyticsRow(inputs(), {
    analyze: async () => {
      called = true;
      return null;
    },
  });
  assert.equal(called, false);
  assert.equal(row.avg_mood, "Дерек жоқ");
  assert.match(row.ai_daily_advice, /жаңа диалог түспеді/);
  // A quiet day is not an incident, and never raises the alert column.
  assert.equal(row.critical_alert, "");
});

test("the analyst prompt carries the facts and the guest notes, and no secrets", () => {
  const day = inputs({
    leads: [{ phone: "+77009000606", interest: "суши", sales_stage: "CANCELED", psycho_analysis: "күте алмады" }],
    metrics: { turns: 7, links_sent: 2 },
    learningNotes: ["validator_edit: cut an unverified price"],
  });
  const prompt = buildAnalystPrompt(day, computeDailyFacts(day));

  assert.match(prompt, /report_date: 2026-08-25/);
  assert.match(prompt, /restaurant: Crazy Суши/);
  assert.match(prompt, /cancelled: 1/);
  assert.match(prompt, /bot_turns: 7/);
  assert.match(prompt, /note=күте алмады/);
  assert.match(prompt, /internal_issues:/);
  // Guest phone numbers are not needed to describe a day.
  assert.doesNotMatch(prompt, /77009000606/);
});

test("missed days are caught up, delivered days are left alone", () => {
  assert.deepEqual(
    pendingReportDates("2026-08-25", 3, new Set(["2026-08-23"])),
    ["2026-08-22", "2026-08-24", "2026-08-25"],
  );
  // Today is always pending: the row is refreshed until the day closes.
  assert.deepEqual(pendingReportDates("2026-08-25", 0, new Set(["2026-08-25"])), []);
  assert.deepEqual(pendingReportDates("2026-08-25", 0, new Set()), ["2026-08-25"]);
  assert.deepEqual(pendingReportDates("not-a-date", 3, new Set()), []);
});

test("the report date follows the restaurant's own clock", () => {
  // Almaty is UTC+5, so 19:30Z is already the next day there while UTC is not.
  const afterAlmatyMidnight = new Date("2026-08-25T19:30:00Z");
  assert.equal(localDayKey("Asia/Almaty", afterAlmatyMidnight), "2026-08-26");
  assert.equal(localDayKey("UTC", afterAlmatyMidnight), "2026-08-25");
});
