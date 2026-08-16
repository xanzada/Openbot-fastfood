import { appendFile, writeFile } from "node:fs/promises";
import { runFastFoodAgent } from "../src/agent/fastfoodAgent.js";
import { preloadContext } from "../src/context/preloadContext.js";

const SCENARIOS = [
  // Greetings & identity
  { id: 1, text: "Сәлем", expect: "greet_natural" },
  { id: 2, text: "Сен кімсің?", expect: "identify_honest" },
  { id: 3, text: "Привет, как дела?", expect: "greet_natural" },
  // Menu lookups
  { id: 4, text: "Пепперони пиццасы бар ма?", expect: "search_menu" },
  { id: 5, text: "Сколько стоит Маргарита?", expect: "search_menu" },
  { id: 6, text: "Какие есть салаты?", expect: "search_menu" },
  { id: 7, text: "Вегетариандық тағам бар ма?", expect: "search_menu" },
  // Menu link requests
  { id: 8, text: "Мәзір сілтемесін жіберші", expect: "send_menu_link" },
  { id: 9, text: "Хочу заказать, дай меню", expect: "send_menu_link" },
  { id: 10, text: "Покажи каталог", expect: "send_menu_link" },
  // Order status
  { id: 11, text: "Тапсырысым қайда?", expect: "check_order_status" },
  { id: 12, text: "Заказ №456 где?", expect: "check_order_status" },
  { id: 13, text: "Когда привезут?", expect: "check_order_or_context" },
  // Payment
  { id: 14, text: "Kaspi-ге қалай төлеймін?", expect: "payment_details" },
  { id: 15, text: "Можно наличными или оплатить при получении?", expect: "online_prepayment_only" },
  // Business info
  { id: 16, text: "Мекенжайыңыз қандай?", expect: "business_info" },
  { id: 17, text: "До скольки работаете?", expect: "business_info" },
  { id: 18, text: "Телефон номер бар ма?", expect: "business_info" },
  // Multi-intent
  { id: 19, text: "Пепперони қанша және Kaspi-ге қалай төлеймін?", expect: "search_menu+payment" },
  { id: 20, text: "Адрес и время работы", expect: "business_info" },
  // Conversational
  { id: 21, text: "Рахмет!", expect: "acknowledge_natural" },
  { id: 22, text: "Бәрі дұрыс, кейін жазамын", expect: "acknowledge_natural" },
  { id: 23, text: "Не то хочу", expect: "clarify_natural" },
  // Complaints (escalation)
  { id: 24, text: "Заказ опоздал на час", expect: "escalate_admin" },
  { id: 25, text: "Тапсырыста дұрыс емес тағам келді", expect: "escalate_admin" },
  // Edge cases
  { id: 26, text: "Что такое налог?", expect: "out_of_scope_gentle" },
  { id: 27, text: "Можно ли заказать завтра?", expect: "answer_natural" },
  { id: 28, text: "Есть акции?", expect: "answer_or_search" },
  { id: 29, text: "Пепперони", expect: "search_menu_short" },
  { id: 30, text: "yes", expect: "context_aware" },
];

const instanceId = String(process.env.SMOKE_INSTANCE_ID || "").trim();
if (!instanceId) throw new Error("SMOKE_INSTANCE_ID_REQUIRED");
const scenarioId = process.argv[2] ? parseInt(process.argv[2], 10) : null;
const customText = scenarioId ? null : process.argv.slice(2).join(" ").trim();
const watchdogMs = Number(process.env.SMOKE_TIMEOUT_MS || 75_000);
const jsonlPath = String(process.env.SMOKE_JSONL_PATH || "").trim();

if (customText) {
  await runSingleScenario({ id: 0, text: customText, expect: "custom" });
  process.exit(0);
} else if (scenarioId !== null) {
  const scenario = SCENARIOS.find(s => s.id === scenarioId);
  if (!scenario) {
    console.error(JSON.stringify({ error: "SCENARIO_NOT_FOUND", scenarioId }));
    process.exit(1);
  }
  await runSingleScenario(scenario);
  process.exit(0);
} else {
  console.log(`Running ${SCENARIOS.length} smoke scenarios...`);
  if (jsonlPath) await writeFile(jsonlPath, "", "utf8");
  let passed = 0;
  let failed = 0;
  for (const scenario of SCENARIOS) {
    try {
      await runSingleScenario(scenario, false);
      passed++;
    } catch (error: any) {
      failed++;
      console.error(`[SCENARIO ${scenario.id}] FAILED: ${error?.message || error}`);
    }
  }
  console.log("\n=== SMOKE SUMMARY ===");
  console.log(`Passed: ${passed}/${SCENARIOS.length}`);
  console.log(`Failed: ${failed}/${SCENARIOS.length}`);
  process.exit(failed > 0 ? 1 : 0);
}

async function runSingleScenario(scenario: { id: number; text: string; expect: string }, logJson = true) {
  const watchdog = setTimeout(() => {
    console.error(JSON.stringify({ scenarioId: scenario.id, error: "SMOKE_TIMEOUT", elapsedMs: watchdogMs }));
    process.exit(124);
  }, watchdogMs);

  // Use the real production context loader instead of a synthetic shell. This
  // exercises runtime status, language detection, tenant config, order state,
  // memory and secure menu-link generation exactly as the webhook does.
  const runNonce = Date.now().toString().slice(-4);
  const phone = `77009${runNonce}${String(Math.max(0, scenario.id)).padStart(2, "0").slice(-2)}`;
  const ctx = await preloadContext({
    instanceId,
    phone,
    text: scenario.text,
    languageCandidateText: scenario.text,
    senderMeta: { name: "Smoke Test" },
  });

  const startedAt = Date.now();
  const result = await runFastFoodAgent(ctx);
  clearTimeout(watchdog);

  const output = {
    scenarioId: scenario.id,
    expect: scenario.expect,
    input: scenario.text,
    elapsedMs: Date.now() - startedAt,
    reply: result.text,
    rawReply: result.rawText,
    finishReason: result.finishReason,
    toolPlan: result.toolPlan.requiredTools,
    toolCalls: result.toolCalls.map((c: any) => c.name),
    validationWarnings: result.validationWarnings,
  };

  if (jsonlPath) await appendFile(jsonlPath, `${JSON.stringify(output)}\n`, "utf8");
  if (logJson) console.log(JSON.stringify(output, null, 2));
  else console.log(`[${scenario.id}] ${scenario.text.slice(0, 40)}... => ${result.text.slice(0, 60)}...`);
  return output;
}
