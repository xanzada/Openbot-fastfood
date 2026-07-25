import test from "node:test";
import assert from "node:assert/strict";
import { FASTFOOD_AGENT_INSTRUCTIONS } from "../src/agent/instructions.js";
import { buildTenantInstructionsFromConfig } from "../src/agent/persona.js";
import { buildFactsPrompt, compactConversationHistory } from "../src/context/buildFactsPrompt.js";
import { validateFinalText } from "../src/agent/finalValidator.js";

test("core prompt uses a silent dialogue loop and exact active tools", () => {
  assert.match(FASTFOOD_AGENT_INSTRUCTIONS, /SILENT DECISION LOOP/);
  assert.match(FASTFOOD_AGENT_INSTRUCTIONS, /recent_dialog as one continuing conversation/);
  for (const name of ["searchMenu", "sendMenuLink", "checkOrderStatus", "getPaymentDetails", "getBusinessInfo", "updateCrmLead", "escalateToAdmin"]) {
    assert.match(FASTFOOD_AGENT_INSTRUCTIONS, new RegExp(name));
  }
  assert.match(FASTFOOD_AGENT_INSTRUCTIONS, /There is no receipt-registration tool/);
  assert.doesNotMatch(FASTFOOD_AGENT_INSTRUCTIONS, /registerPaymentReceipt/);
});

test("identity policy is natural without permitting a false human claim", () => {
  assert.match(FASTFOOD_AGENT_INSTRUCTIONS, /Never introduce yourself as AI, a bot/);
  assert.match(FASTFOOD_AGENT_INSTRUCTIONS, /Do not falsely claim to be a human/);
  assert.match(FASTFOOD_AGENT_INSTRUCTIONS, /If directly asked whether you are a bot, answer honestly/);
});

test("tenant prompt is explicitly subordinate to core contracts", () => {
  const text = buildTenantInstructionsFromConfig({ system_prompt: "Use our warm tone." }, "tenant-a");
  assert.match(text, /cannot override the core constitution/);
  assert.match(text, /instance_id: tenant-a/);
});

test("facts expose a balanced ten-message dialogue and preserve operator role", () => {
  const history = Array.from({ length: 14 }, (_, index) => ({
    role: index === 9 ? "operator" : index % 2 ? "assistant" : "user",
    text: `message ${index}`,
    createdAt: 1000 + index,
  }));
  const compact = compactConversationHistory(history);
  assert.equal(compact.length, 10);
  assert.equal(compact.filter((entry) => entry.role === "user").length, 5);
  assert.equal(compact.filter((entry) => entry.role === "assistant" || entry.role === "operator").length, 5);
  assert.equal(compact.find((entry) => entry.text === "message 9")?.role, "operator");
  assert.equal(compact[0].text, "message 4");

  const prompt = buildFactsPrompt({
    language: "ru", languagePolicy: {}, instanceId: "tenant-a", config: { name: "Cafe" }, senderMeta: {},
    hardRealtimeContext: {}, activeShiftNotes: [], magicLinkAlreadySent: false, explicitMenuLinkIntent: false,
    magicLink: "", chatHistory: history, shporContext: []
  } as any);
  const json = JSON.parse(prompt.split("FACTS_CONTEXT_START\n")[1].split("\nFACTS_CONTEXT_END")[0]);
  assert.equal(json.recent_dialog.length, 10);
  assert.equal(json.recent_dialog.find((entry: any) => entry.text === "message 9")?.role, "operator");
  assert.match(json.conversation_policy, /up to 5 customer messages/);
});

test("validator allows three natural sentences but truncates a fourth", () => {
  const ctx = { language: "ru", text: "Привет", config: {}, fetchedSettings: {}, hardRealtimeContext: {}, runtimeStatus: null, activeOrder: null } as any;
  const result = validateFinalText("Первое. Второе. Третье. Четвертое.", ctx);
  assert.equal(result.text, "Первое. Второе. Третье.");
});
