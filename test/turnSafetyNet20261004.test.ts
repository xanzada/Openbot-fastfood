import assert from "node:assert/strict";
import test from "node:test";

// Owner rules 2026-10-04: a guest is never left without an answer, and a dish without
// catalog ingredients is never described from general knowledge.

test("a lane refusal (security-check 400, 429, 500, empty 200) fails over to the next lane at once", async (t) => {
  process.env.TENANTS_PLATFORM_BASE_URL = "http://whatspro.test";
  process.env.TENANTS_PLATFORM_API_TOKEN = "test-token";
  const ok = () => new Response(JSON.stringify({
    id: "c1", object: "chat.completion", created: 1, model: "m",
    choices: [{ index: 0, finish_reason: "stop", message: { role: "assistant", content: "Донер 1590 ₸." } }],
    usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
  }), { status: 200, headers: { "content-type": "application/json" } });
  const empty = () => new Response(JSON.stringify({
    id: "c2", object: "chat.completion", created: 1, model: "m",
    choices: [{ index: 0, finish_reason: "content_filter", message: { role: "assistant", content: "" } }],
    usage: { prompt_tokens: 1, completion_tokens: 0, total_tokens: 1 },
  }), { status: 200, headers: { "content-type": "application/json" } });
  const refusals: Record<string, () => Response> = {
    security400: () => new Response(JSON.stringify({ error: { message: "请求内容未通过安全检查。", type: "invalid_request_error" } }), { status: 400, headers: { "content-type": "application/json" } }),
    rate429: () => new Response(JSON.stringify({ error: { message: "rate limited" } }), { status: 429, headers: { "content-type": "application/json" } }),
    server500: () => new Response(JSON.stringify({ error: { message: "upstream" } }), { status: 500, headers: { "content-type": "application/json" } }),
    empty200: empty,
  };
  let firstLane: () => Response = ok;
  const calls: string[] = [];
  t.mock.method(globalThis, "fetch", async (input: any) => {
    const url = String(input?.url || input);
    if (url.endsWith("/api/wa/llm-workspace")) {
      return new Response(JSON.stringify({ workspace: { text: [
        { name: "first", type: "openai", baseUrl: "https://first.test/v1", model: "m-first", key: "k1" },
        { name: "second", type: "openai", baseUrl: "https://second.test/v1", model: "m-second", key: "k2" },
      ] } }), { status: 200, headers: { "content-type": "application/json" } });
    }
    if (url.startsWith("https://first.test")) { calls.push("first"); return firstLane(); }
    if (url.startsWith("https://second.test")) { calls.push("second"); return ok(); }
    return new Response("{}", { status: 404 });
  });
  const workspace = await import("../src/services/llmWorkspace.service.js");
  const { resolveModel, clearModelCooldowns } = await import("../src/agent/modelRouter.js");
  const { clearProviderHealthForTests } = await import("../src/services/llmProviderHealth.service.js");
  workspace.startLlmWorkspacePolling();
  for (let i = 0; i < 50 && !workspace.getLlmWorkspacePools(); i += 1) await new Promise((r) => setTimeout(r, 10));
  t.after(() => { workspace.stopLlmWorkspacePolling(); clearModelCooldowns(); clearProviderHealthForTests(); });

  const call = { prompt: [{ role: "user", content: [{ type: "text", text: "где мой заказ?? 55 минут уже жду" }] }] };
  for (const [name, refusal] of Object.entries(refusals)) {
    clearModelCooldowns();
    clearProviderHealthForTests();
    calls.length = 0;
    firstLane = refusal;
    const startedAt = Date.now();
    const result = await resolveModel({} as any).doGenerate(call);
    assert.deepEqual(calls, ["first", "second"], name);
    assert.ok(result.content.some((part: any) => part.type === "text" && part.text.includes("1590")), name);
    assert.ok(Date.now() - startedAt < 2_000, `${name} must not wait for a timeout`);
  }
});

const routed: any[] = [];
const route = (action: string) => (async (_ctx: any, input: any) => { routed.push(input); return { action } as any; }) as any;
const ctx = (text: string, language: "kk" | "ru", items: any[] = []) => ({ text, language, instanceId: "t", phone: "77000000000", menuSnapshot: { items } }) as any;

test("when every lane failed the guest gets a holding line and the operator gets an SOS", async () => {
  const { answerAgentFailure } = await import("../src/services/turnSafetyNet.service.js");
  routed.length = 0;
  const kk = await answerAgentFailure(ctx("Тапсырысым қайда?", "kk"), new Error("TEXT_MODEL_TIMEOUT:m:40000ms"), route("operator_case_created"));
  assert.match(kk, /^Кешіріңіз, қазір ақпаратты нақтылап жатырмыз\./);
  assert.match(kk, /Оператор/);
  assert.equal(routed[0].source, "ai_unavailable");
  assert.equal(routed[0].urgency, "high");
  assert.match(routed[0].summary, /TEXT_MODEL_TIMEOUT/);
  const ru = await answerAgentFailure(ctx("где мой заказ", "ru"), new Error("400"), route("escalation_failed"));
  assert.match(ru, /^Извините, уточняем информацию\./);
  assert.doesNotMatch(ru, /Оператор/, "no operator promise when the SOS could not be raised");
  const thrown = await answerAgentFailure(ctx("где мой заказ", "ru"), new Error("x"), (async () => { throw new Error("redis down"); }) as any);
  assert.match(thrown, /^Извините, уточняем информацию\./, "a failing SOS path still answers");
});

test("composition checks and planned real incidents bypass the menu guard, but ai outages do not", async () => {
  const source = await (await import("node:fs/promises")).readFile(new URL("../src/services/complaintRouting.service.ts", import.meta.url), "utf8");
  const skip = source.slice(source.indexOf("const menuSkipApplies"), source.indexOf("if (menuSkipApplies"));
  assert.doesNotMatch(skip, /input\.source !== "ai_unavailable"/);
  assert.match(skip, /input\.source !== "composition_check"/);
  assert.doesNotMatch(skip, /ai_tool_escalate_to_admin/);
});

test("a composition question about dishes without catalog ingredients gets only the kitchen line, with an SOS", async () => {
  const { needsKitchenCompositionCheck, answerCompositionQuestion } = await import("../src/services/turnSafetyNet.service.js");
  const blank = [{ name: "Пончик Шоколадный", composition: "" }, { name: "Донер Куриный Стандарт", composition: "" }];
  const mixed = [{ name: "Пончик Шоколадный", composition: "" }, { name: "Донер Куриный Стандарт", composition: "лаваш, курица" }];
  assert.equal(needsKitchenCompositionCheck(ctx("а шоколадный пончик в составе есть орехи?", "ru", blank)), true);
  assert.equal(needsKitchenCompositionCheck(ctx("Балама жаңғаққа аллергия бар, не жесе болады?", "kk", blank)), true);
  assert.equal(needsKitchenCompositionCheck(ctx("Пончиктің құрамында не бар?", "kk", mixed)), true, "the named dish has none");
  assert.equal(needsKitchenCompositionCheck(ctx("Донердің құрамы қандай?", "kk", mixed)), false, "the named dish has ingredients");
  assert.equal(needsKitchenCompositionCheck(ctx("помогите составить заказ", "ru", blank)), false);
  assert.equal(needsKitchenCompositionCheck(ctx("донер канша турады", "kk", blank)), false);
  assert.equal(needsKitchenCompositionCheck(ctx("состав?", "ru", [{ name: "Пицца" }])), false, "a snapshot that says nothing changes nothing");
  routed.length = 0;
  assert.equal(await answerCompositionQuestion(ctx("орехи есть?", "ru", blank), route("operator_case_created")), "Уточняю точный состав на кухне.");
  assert.equal(await answerCompositionQuestion(ctx("жаңғақ бар ма?", "kk", blank), route("operator_case_created")), "Құрамын дәл қазір асүйден нақтылап беремін.");
  assert.equal(routed[0].source, "composition_check");
  const noSos = await answerCompositionQuestion(ctx("орехи есть?", "ru", blank), route("escalation_failed"));
  assert.doesNotMatch(noSos, /кухн/, "no kitchen promise without a person behind it");
});

test("the agent's own high-urgency call on an angry turn raises SOS without the clarify round", async () => {
  const source = await (await import("node:fs/promises")).readFile(new URL("../src/services/complaintRouting.service.ts", import.meta.url), "utf8");
  assert.match(source, /agentSeesConflict = input\.urgency === "high"/);
  assert.match(source, /!agentSeesConflict\) \{/);
  const { createEscalateToAdminSkill } = await import("../src/skills/escalation.skill.js");
  assert.match(String((createEscalateToAdminSkill({} as any) as any).description), /urgency high so a person joins/);
});
