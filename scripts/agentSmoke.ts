import { runFastFoodAgent } from "../src/agent/fastfoodAgent.js";
import type { FastFoodContext } from "../src/context/types.js";
import { getRestaurantConfig } from "../src/services/platformConfig.service.js";

const instanceId = String(process.env.SMOKE_INSTANCE_ID || "prestige").trim();
const text = process.argv.slice(2).join(" ").trim() || "Сен кімсің?";
const watchdogMs = Number(process.env.SMOKE_TIMEOUT_MS || 75_000);
const watchdog = setTimeout(() => {
  console.error(JSON.stringify({ instanceId, error: "SMOKE_TIMEOUT", elapsedMs: watchdogMs }));
  process.exit(124);
}, watchdogMs);
const config = await getRestaurantConfig(instanceId);

if (!config) {
  throw new Error(`SMOKE_TENANT_CONFIG_NOT_FOUND:${instanceId}`);
}

const ctx: FastFoodContext = {
  instanceId,
  phone: "77000000000",
  text,
  senderMeta: { name: "Smoke Test" },
  language: /[әіңғүұқөһ]/i.test(text) ? "kk" : "ru",
  languagePolicy: {},
  config,
  runtimeStatus: null,
  fetchedSettings: config,
  hardRealtimeContext: {},
  activeOrder: null,
  chatHistory: [],
  activeShiftNotes: [],
  activeShiftNotesFingerprint: "",
  mediaContext: null,
  shporContext: [],
  magicLinkAlreadySent: false,
  explicitMenuLinkIntent: /мәзір|меню|menu/i.test(text),
  magicLink: null,
};

const startedAt = Date.now();
const result = await runFastFoodAgent(ctx);

console.log(JSON.stringify({
  instanceId,
  elapsedMs: Date.now() - startedAt,
  text: result.text,
  finishReason: result.finishReason,
  toolPlan: result.toolPlan,
  toolCalls: result.toolCalls,
  validationWarnings: result.validationWarnings,
}, null, 2));
clearTimeout(watchdog);
process.exit(0);
