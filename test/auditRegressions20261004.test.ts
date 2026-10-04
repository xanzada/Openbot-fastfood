import assert from "node:assert/strict";
import test from "node:test";

// Audit 2026-10-04. Each case below was reproduced against production first.

test("«Сәлеметсіз бе» is a greeting, not a menu lookup; «етсіз» as a word still is", async () => {
  const { resolveAgentToolPlan } = await import("../src/agent/toolPolicy.js");
  const runtime = { is_accepting_orders: true, within_work_hours: true, runtime_available: true, wait_time: 0, delivery: true, pickup: true };
  const plan = (text: string) => resolveAgentToolPlan({
    text, runtimeStatus: runtime, hardRealtimeContext: runtime, activeShiftNotes: [], activeOrder: null, explicitMenuLinkIntent: false,
  } as any).requiredTools;
  assert.deepEqual(plan("Сәлеметсіз бе"), []);
  assert.deepEqual(plan("Салеметсизбе"), []);
  assert.ok(plan("етсіз тағам бар ма?").includes("searchMenu"));
  assert.ok(plan("Етсіз не бар").includes("searchMenu"));
});

test("a lane that ignores a pinned tool falls through to the next lane; the last lane still answers", async (t) => {
  process.env.TENANTS_PLATFORM_BASE_URL = "http://whatspro.test";
  process.env.TENANTS_PLATFORM_API_TOKEN = "test-token";
  let toolsLaneBlind = false;
  const calls: string[] = [];
  const completion = (withTool: boolean) => new Response(JSON.stringify({
    id: "c1", object: "chat.completion", created: 1, model: "m",
    choices: [{ index: 0, finish_reason: withTool ? "tool_calls" : "stop", message: withTool
      ? { role: "assistant", content: null, tool_calls: [{ id: "call_1", type: "function", function: { name: "searchMenu", arguments: "{}" } }] }
      : { role: "assistant", content: "Донер 1200 теңге." } }],
    usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
  }), { status: 200, headers: { "content-type": "application/json" } });
  t.mock.method(globalThis, "fetch", async (input: any) => {
    const url = String(input?.url || input);
    if (url.endsWith("/api/wa/llm-workspace")) {
      return new Response(JSON.stringify({ workspace: { text: [
        { name: "blind", type: "openai", baseUrl: "https://blind.test/v1", model: "m-blind", key: "k1" },
        { name: "tools", type: "openai", baseUrl: "https://tools.test/v1", model: "m-tools", key: "k2" },
      ] } }), { status: 200, headers: { "content-type": "application/json" } });
    }
    if (url.startsWith("https://blind.test")) { calls.push("blind"); return completion(false); }
    if (url.startsWith("https://tools.test")) { calls.push("tools"); return completion(!toolsLaneBlind); }
    return new Response("{}", { status: 404 });
  });
  const workspace = await import("../src/services/llmWorkspace.service.js");
  const { resolveModel, clearModelCooldowns } = await import("../src/agent/modelRouter.js");
  workspace.startLlmWorkspacePolling();
  for (let i = 0; i < 50 && !workspace.getLlmWorkspacePools(); i += 1) await new Promise((r) => setTimeout(r, 10));
  t.after(() => { workspace.stopLlmWorkspacePolling(); clearModelCooldowns(); });

  const pinned = {
    prompt: [{ role: "user", content: [{ type: "text", text: "Донер канша турады?" }] }],
    tools: [{ type: "function", name: "searchMenu", description: "menu", inputSchema: { type: "object", properties: {} } }],
    toolChoice: { type: "tool", toolName: "searchMenu" },
  };
  const first = await resolveModel({} as any).doGenerate(pinned);
  assert.deepEqual(calls, ["blind", "tools"]);
  assert.ok(first.content.some((part: any) => part.type === "tool-call"));

  // Every lane blind: the last one is still the honest last resort, never an empty turn.
  toolsLaneBlind = true;
  calls.length = 0;
  const last = await resolveModel({} as any).doGenerate(pinned);
  assert.equal(calls.at(-1), "tools");
  assert.ok(last.content.some((part: any) => part.type === "text"));
});

test("the constitution forbids claiming a written-down order and a raw «0 минут»", async () => {
  const { FASTFOOD_AGENT_INSTRUCTIONS } = await import("../src/agent/instructions.js");
  assert.match(FASTFOOD_AGENT_INSTRUCTIONS, /жазып қойдым/);
  assert.match(FASTFOOD_AGENT_INSTRUCTIONS, /never tell a guest «0 минут»/);
});

const kkCtx = (extra: Record<string, unknown> = {}) => ({
  language: "kk", config: {}, hardRealtimeContext: {}, runtimeStatus: {}, activeShiftNotes: [], chatHistory: [], activeOrder: null, ...extra,
}) as any;

test("a decimal in a dish name is not a sentence end: «0.5л» survives clause surgery and the length cap", async () => {
  const { validateFinalText } = await import("../src/agent/finalValidator.js");
  const list = "Сусындардан Coca-Cola 0.5л — 590 тг, Fanta 0.5л — 590 тг, Fuse tea 0.5л — 590 тг бар. Лимонад Ягодный 0.5л — 1100 тг. Детский сок — 250 тг. Айран 0.33л — 400 тг. Таңдасаңыз, жазыңыз.";
  const capped = validateFinalText(list, kkCtx(), { toolsCalled: ["searchMenu"] } as any);
  assert.equal(capped.text, list);
  assert.ok(!capped.warnings.includes("reply_length_capped"));
  const cut = validateFinalText("Бүгін 20% жеңілдік бар. Coca-Cola 0.5л — 590 тг.", kkCtx(), { toolsCalled: ["searchMenu"] } as any);
  assert.match(cut.text, /Coca-Cola 0\.5л — 590 тг/);
});

test("searchMenu understands Kazakh nouns with suffixes and the Kazakh word for drinks", async () => {
  const { selectPublicMenuItems } = await import("../src/skills/searchMenu.skill.js");
  const menu = [
    { name: "Донер Куриный Стандарт", price: 1690, category_name: "Донер" },
    { name: "Coca-Cola 0.5л", price: 590, category_name: "Напитки" },
    { name: "Детский сок 200мл", price: 250, category_name: "Напитки" },
    { name: "Айран 0.33л", price: 400, category_name: "Напитки" },
    { name: "Бургер Куриный", price: 1990, category_name: "Бургеры" },
  ];
  const names = (query: string) => selectPublicMenuItems(menu, query, "", 10).map((item: any) => item.name);
  assert.ok(names("сусын").includes("Детский сок 200мл"));
  assert.ok(names("балаға сусын").includes("Детский сок 200мл"));
  assert.deepEqual(names("донерлер"), ["Донер Куриный Стандарт"]);
  assert.ok(names("айранды").includes("Айран 0.33л"));
  assert.ok(names("тауық бургер").includes("Бургер Куриный"));
  assert.deepEqual(names("пицца"), []);
});

test("a URL the model typed is removed; the granted personal link is kept", async () => {
  const { validateFinalText } = await import("../src/agent/finalValidator.js");
  const invented = validateFinalText("Пиязсыз екі донер таңдай аласыз.\nhttps://dorumclub.kz/order", kkCtx(), { toolsCalled: [] } as any);
  assert.doesNotMatch(invented.text, /dorumclub\.kz\/order/);
  assert.ok(invented.warnings.includes("invented_url_removed"));
  const magicLink = "https://dorumclub.alemi.kz/?phone=77000000000&hash=abc";
  const granted = validateFinalText(`Міне, жеке сілтемеңіз:\n${magicLink}`, kkCtx({ magicLink, magicLinkGranted: true, explicitMenuLinkIntent: true }), { toolsCalled: ["sendMenuLink"] } as any);
  assert.match(granted.text, /hash=abc/);
});

test("an invitation to order through the granted link is not an order-status claim", async () => {
  const { validateFinalText } = await import("../src/agent/finalValidator.js");
  const ruCtx = (extra: Record<string, unknown>) => ({ ...kkCtx(extra), language: "ru" });
  const magicLink = "https://dorumclub.alemi.kz/?phone=77000000000&hash=abc";
  const invite = validateFinalText("Отлично, ловите персональную ссылку на меню — через нее можно будет быстро собрать заказ и оформить доставку.",
    ruCtx({ magicLink, magicLinkGranted: true, explicitMenuLinkIntent: true }), { toolsCalled: ["sendMenuLink"] } as any);
  assert.notEqual(invite.text, "Сейчас нет активного заказа.");
  assert.match(invite.text, /ссылку/);
  const status = validateFinalText("Ваш заказ уже готовится, курьер скоро выедет.", ruCtx({}), { toolsCalled: [] } as any);
  assert.equal(status.text, "Сейчас нет активного заказа.");
});

test("«жаңғақсыз» is an allergen assurance like «жаңғақ жоқ»", async () => {
  const { validateFinalText } = await import("../src/agent/finalValidator.js");
  const v = validateFinalText("Біздің донерлер мен бургерлер жаңғақсыз дайындалады. Донер Куриный Стандарт — 1690 тг.", kkCtx(), { toolsCalled: [] } as any);
  assert.doesNotMatch(v.text, /жаңғақсыз/);
  assert.ok(v.warnings.includes("ungrounded_allergen_assurance_removed"));
});

test("a menu read grounds an allergen answer only when the catalog has ingredients at all", async () => {
  const { validateFinalText } = await import("../src/agent/finalValidator.js");
  const reply = "Шоколадты пончиктің құрамында жаңғақ жоқ. Пончик Шоколадный — 600 тг.";
  const empty = { items: [{ name: "Пончик Шоколадный", price: 600, composition: "" }] };
  const filled = { items: [{ name: "Пончик Шоколадный", price: 600, composition: "тесто, шоколад" }] };
  const blind = validateFinalText(reply, kkCtx({ menuSnapshot: empty }), { toolsCalled: ["searchMenu"] } as any);
  assert.doesNotMatch(blind.text, /жаңғақ жоқ/);
  const known = validateFinalText(reply, kkCtx({ menuSnapshot: filled }), { toolsCalled: ["searchMenu"] } as any);
  assert.match(known.text, /жаңғақ жоқ/);
});

test("a greeting is answered with a greeting: «Сәлем! 😊» is not a fragment, and the fallback greets", async () => {
  const { validateFinalText, fallbackReply } = await import("../src/agent/finalValidator.js");
  const kk = kkCtx({ text: "Сәлем" });
  const short = validateFinalText("Сәлем! 😊", kk, { toolsCalled: [] } as any);
  assert.equal(short.text, "Сәлем! 😊");
  assert.ok(!short.warnings.includes("truncated_model_output"));
  const broken = validateFinalText("Өкі", kk, { toolsCalled: [] } as any);
  assert.equal(broken.text, "Сәлем! 😊 Осындамын — не көмек керек, жаза беріңіз.");
  assert.equal(fallbackReply({ ...kk, language: "ru", text: "Привет" } as any), "Здравствуйте! 😊 Я на связи — напишите, чем помочь.");
  const midDialog = kkCtx({ text: "иә", chatHistory: [{ role: "user", text: "Сәлем" }, { role: "assistant", text: "Сәлем! 😊" }] });
  assert.equal(fallbackReply(midDialog), "Осындамын — не көмек керек, жаза беріңіз.", "no re-greeting mid-dialog");
  const { readFile } = await import("node:fs/promises");
  const prompt = await readFile(new URL("../src/agent/instructions.ts", import.meta.url), "utf8");
  assert.match(prompt, /Good: «Сәлем! 😊 Осындамын — не көмек керек, жаза беріңіз\.»/);
});
