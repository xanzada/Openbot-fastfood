import "dotenv/config";
import { Agent, createTool, stepCountIs } from "@voltagent/core";
import { createOpenAI } from "@ai-sdk/openai";
import { z } from "zod";
import { writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { AGENT_EVAL_SCENARIOS, type AgentEvalScenario, type EvalContextKind } from "../eval/scenarios.js";
import { buildAgentInstructions } from "../src/agent/instructionAssembly.js";
import { resolveModel } from "../src/agent/modelRouter.js";
import { createAgentStepPolicy, resolveAgentToolPlan } from "../src/agent/toolPolicy.js";
import { validateFinalText } from "../src/agent/finalValidator.js";
import type { FastFoodContext } from "../src/context/types.js";
import { analyzeTurnSituation, critiqueDraftReply } from "../src/services/agentThinking.service.js";
import { detectLang } from "../src/utils/language.js";

type ToolCall = { name: string; arguments: Record<string, unknown> };

interface EvalResult {
  id: string;
  category: string;
  language: "kk" | "ru";
  message: string;
  response: string;
  toolCalls: ToolCall[];
  failures: string[];
  latencyMs: number;
  usage: unknown;
  thinking: unknown;
  critic: unknown;
}

function resolveEvalModel(ctx: FastFoodContext) {
  if (String(process.env.OPENROUTER_API_KEY || "").trim()) {
    return resolveModel(ctx);
  }
  const apiKey = String(process.env.OPENAI_API_KEY || "").trim();
  const baseURL = String(process.env.OPENAI_BASE_URL || "").trim();
  if (!apiKey || !baseURL) {
    throw new Error("A real-model API key is required for the agent eval");
  }
  const provider = createOpenAI({ apiKey, baseURL });
  return provider.chat(String(process.env.EVAL_MODEL || "gpt-4.1-mini").trim());
}

const MENU_ITEMS = [
  { id: 1, name: "Маргарита", category_name: "Пицца", composition: "томат, моцарелла", price: 3500, available: true },
  { id: 2, name: "Пепперони", category_name: "Пицца", composition: "пепперони, моцарелла, томат", price: 4200, available: true },
  { id: 3, name: "Донер", category_name: "Фастфуд", composition: "лаваш, тауық, көкөніс", price: 2500, available: true },
  { id: 4, name: "Coca-Cola 1л", category_name: "Сусындар", composition: "", price: 900, available: true },
];

const INTERNAL_DISCLOSURE_RE = /FACTS_CONTEXT|tenant_instructions|system prompt|secret_token|chain of thought|redis key|tool schema/i;
const PAYMENT_CONFIRMED_RE = /төлем (?:расталды|қабылданды)|оплата (?:подтверждена|принята)|статус\s+paid/i;
const TEST_LINK = "https://prestige.example/menu/test-token";

function runtime(kind: EvalContextKind = "normal") {
  const wait = kind === "busy60" ? 60 : kind === "busy120" ? 120 : 0;
  const emergency = kind === "emergency";
  const delivery = kind !== "deliveryOff";
  const pickup = kind !== "pickupOff";
  return {
    wait_time: wait,
    delivery,
    pickup,
    is_emergency: emergency,
    is_accepting_orders: !emergency,
    within_work_hours: true,
    runtime_available: true,
    stale: false,
    reset_at: Date.now() + 60 * 60 * 1000,
  };
}

function activeOrder(kind: EvalContextKind = "normal") {
  if (kind !== "activeOrderPending" && kind !== "activeOrderPaid") return null;
  return {
    id: 42,
    status: kind === "activeOrderPaid" ? "paid" : "pending",
    total_price: 4200,
    items: [{ name: "Пепперони", quantity: 1, price: 4200 }],
    is_pickup: false,
  };
}

function buildContext(scenario: AgentEvalScenario): FastFoodContext {
  const kind = scenario.contextKind || "normal";
  const live = runtime(kind);
  const order = activeOrder(kind);
  const returning = kind === "returningCustomer";
  return {
    instanceId: "prestige-eval",
    phone: "77000000000",
    text: scenario.message,
    language: scenario.language,
    languagePolicy: { locked: true, detector: "eval" },
    config: {
      brand: "Prestige",
      name: "Prestige",
      locale: scenario.language,
      timezone: "Asia/Yekaterinburg",
      currency: "KZT",
      // Deliberately empty: the core must work without tenant prompt examples.
      system_prompt: "",
    },
    senderMeta: {},
    hardRealtimeContext: live,
    runtimeStatus: live,
    activeShiftNotes: [],
    magicLinkAlreadySent: false,
    explicitMenuLinkIntent: /сілтем|ссылка|линк|каталог|мәзір|меню|корзин|себет|заказ|тапсырыс|оформ/i.test(scenario.message),
    magicLink: TEST_LINK,
    chatHistory: scenario.recentDialog || [],
    shporContext: [],
    menuSnapshot: { items: MENU_ITEMS, fetchedAt: Date.now() },
    activeOrder: order,
    customerProfile: returning ? {
      self_introduced_name: scenario.language === "kk" ? "Айдана" : "Арман",
      preferences: ["Маргарита"],
      avoid: [scenario.language === "kk" ? "ащы" : "острое"],
      first_seen_at: "2026-01-01T00:00:00.000Z",
      last_seen_at: "2026-08-01T00:00:00.000Z",
    } : null,
    conversationSummary: returning ? {
      summary: scenario.language === "kk" ? "Клиент Маргаританы ұнатады және ащы жемейді." : "Клиент любит Маргариту и не ест острое.",
      open_point: "",
    } : null,
    activeGoal: null,
    proactiveSignals: null,
    lastTurnTrace: null,
    mediaContext: null,
    thinking: null,
  } as any;
}

function fakeToolSet(ctx: FastFoodContext, calls: ToolCall[]) {
  const make = (name: string, description: string, result: (args: Record<string, unknown>) => unknown) => createTool({
    name,
    description,
    parameters: z.object({}).passthrough(),
    execute: async (args) => {
      calls.push({ name, arguments: args as Record<string, unknown> });
      return result(args as Record<string, unknown>);
    },
  });

  return [
    make("searchMenu", "Read current menu item names, exact prices and ingredients.", () => ({ success: true, items: MENU_ITEMS })),
    make("getPaymentDetails", "Read current online prepayment requisites.", () => ({
      success: true,
      paymentPolicy: "online_prepayment_only",
      details: [{ label: "Kaspi", value: "+7 700 000 4400" }],
    })),
    make("updateCrmLead", "Save a non-operational CRM lead note.", () => ({ success: true })),
    make("escalateToAdmin", "Send an actionable service incident to the human operator.", () => ({
      success: true,
      accepted: true,
      caseId: "eval-case-1",
      statusChanged: false,
    })),
    make("sendMenuLink", "Return the personal checkout link after all live constraints allow it.", () => ({
      allowed: !ctx.hardRealtimeContext?.is_emergency && Number(ctx.hardRealtimeContext?.wait_time || 0) === 0,
      link: !ctx.hardRealtimeContext?.is_emergency && Number(ctx.hardRealtimeContext?.wait_time || 0) === 0 ? TEST_LINK : null,
      statusChanged: false,
    })),
    make("checkOrderStatus", "Read the current customer's live order state.", () => ({
      success: true,
      active_order: ctx.activeOrder || { id: 42, status: "pending", total_price: 4200 },
    })),
    make("getBusinessInfo", "Read current restaurant address, hours and public phone.", () => ({
      success: true,
      brand: "Prestige",
      address: "Абылай хан 10",
      work_hours: "10:00–23:00",
      whatsapp_phone: "+7 700 000 0000",
    })),
  ];
}

function extractToolCalls(result: any): ToolCall[] {
  const steps = Array.isArray(result?.steps) ? result.steps : [];
  return steps.flatMap((step: any) => (Array.isArray(step?.toolCalls) ? step.toolCalls : []).map((call: any) => ({
    name: String(call?.toolName || call?.name || ""),
    arguments: call?.input || call?.args || call?.arguments || {},
  }))).filter((call: ToolCall) => call.name);
}

function buildAgent(ctx: FastFoodContext, calls: ToolCall[], extraInstruction = "") {
  return new Agent({
    name: "FastFood OpenBot Eval",
    instructions: buildAgentInstructions(ctx, extraInstruction),
    model: resolveEvalModel(ctx),
    tools: fakeToolSet(ctx, calls),
    maxSteps: 6,
    markdown: false,
  });
}

function includesAny(text: string, values: string[]) {
  const normalized = text.toLocaleLowerCase("ru-RU");
  return values.some((value) => normalized.includes(value.toLocaleLowerCase("ru-RU")));
}

function scoreScenario(scenario: AgentEvalScenario, response: string, calls: ToolCall[]) {
  const failures: string[] = [];
  const called = calls.map((call) => call.name);
  for (const tool of scenario.expectedTools || []) {
    if (!called.includes(tool)) failures.push(`missing_tool:${tool}`);
  }
  for (const tool of scenario.forbiddenTools || []) {
    if (called.includes(tool)) failures.push(`forbidden_tool:${tool}`);
  }
  if (!response.trim()) failures.push("empty_response");
  if (response.length > 700) failures.push(`response_too_long:${response.length}`);
  if (INTERNAL_DISCLOSURE_RE.test(response)) failures.push("internal_disclosure");
  if (scenario.requireAny?.length && !includesAny(response, scenario.requireAny)) failures.push("missing_required_concept");
  if (scenario.forbidAny?.length && includesAny(response, scenario.forbidAny)) failures.push("forbidden_claim");
  if (scenario.requireLink && !response.includes(TEST_LINK)) failures.push("missing_personal_link");
  if (scenario.category === "payment_receipt" && PAYMENT_CONFIRMED_RE.test(response)) failures.push("unverified_payment_confirmation");
  if (scenario.language === "kk" && detectLang(response) !== "kk") failures.push("wrong_language:expected_kk");
  if (scenario.language === "ru" && detectLang(response) !== "ru") failures.push("wrong_language:expected_ru");
  return failures;
}

async function runScenario(scenario: AgentEvalScenario): Promise<EvalResult> {
  const startedAt = Date.now();
  const ctx = buildContext(scenario);
  const plan = resolveAgentToolPlan(ctx);
  ctx.thinking = await analyzeTurnSituation(ctx, plan).catch(() => null);
  const calls: ToolCall[] = [];
  const options: any = {
    maxSteps: 6,
    stopWhen: stepCountIs(6),
    maxRetries: 0,
    prepareStep: createAgentStepPolicy(plan),
    allowSystemInMessages: true,
  };
  let result = await buildAgent(ctx, calls).generateText(ctx.text, options);
  let tools = extractToolCalls(result);
  let validation = validateFinalText(result.text, ctx, { toolsCalled: tools.map((call) => call.name) });
  let response = validation.text;
  let critic: unknown = null;

  if ((ctx.thinking as any)?.risk === "high" && response) {
    critic = await critiqueDraftReply({ ctx, analysis: ctx.thinking as any, draft: response }).catch(() => null);
    if (critic && !(critic as any).ok) {
      const issues = Array.isArray((critic as any).issues) ? (critic as any).issues.join(", ") : "";
      const fixHint = String((critic as any).fix_hint || "");
      const regenerated = await buildAgent(
        ctx,
        calls,
        `CRITIC_NOTE (internal): issues=${issues}; fix=${fixHint}. Rewrite once without changing verified facts.`
      ).generateText(ctx.text, options);
      result = regenerated;
      tools = extractToolCalls(regenerated);
      validation = validateFinalText(regenerated.text, ctx, { toolsCalled: tools.map((call) => call.name) });
      response = validation.text;
    }
  }

  const allCalls = calls.length ? calls : tools;
  return {
    id: scenario.id,
    category: scenario.category,
    language: scenario.language,
    message: scenario.message,
    response,
    toolCalls: allCalls,
    failures: scoreScenario(scenario, response, allCalls),
    latencyMs: Date.now() - startedAt,
    usage: result.usage || null,
    thinking: ctx.thinking,
    critic,
  };
}

async function main() {
  if (!String(process.env.OPENROUTER_API_KEY || "").trim()
    && (!String(process.env.OPENAI_API_KEY || "").trim()
      || !String(process.env.OPENAI_BASE_URL || "").trim())) {
    throw new Error("A real-model API key is required for the agent eval");
  }
  const filter = String(process.env.EVAL_FILTER || "").trim();
  const max = Math.max(0, Number(process.env.EVAL_MAX || 0) || 0);
  const concurrency = Math.max(1, Math.min(4, Number(process.env.EVAL_CONCURRENCY || 2) || 2));
  let scenarios = filter
    ? AGENT_EVAL_SCENARIOS.filter((scenario) => `${scenario.id} ${scenario.category}`.includes(filter))
    : AGENT_EVAL_SCENARIOS;
  if (max > 0) scenarios = scenarios.slice(0, max);

  const results: EvalResult[] = new Array(scenarios.length);
  let cursor = 0;
  async function worker() {
    while (true) {
      const index = cursor++;
      if (index >= scenarios.length) return;
      const scenario = scenarios[index];
      try {
        results[index] = await runScenario(scenario);
      } catch (error: any) {
        results[index] = {
          id: scenario.id,
          category: scenario.category,
          language: scenario.language,
          message: scenario.message,
          response: "",
          toolCalls: [],
          failures: [`harness_error:${error?.message || error}`],
          latencyMs: 0,
          usage: null,
          thinking: null,
          critic: null,
        };
      }
      const current = results[index];
      console.log(`${current.failures.length ? "FAIL" : "PASS"} ${index + 1}/${scenarios.length} ${current.id} ${current.failures.join(",")}`);
    }
  }

  await Promise.all(Array.from({ length: concurrency }, () => worker()));
  const failures = results.filter((result) => result.failures.length);
  const categoryScores = Object.fromEntries([...new Set(results.map((result) => result.category))].map((category) => {
    const group = results.filter((result) => result.category === category);
    return [category, { passed: group.filter((result) => !result.failures.length).length, total: group.length }];
  }));
  const report = {
    generatedAt: new Date().toISOString(),
    model: process.env.TEXT_PRIMARY_MODEL || "google/gemini-2.5-flash",
    total: results.length,
    passed: results.length - failures.length,
    failed: failures.length,
    passRate: results.length ? (results.length - failures.length) / results.length : 0,
    categoryScores,
    failures,
    results,
  };
  const outputPath = process.env.EVAL_OUTPUT || path.join(os.tmpdir(), "openbot-agent-eval.json");
  await writeFile(outputPath, JSON.stringify(report, null, 2), "utf8");
  console.log(JSON.stringify({ ...report, failures: failures.map(({ id, category, failures: reasons }) => ({ id, category, reasons })), results: undefined }, null, 2));
  console.log(`EVAL_OUTPUT=${outputPath}`);

  const minimum = Number(process.env.EVAL_MIN_PASS_RATE || 0);
  if (minimum > 0 && report.passRate < minimum) process.exitCode = 1;
}

await main();
