import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import vm from "node:vm";
import ts from "typescript";
import { localDayKey } from "../src/services/dailyAnalytics.service.js";

// Execute the real cron with deterministic storage/transport and a clock that
// crosses midnight while the first restaurant's report is in flight.
function cronHarness(start: string, crossMidnight: boolean) {
  let clock = Date.parse(start);
  const configs = ["first", "second"].map((instance_id) => ({
    instance_id, timezone: "Asia/Almaty", alemi_secret: "test-only",
  }));
  const sent: Array<{ instance: string; date: string }> = [];
  const finalized: Array<{ instance: string; date: string }> = [];
  const row = { total_chats: 0, intent_orders: 0, intent_payments: 0,
    total_complaints: 0, total_canceled: 0, escalated_tickets: 0, avg_mood: "quiet" };
  class Clock extends Date {
    constructor(value?: string | number) { super(value === undefined ? clock : value); }
    static now() { return clock; }
  }
  const modules: Record<string, any> = {
    "../services/redis.service.js": { redisClient: { isOpen: true } },
    "../services/platformConfig.service.js": {
      getAllRestaurantConfigs: async () => configs,
      getRestaurantConfig: async (id: string) => configs.find(c => c.instance_id === id),
    },
    "../services/developerNotify.service.js": {
      notifyDeveloperSystemFailure: async (_id: string, error: Error) => { throw error; },
    },
    "../services/alemiApi.service.js": {
      callAlemiLegacyAction: async (action: string, payload: any) => {
        if (action === "get_today_crm") return [];
        sent.push({ instance: payload.restaurant_id, date: payload.report_date });
        if (crossMidnight) clock = Date.parse("2026-09-09T19:00:03Z");
        return { ok: true };
      },
    },
    "../services/dailyAnalytics.service.js": {
      localDayKey: (tz: string, date = new Clock()) => localDayKey(tz, date),
      readSentDates: async () => new Set(),
      pendingReportDates: (today: string) => [today],
      normalizeLeadRows: (rows: unknown) => rows,
      readDailyMetrics: async () => ({}), readLearningNotes: async () => [],
      buildDailyAnalyticsRow: async () => row,
      markAnalyticsSent: async (instance: string, date: string) => { finalized.push({ instance, date }); },
    },
    "../utils/envNumber.js": { envNumber: (_value: unknown, fallback: number) => fallback },
  };
  const source = readFileSync(new URL("../src/cron/statsCron.ts", import.meta.url), "utf8");
  const compiled = ts.transpileModule(source, {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
  }).outputText;
  const exports: Record<string, any> = {};
  vm.runInNewContext(compiled, {
    exports, require: (name: string) => {
      if (!(name in modules)) throw new Error(`Unexpected dependency: ${name}`);
      return modules[name];
    },
    Date: Clock, Intl, process: { env: {} }, console: { log() {}, warn() {}, error() {} },
  });
  return { run: exports.processDailyAnalytics, sent, finalized };
}

test("one nightly run keeps its report day when the first tenant crosses midnight", async () => {
  const harness = cronHarness("2026-09-09T18:59:56Z", true);
  await harness.run();
  assert.deepEqual(harness.sent, [
    { instance: "first", date: "2026-09-09" },
    { instance: "second", date: "2026-09-09" },
  ]);
});

test("23:59 reports stay provisional so reconciliation can include the last minute", async () => {
  const harness = cronHarness("2026-09-09T18:59:01Z", false);
  await harness.run();
  assert.equal(harness.sent.length, 2);
  assert.deepEqual(harness.finalized, []);
});
