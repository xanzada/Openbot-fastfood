import {readFileSync} from "node:fs";
import vm from "node:vm";
import crypto from "node:crypto";
import ts from "typescript";
import {createClient} from "redis";
import {envNumber} from "../../src/utils/envNumber.js";

export const planRedisEnabled = Boolean(process.env.AUDIT_REDIS_SOCKET);
let sequence = 0;
export async function operatorPlanFixture() {
  const redis = createClient({socket: {path: process.env.AUDIT_REDIS_SOCKET!, reconnectStrategy: false}, disableOfflineQueue: true});
  redis.on("error", () => {}); await redis.connect();
  const instance = `rev18_fixture_${process.pid}_${++sequence}`, phone = "77000000002";
  let now = 1791240000000, fault = "", used = false, config: any = {instance_id: instance, admin_phone: "77000000009"};
  const calls = {admin: [] as any[], hub: [] as any[]};
  class ClockDate extends Date {static now() {return now;}}
  const proxy = new Proxy(redis, {get(target, name) {
    if (name === "eval") return async (script: string, args: any) => {
      const canonical = args.keys.some((key: string) => key.startsWith("operator_case:"));
      const adminPrepare = args.keys[0]?.startsWith("operator_notification:") && args.keys[0]?.endsWith(":admin") && script.includes("local existing=");
      if (!used && fault === "before_admin_plan" && adminPrepare) {used = true; throw new Error("SIMULATED_PROCESS_EXIT");}
      const result = await target.eval(script, args);
      if (!used && fault === "after_lifecycle" && canonical) {used = true; throw new Error("SIMULATED_PROCESS_EXIT");}
      return result;
    };
    const value = (target as any)[name]; return typeof value === "function" ? value.bind(target) : value;
  }});
  const cache: any = {};
  const modules: any = {
    "node:crypto": crypto,
    "./redis.service.js": {redisClient: proxy, connectRedis: async () => {}, CHAT_HISTORY_TTL_SECONDS: 604800},
    "../utils/intentText.js": {isLikelyMenuQuestion: () => false},
    "./platformConfig.service.js": {getRestaurantConfig: async () => config},
    "./alemiApi.service.js": {reportOperatorSos: async (args: any) => {calls.hub.push(args); return {ok: true};}},
    "../transport/whatspro.client.js": {sendWhatsProMessage: async (args: any) => {calls.admin.push(args); return {acknowledged: true, queued: false};}},
  };
  function load(name: string): any {
    if (cache[name]) return cache[name];
    const exports: any = {};
    const source = readFileSync(name === "operatorCase.service" && process.env.AUDIT_SOS_CASE_BASELINE_SOURCE
      ? process.env.AUDIT_SOS_CASE_BASELINE_SOURCE : name === "operatorNotification.service" && process.env.AUDIT_OPERATOR_NOTIFICATION_BASELINE_SOURCE
      ? process.env.AUDIT_OPERATOR_NOTIFICATION_BASELINE_SOURCE : new URL("../../src/services/" + name + ".ts", import.meta.url), "utf8");
    vm.runInNewContext(ts.transpileModule(source, {compilerOptions: {module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, esModuleInterop: true}}).outputText,
      {exports, Date: ClockDate, console, setInterval, clearInterval, require(dependency: string) {
        if (name === "operatorCase.service" && dependency === "./operatorNotification.service.js") {
          return {queueOperatorCaseNotifications: load("operatorNotification.service").queueOperatorCaseNotifications, drainOperatorNotifications: async () => []};
        }
        if (dependency === "./durableNotification.service.js") return load("durableNotification.service");
        if (modules[dependency]) return modules[dependency];
        throw new Error("Unapproved fixture dependency " + dependency);
      }});
    return cache[name] = exports;
  }
  let complete: (() => void) | null = null;
  const intervals: Array<{fn: () => void; ms: number}> = [], cronExports: any = {};
  const cronModules: any = {
    "../services/redis.service.js": {redisClient: redis},
    "../services/platformConfig.service.js": {getAllRestaurantConfigs: async () => [{instance_id: instance}]},
    "../utils/envNumber.js": {envNumber},
    "../services/operatorNotification.service.js": {drainOperatorNotifications: (configs: any[]) =>
      load("operatorNotification.service").drainOperatorNotifications(configs, now).finally(() => complete?.())},
  };
  const cronSource = readFileSync(new URL("../../src/cron/statsCron.ts", import.meta.url), "utf8");
  vm.runInNewContext(ts.transpileModule(cronSource, {compilerOptions: {module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, esModuleInterop: true}}).outputText,
    {exports: cronExports, require: (name: string) => cronModules[name] || {}, Date: ClockDate, console,
      process: {env: {}}, setTimeout: () => ({unref() {}}),
      setInterval: (fn: () => void, ms: number) => {intervals.push({fn, ms}); return {unref() {}};}});
  const key = (name: string, id: string) => `operator_notification:${instance}:${id}:${name}`;
  const index = `operator_notification_pending:${instance}`;
  const create = (extra: any = {}) => load("operatorCase.service").createOperatorCase({
    instanceId: instance, phone, kind: "complaint", source: "ai_tool_escalate_to_admin",
    summary: "Synthetic genuine incident", signalId: "initial_signal", ...extra,
  });
  return {
    instance, phone, redis, calls, key, index, create,
    canonical: (id: string) => `operator_case:${instance}:${id}`,
    active: `operator_case_active:${instance}:${phone}`, marker: `chatwoot:sos:${instance}:${phone}`,
    fault(mode: string) {fault = mode; used = false;}, hookUsed: () => used, advance(ms: number) {now += ms;},
    setConfig(value: any) {config = value;},
    async restartDrain() {fault = ""; for (const key of Object.keys(cache)) delete cache[key];
      return load("operatorNotification.service").drainOperatorNotifications([{instance_id: instance}], now);},
    async workerTick() {
      fault = ""; for (const key of Object.keys(cache)) delete cache[key];
      cronExports.startDailyCron();
      const timer = intervals.find(row => row.ms === 2000);
      if (!timer) throw new Error("PRODUCTION_OPERATOR_TIMER_MISSING");
      await new Promise<void>(resolve => {complete = resolve; timer.fn();});
    },
    async close() {
      for await (const rows of redis.scanIterator({MATCH: `*:${instance}*`, COUNT: 100})) {
        const keys = rows.filter(key => key.includes(":" + instance)); if (keys.length) await redis.del(keys);
      }
      await redis.quit();
    },
  };
}
