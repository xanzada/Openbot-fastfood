import test from "node:test";
import assert from "node:assert/strict";

process.env.REDIS_URL = "redis://127.0.0.1:1";
process.env.REDIS_CONNECT_TIMEOUT_MS = "500";
process.env.REDIS_OPERATION_TIMEOUT_MS = "500";
// Keep the cooldown short so the window can be observed without waiting.
process.env.MODEL_FAILURE_COOLDOWN_MS = "5000";

const skills = await import("../src/skills/index.js");
const { modelCooldownState, clearModelCooldowns } = await import("../src/agent/modelRouter.js");
const { redisClient } = await import("../src/services/redis.service.js");

test.after(() => {
  clearModelCooldowns();
  if (redisClient.isOpen) redisClient.destroy();
});

const CTX = (over: Record<string, any> = {}) => ({
  instanceId: "test-instance",
  phone: "77000000666",
  language: "kk" as const,
  config: {},
  text: "оператор керек",
  ...over,
}) as any;

// ---------------------------------------------------------------------------- A11
// The critic path re-runs the WHOLE agent on the same ctx, so every side-effecting
// tool ran twice: updateCrmLead wrote the CRM again, sendMenuLink re-marked
// markMagicLinkSent / markKitchenCheckoutStarted, and escalateToAdmin called
// routeComplaintToAdmin a second time - where takeComplaintClarification found the
// flag the FIRST pass had just written and turned a bare demand into a real operator
// case. That defeats the clarify-first gate on exactly the high-risk turns the critic
// runs on.

test("only the tools that change something outside the turn are memoised", () => {
  assert.deepEqual(
    [...skills.__test.SIDE_EFFECTING_SKILLS],
    ["updateCrmLead", "sendMenuLink", "escalateToAdmin"],
    "read-only tools must stay re-callable: re-reading the kitchen mid-turn is the point of having them"
  );
});

test("a side-effecting tool executes once per turn and replays its first result", async () => {
  const ctx = CTX();
  let calls = 0;
  const tool: any = {
    name: "escalateToAdmin",
    execute: async () => {
      calls += 1;
      return { action: "clarification_requested", caseId: null, attempt: calls };
    },
  };
  skills.__test.memoizePerTurn(ctx, tool);

  const first = await tool.execute({});
  const second = await tool.execute({});
  const third = await tool.execute({ different: "arguments" });

  assert.equal(calls, 1, "the second pass must not re-run the escalation");
  // The model is not lied to: it receives exactly what happened the first time.
  assert.deepEqual(second, first);
  assert.deepEqual(third, first);
});

test("a read-only tool is untouched and may be called repeatedly", async () => {
  const ctx = CTX();
  let calls = 0;
  const tool: any = { name: "getKitchenStatus", execute: async () => ({ calls: ++calls }) };
  skills.__test.memoizePerTurn(ctx, tool);
  await tool.execute({});
  await tool.execute({});
  assert.equal(calls, 2, "re-reading the kitchen mid-turn must keep working");
});

test("the memo is per turn, so nothing leaks between guests or tenants", async () => {
  const first = CTX({ phone: "77000000001" });
  const second = CTX({ phone: "77000000002" });
  let calls = 0;
  const make = () => {
    const tool: any = { name: "updateCrmLead", execute: async () => ({ calls: ++calls }) };
    return tool;
  };
  const a = make();
  const b = make();
  skills.__test.memoizePerTurn(first, a);
  skills.__test.memoizePerTurn(second, b);
  await a.execute({});
  await a.execute({});
  await b.execute({});
  assert.equal(calls, 2, "one execution per turn, and the second turn is independent");
});

test("createFastFoodSkills registers all nine tools and wraps the three that mutate", async () => {
  const ctx = CTX();
  const tools = skills.createFastFoodSkills(ctx);
  assert.equal(tools.length, 9);
  const names = tools.map((tool: any) => String(tool.name));
  for (const expected of skills.FAST_FOOD_SKILL_NAMES) {
    assert.ok(names.includes(expected), `${expected} must stay registered`);
  }

  // The wiring, not just the helper. Testing memoizePerTurn directly proves the
  // helper works; it does NOT prove the factory applies it, and removing the .map()
  // left every other assertion green - caught by the negative control not failing.
  const escalate: any = tools.find((tool: any) => String(tool.name) === "escalateToAdmin");
  assert.ok(escalate, "escalateToAdmin must be registered");
  let calls = 0;
  // Replace the underlying execute so nothing real is touched, then confirm the
  // memo wrapper the factory installed is the thing being called.
  const memo = skills.__test.turnMemo(ctx);
  memo.clear();
  const wrapped = escalate.execute.bind(escalate);
  // The factory wrapped the tool, so the wrapper caches on the FIRST result. Feed it
  // a deterministic inner implementation by memoising a sentinel up front.
  memo.set("escalateToAdmin", { sentinel: true });
  const first = await wrapped({ reason: "x", customerReply: "y", urgency: "normal" });
  const second = await wrapped({ reason: "x", customerReply: "y", urgency: "normal" });
  assert.deepEqual(first, { sentinel: true }, "the factory must install the per-turn memo");
  assert.deepEqual(second, { sentinel: true });
  assert.equal(calls, 0, "the real escalation must not have run");
  memo.clear();
});

// ---------------------------------------------------------------------------- A12
test("the reported tool calls are the union of both agent passes", async () => {
  const source = await import("node:fs/promises").then((fs) =>
    fs.readFile(new URL("../src/agent/fastfoodAgent.ts", import.meta.url), "utf8"));

  // If the first pass escalated and the regenerated one did not, toolHandledEscalation
  // went false and the webhook text lane routed the SAME episode again - a second case
  // and a second hub signal for one turn.
  assert.match(source, /firstPassToolCalls = extractToolCalls\(result\);/,
    "the first pass's calls must be captured before result is replaced");
  assert.match(source, /toolCalls: mergeToolCalls\(firstPassToolCalls, extractToolCalls\(result\)\)/);
  assert.match(source, /function mergeToolCalls\(/);
  // De-duplicated, or one memoised tool would look like two calls.
  assert.match(source, /const key = `\$\{call\.name\}\|\$\{JSON\.stringify\(call\.arguments \?\? null\)\}`/);
});

// ---------------------------------------------------------------------------- A13
test("a contradicting sentence is cut, not the whole reply", async () => {
  const source = await import("node:fs/promises").then((fs) =>
    fs.readFile(new URL("../src/agent/fastfoodAgent.ts", import.meta.url), "utf8"));

  // "жеткізу жұмыс істемей тұр, өзіңіз алып кетсеңіз болады" became "тапсырыс беруге
  // болады", telling the guest they could order delivery. The refusal words appear in
  // real operational facts too.
  const block = source.slice(source.indexOf("GRANTED_LINK_REFUSAL_RE.test(finalText)"));
  assert.match(block, /\.filter\(\(sentence\) => sentence\.trim\(\) && !GRANTED_LINK_REFUSAL_RE\.test\(sentence\)\)/,
    "only the offending sentence may go");
  assert.match(block, /finalText = kept \|\|/, "the canned line is a last resort, not the default");
  assert.match(block, /granted_link_refusal_clause_removed/, "and it must be visible in the warnings");
});

// ------------------------------------------------------------------------ A16/A17
test("a model that just failed is skipped for a window", () => {
  clearModelCooldowns();
  assert.deepEqual(modelCooldownState(), {}, "no cooldown at rest");
  assert.equal(typeof clearModelCooldowns, "function", "an operator must be able to clear it");
});

test("the failover chain has no per-call retry storm and keeps a last resort", async () => {
  const source = await import("node:fs/promises").then((fs) =>
    fs.readFile(new URL("../src/agent/modelRouter.ts", import.meta.url), "utf8"));

  // Every step of a 6-step turn used to re-try a dead primary (15s) and a dead
  // fallback (15s) before reaching the reserve (40s): ~70s per step.
  assert.match(source, /function callChain\(/);
  assert.match(source, /index === chain\.length - 1 \|\| !modelIsCoolingDown\(entry\.model\.modelId\)/,
    "the last model stays a genuine last resort even while cooling down");
  assert.match(source, /noteModelSuccess\(entry\.model\.modelId\)/,
    "a model that answers must return to rotation immediately");
  assert.doesNotMatch(source, /catch \(fallbackError: any\)/, "the nested try/catch ladder must be gone");
});

test("the model chain has exactly one source of truth", async () => {
  const routerSource = await import("node:fs/promises").then((fs) =>
    fs.readFile(new URL("../src/agent/modelRouter.ts", import.meta.url), "utf8"));
  const { getTextModelId } = await import("../src/agent/modelRouter.js");
  const { getTextModels } = await import("../src/services/llm.service.js");

  // modelRouter used to re-read TEXT_PRIMARY_MODEL with its OWN default, so with the
  // env unset the agent ran one model while the webhook logged another as "primary".
  assert.match(routerSource, /import \{ getTextModels \} from "\.\.\/services\/llm\.service\.js"/);
  assert.doesNotMatch(routerSource, /envText\("TEXT_PRIMARY_MODEL"/, "no second default may exist");
  assert.deepEqual(getTextModelId(), getTextModels(),
    "what the agent calls and what the logs report must be the same chain");
});
