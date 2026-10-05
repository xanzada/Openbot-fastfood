import {readFileSync} from "node:fs";
import vm from "node:vm";
import crypto from "node:crypto";
import {createRequire} from "node:module";
import ts from "typescript";
import {createClient} from "redis";
import {FixtureNotificationStore} from "./operatorNotificationFixture.js";
import {queueOperatorCaseNotifications} from "../../src/services/operatorNotification.service.js";
import {isLikelyMenuQuestion} from "../../src/utils/intentText.js";

export const lifecycleRedisEnabled = Boolean(process.env.AUDIT_REDIS_SOCKET);
let sequence = 0;
export async function operatorLifecycleFixture() {
  const client = createClient({socket: {path: process.env.AUDIT_REDIS_SOCKET!, reconnectStrategy: false}, disableOfflineQueue: true});
  client.on("error", () => {});
  await client.connect();
  const instance = `rev09_fixture_${process.pid}_${++sequence}`, phone = "77000000002";
  const store = new FixtureNotificationStore(), exports: any = {};
  let now = 1791240000000, hook: (() => Promise<void>) | null = null, hookUsed = false, phase = "before";
  class ClockDate extends Date { static now() {return now;} }
  const proxy = new Proxy(client, {get(target, name) {
    if (name === "eval") return async (script: string, args: any) => {
      const fire = hook && !hookUsed && args.keys.some((key: string) => key.startsWith("operator_case:"));
      if (fire) hookUsed = true;
      if (fire && phase === "before") await hook!();
      const result = await target.eval(script, args);
      if (fire && phase === "after") await hook!();
      return result;
    };
    const value = (target as any)[name]; return typeof value === "function" ? value.bind(target) : value;
  }});
  const modules: any = {
    "node:crypto": crypto,
    "./redis.service.js": {redisClient: proxy, connectRedis: async () => {}, CHAT_HISTORY_TTL_SECONDS: 604800},
    "../utils/intentText.js": {isLikelyMenuQuestion},
    "./operatorNotification.service.js": {
      queueOperatorCaseNotifications: (args: any) => queueOperatorCaseNotifications(args, now, store),
      drainOperatorNotifications: async () => [],
    },
  };
  const source = readFileSync(process.env.AUDIT_SOS_CASE_BASELINE_SOURCE || new URL("../../src/services/operatorCase.service.ts", import.meta.url), "utf8");
  vm.runInNewContext(ts.transpileModule(source, {compilerOptions: {module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, esModuleInterop: true}}).outputText,
    {exports, Date: ClockDate, console, require: (name: string) => modules[name]});
  const require = createRequire(import.meta.url);
  const sosStore = process.env.AUDIT_WHATSPRO_ROOT
    ? require(process.env.AUDIT_WHATSPRO_ROOT + "/services/sosStore").createSosStore(client, {now: () => now}) : null;
  const key = (name: string, id = "") => ({
    active: `operator_case_active:${instance}:${phone}`, case: `operator_case:${instance}:${id}`,
    marker: `chatwoot:sos:${instance}:${phone}`, unread: `chatwoot:sos-unread:${instance}:${phone}`,
    sos: `chatwoot:sos:${instance}`, inbox: `chatwoot:inbox:${instance}`, index: `operator_cases:${instance}`,
    history: `history:${instance}:${phone}`, ledger: `sos_hub_sent:${instance}:${id}`,
  }[name]!);
  const create = (extra: any = {}) => exports.createOperatorCase({
    instanceId: instance, phone, kind: "complaint", summary: "Холодная еда",
    source: "ai_tool_escalate_to_admin", signalId: "initial_signal", ...extra,
  });
  return {
    instance, phone, client, store, cases: exports, key, create, sosStore,
    setHook(fn: () => Promise<void>, ordering = "before") {hook = fn; hookUsed = false; phase = ordering;},
    hookUsed: () => hookUsed, advance(ms: number) {now += ms;}, time: () => now,
    async close() {
      for await (const rows of client.scanIterator({MATCH: `*:${instance}*`, COUNT: 100})) {
        const keys = rows.filter(k => k.includes(":" + instance));
        if (keys.length) await client.del(keys);
      }
      await client.quit();
    },
  };
}
