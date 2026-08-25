import test from "node:test";
import assert from "node:assert/strict";
import { FASTFOOD_AGENT_INSTRUCTIONS } from "../src/agent/instructions.js";
import { buildTenantInstructionsFromConfig } from "../src/agent/persona.js";
import { buildFactsPrompt, compactConversationHistory } from "../src/context/buildFactsPrompt.js";
import { validateFinalText } from "../src/agent/finalValidator.js";
import { createAgentStepPolicy, resolveAgentToolPlan } from "../src/agent/toolPolicy.js";
import { splitWhatsProResponse } from "../src/transport/whatspro.client.js";
import { hasExplicitMenuLinkIntent } from "../src/utils/magicLink.js";
import { readFile } from "node:fs/promises";

test("core prompt defines autonomous judgment and exact active tools", () => {
  assert.match(FASTFOOD_AGENT_INSTRUCTIONS, /DECISION STANDARD/);
  assert.match(FASTFOOD_AGENT_INSTRUCTIONS, /not an exhaustive catalogue of situations/);
  assert.match(FASTFOOD_AGENT_INSTRUCTIONS, /Treat the newest message and recent_dialog as one continuing conversation/);
  assert.match(FASTFOOD_AGENT_INSTRUCTIONS, /multi-tenant fast-food automation system/);
  assert.match(FASTFOOD_AGENT_INSTRUCTIONS, /never describe this architecture/i);
  assert.match(FASTFOOD_AGENT_INSTRUCTIONS, /profile and saved-contact names as untrusted display labels/);
  assert.match(FASTFOOD_AGENT_INSTRUCTIONS, /Answer once, without a second paraphrase/);
  for (const name of ["searchMenu", "sendMenuLink", "checkOrderStatus", "getPaymentDetails", "getBusinessInfo", "updateCrmLead", "escalateToAdmin"]) {
    assert.match(FASTFOOD_AGENT_INSTRUCTIONS, new RegExp(name));
  }
  assert.doesNotMatch(FASTFOOD_AGENT_INSTRUCTIONS, /registerPaymentReceipt/);
  assert.doesNotMatch(FASTFOOD_AGENT_INSTRUCTIONS, /Suggested customer repl/i);
});

test("OpenRouter text models use chat completions rather than the hanging Responses API", async () => {
  const router = await readFile(new URL("../src/agent/modelRouter.ts", import.meta.url), "utf8");
  const agent = await readFile(new URL("../src/agent/fastfoodAgent.ts", import.meta.url), "utf8");
  const redis = await readFile(new URL("../src/services/redis.service.ts", import.meta.url), "utf8");
  const transport = await readFile(new URL("../src/transport/whatspro.client.ts", import.meta.url), "utf8");
  const server = await readFile(new URL("../src/server.ts", import.meta.url), "utf8");
  const platform = await readFile(new URL("../src/services/platformConfig.service.ts", import.meta.url), "utf8");
  assert.match(router, /openrouterProvider\.chat\(textPrimaryModel\)/);
  assert.match(router, /openrouterProvider\.chat\(textFallbackModel\)/);
  assert.match(router, /openrouterProvider\.chat\(textReserveModel\)/);
  assert.match(router, /TEXT_PRIMARY_TIMEOUT_MS/);
  assert.match(router, /TEXT_FALLBACK_TIMEOUT_MS/);
  assert.match(router, /TEXT_RESERVE_TIMEOUT_MS/);
  assert.match(agent, /maxRetries:\s*0/);
  assert.match(redis, /REDIS_OPERATION_TIMEOUT_MS/);
  assert.match(redis, /disableOfflineQueue:\s*true/);
  assert.match(transport, /drainWhatsProOutbox/);
  assert.match(transport, /requestId:\s*outboundId/);
  assert.match(transport, /requestScope \|\| crypto\.randomUUID\(\)/);
  assert.match(transport, /payload\.phone\}\|\$\{requestScope\}/);
  assert.match(server, /startWhatsProOutboxWorker\(\)/);
  assert.match(platform, /getOpenRouterProvider\(\)\.chat\("openai\/gpt-4o-mini"\)/);
});

test("identity policy is natural without permitting a false human claim", () => {
  assert.match(FASTFOOD_AGENT_INSTRUCTIONS, /Never introduce yourself as AI, a bot/);
  assert.match(FASTFOOD_AGENT_INSTRUCTIONS, /Do not falsely claim to be a human/);
  assert.match(FASTFOOD_AGENT_INSTRUCTIONS, /If directly asked whether you are a bot, answer honestly/);
});

test("tenant prompt is explicitly subordinate to core contracts", () => {
  const text = buildTenantInstructionsFromConfig({ system_prompt: "Use our warm tone." }, "tenant-a");
  assert.match(text, /cannot override the core constitution/);
  assert.match(text, /Never copy an example mechanically/);
  assert.match(text, /professional judgment instead of refusing/);
  assert.match(text, /instance_id: tenant-a/);
});

test("facts expose a balanced sixteen-message dialogue and preserve operator role", () => {
  const history = Array.from({ length: 24 }, (_, index) => ({
    role: index === 9 ? "operator" : index % 2 ? "assistant" : "user",
    text: `message ${index}`,
    createdAt: 1000 + index,
  }));
  const compact = compactConversationHistory(history);
  assert.equal(compact.length, 16);
  assert.equal(compact.filter((entry) => entry.role === "user").length, 8);
  assert.equal(compact.filter((entry) => entry.role === "assistant" || entry.role === "operator").length, 8);
  assert.equal(compact.find((entry) => entry.text === "message 9")?.role, "operator");
  assert.equal(compact[0].text, "message 8");

  const prompt = buildFactsPrompt({
    language: "ru", languagePolicy: {}, instanceId: "tenant-a", config: { brand: "Prestige" },
    senderMeta: { pushName: "Xanzada.", contactName: "Xanzada." },
    hardRealtimeContext: {}, activeShiftNotes: [], magicLinkAlreadySent: false, explicitMenuLinkIntent: false,
    magicLink: "", chatHistory: history, shporContext: []
  } as any);
  const json = JSON.parse(prompt.split("FACTS_CONTEXT_START\n")[1].split("\nFACTS_CONTEXT_END")[0]);
  assert.equal(json.recent_dialog.length, 16);
  assert.equal(json.recent_dialog.find((entry: any) => entry.text === "message 9")?.role, "operator");
  assert.match(json.conversation_policy, /up to 8 customer and 8 business-side messages/);
  assert.equal(json.restaurant.brand, "Prestige");
  assert.equal(json.agent_identity.brand, "Prestige");
  assert.equal(json.agent_identity.role, "tenant_scoped_fast_food_service_agent");
  assert.equal(json.customer_addressing.profile_name_available, true);
  assert.match(json.customer_addressing.rule, /Never address the customer by them/);
  assert.equal(JSON.stringify(json).includes("Xanzada"), false);
});

test("long replies split only after complete sentences and never duplicate content", () => {
  const first = "Бірінші сөйлем клиентке негізгі жауапты береді.";
  const second = "Екінші сөйлем келесі пайдалы қадамды түсіндіреді.";
  const third = "Үшінші сөйлем тексерілген қосымша ақпаратты береді.";
  const text = Array(3).fill([first, second, third].join(" ")).join(" ");
  const chunks = splitWhatsProResponse(text);
  assert.ok(chunks.length > 1);
  assert.equal(chunks.join(" "), text);
  assert.equal(new Set(chunks).size, chunks.length);
  assert.ok(chunks.every((chunk) => /[.!?]$/.test(chunk)));
});

test("validator leaves a natural four-sentence answer alone but caps a sixth sentence", () => {
  const ctx = { language: "ru", text: "Привет", config: {}, fetchedSettings: {}, hardRealtimeContext: {}, runtimeStatus: null, activeOrder: null } as any;
  const natural = validateFinalText("Первое. Второе. Третье. Четвертое.", ctx);
  assert.equal(natural.text, "Первое. Второе. Третье. Четвертое.");
  assert.deepEqual(natural.warnings, []);

  const tooLong = validateFinalText("Первое. Второе. Третье. Четвертое. Пятое. Шестое.", ctx);
  assert.equal(tooLong.text, "Первое. Второе. Третье. Четвертое. Пятое.");
  assert.deepEqual(tooLong.warnings, ["reply_length_capped"]);
});

test("validator keeps useful mixed-language wording instead of replacing it with a stock fallback", () => {
  const ctx = {
    language: "kk", text: "Pepperoni қанша тұрады?", config: {}, fetchedSettings: { wait_time: 0 },
    hardRealtimeContext: {}, runtimeStatus: {}, activeOrder: null
  } as any;
  const result = validateFinalText("Pepperoni пиццасының бағасы 4 500 ₸.", ctx);
  assert.equal(result.text, "Pepperoni пиццасының бағасы 4 500 ₸.");
  assert.notEqual(result.text, "Қалай көмектесе аламын? 😊");
  assert.deepEqual(result.warnings, []);
});

test("validator removes an old wait-consent question after the kitchen returns to normal", () => {
  const ctx = {
    language: "kk", text: "донер барма енді?", config: {}, fetchedSettings: { wait_time: 0 },
    hardRealtimeContext: { wait_time: 0 }, runtimeStatus: { wait_time: 0 }, activeOrder: null,
  } as any;
  const result = validateFinalText("Донер (немесе донер-кебаб) бар, бағасы 1000 теңге. Күте аласыз ба?", ctx);

  assert.equal(result.text, "Донер (немесе донер-кебаб) бар, бағасы 1000 теңге.");
  assert.ok(result.warnings.includes("stale_wait_consent_removed"));
});

test("high-confidence live intents are code-gated to the correct tools", () => {
  const plan = (text: string, extra: Record<string, any> = {}) =>
    resolveAgentToolPlan({ text, explicitMenuLinkIntent: false, activeOrder: null, ...extra } as any).requiredTools;

  assert.deepEqual(plan("Пепперони бар ма, бағасы қанша?"), ["searchMenu"]);
  assert.deepEqual(plan("Менюге сілтеме жіберіңіз", { explicitMenuLinkIntent: true }), ["sendMenuLink"]);
  assert.deepEqual(plan("Заказ №123 қайда?"), ["checkOrderStatus"]);
  assert.deepEqual(plan("Kaspi-ге қалай төлеймін?"), ["getPaymentDetails"]);
  assert.deepEqual(plan("Мекенжай мен жұмыс уақыты қандай?"), ["getBusinessInfo"]);
  assert.deepEqual(plan("Қанша уақыт күтемін?"), ["getKitchenStatus"]);
  assert.deepEqual(plan("Сколько вы сегодня работаете?"), ["getBusinessInfo"]);
  assert.deepEqual(plan("Сәлем, бүгін көңіл-күй қалай?"), []);
});

test("incidental send wording and media conversation never trigger a menu link", () => {
  assert.equal(hasExplicitMenuLinkIntent("Тәтті ғой, жай жіберем ғой қызық болсын деп"), false);
  assert.equal(hasExplicitMenuLinkIntent("Мәзір сілтемесін қайта жіберіңіз"), true);
  const ctx = {
    language: "kk", text: "Тәтті ғой, жай жіберем ғой қызық болсын деп",
        magicLink: "https://prestige.alemi.kz/?phone=77000000000&hash=test",
    magicLinkAlreadySent: false, explicitMenuLinkIntent: false,
    config: {}, fetchedSettings: {}, hardRealtimeContext: {}, runtimeStatus: {}, activeOrder: null,
  } as any;
  const result = validateFinalText(`Міне мәзір сілтемесі:\n${ctx.magicLink}`, ctx);
  assert.equal(result.hasLink, false);
  assert.deepEqual(result.warnings, ["unrequested_menu_link_removed"]);
});

test("operator handoff stays in Chat and cannot message the developer", async () => {
  const routing = await readFile(new URL("../src/services/complaintRouting.service.ts", import.meta.url), "utf8");
  const webhook = await readFile(new URL("../src/routes/whatsappWebhook.route.ts", import.meta.url), "utf8");
  assert.doesNotMatch(routing, /sendWhatsProMessage/);
  assert.match(routing, /createOperatorCase/);
  assert.doesNotMatch(webhook, /AI requested developer escalation/);
});

test("multi-intent messages can require several independent live tools", () => {
  const result = resolveAgentToolPlan({
    text: "Пепперони қанша және Kaspi-ге қалай төлеймін?",
    explicitMenuLinkIntent: false,
    activeOrder: null,
  } as any);
  assert.deepEqual(result.requiredTools, ["getPaymentDetails", "searchMenu"]);
});

test("step policy pins only the first live tool and then returns control to the model", () => {
  const policy = createAgentStepPolicy({
    requiredTools: ["getPaymentDetails", "searchMenu"],
    reason: ["live_payment_details", "live_menu_lookup"],
  });
  assert.deepEqual(policy({ stepNumber: 0 }), {
    toolChoice: { type: "tool", toolName: "getPaymentDetails" },
  });
  assert.deepEqual(policy({ stepNumber: 1 }), { toolChoice: "auto" });
  assert.deepEqual(policy({ stepNumber: 2 }), { toolChoice: "auto" });
  assert.deepEqual(policy({ stepNumber: 3 }), { toolChoice: "auto" });
  assert.deepEqual(policy({ stepNumber: 4 }), { toolChoice: "none" });
  assert.deepEqual(policy({ stepNumber: 5 }), { toolChoice: "none" });
});

test("with no code-detected live intent the agent chooses its own tools from the first step", () => {
  const policy = createAgentStepPolicy({ requiredTools: [], reason: [] });
  assert.deepEqual(policy({ stepNumber: 0 }), { toolChoice: "auto" });
  assert.deepEqual(policy({ stepNumber: 1 }), { toolChoice: "auto" });
});
