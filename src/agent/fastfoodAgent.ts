import { Agent } from "@voltagent/core";
import { createOpenAI } from "@ai-sdk/openai";
import { buildFactsPrompt } from "../context/buildFactsPrompt.js";
import type { FastFoodContext } from "../context/types.js";
import { createFastFoodSkills } from "../skills/index.js";
import { FASTFOOD_AGENT_INSTRUCTIONS } from "./instructions.js";
import { validateFinalText } from "./finalValidator.js";

const openrouter = createOpenAI({
  baseURL: "https://openrouter.ai/api/v1",
  apiKey: process.env.OPENROUTER_API_KEY,
});

export async function runFastFoodAgent(ctx: FastFoodContext) {
  const modelId = process.env.OPENROUTER_AGENT_MODEL || "google/gemini-2.5-flash";
  let system_prompt = `${FASTFOOD_AGENT_INSTRUCTIONS}\n\n${buildFactsPrompt(ctx)}`;
  const fetchedSettings = ctx.fetchedSettings || {};
  const liveWaitTime = fetchedSettings.wait_time ? fetchedSettings.wait_time : "UNKNOWN";
  const liveEmergency = fetchedSettings.is_emergency ? "YES (Stop orders)" : "NO";

  const forceFacts = `

=== LIVE SYSTEM FACTS (MANDATORY) ===
CURRENT WAIT TIME: ${liveWaitTime} minutes.
EMERGENCY STOP MODE: ${liveEmergency}.
If CURRENT WAIT TIME is UNKNOWN, you MUST say: "Дәл күту уақыты қазір көрінбей тұр, ас үйден нақтылап берейін." DO NOT INVENT NUMBERS. DO NOT SAY 40 MINUTES.
=====================================
`;
  system_prompt += forceFacts;

  const agent = new Agent({
    name: "FastFood OpenBot",
    instructions: system_prompt,
    model: openrouter(modelId),
    tools: createFastFoodSkills(ctx),
    maxSteps: 6,
    markdown: false,
  });

  const result = await agent.generateText(ctx.text, {
    maxSteps: 6,
  });

  const text = validateFinalText(result.text, ctx);
  return {
    text,
    rawText: result.text,
    usage: result.usage,
    finishReason: result.finishReason,
  };
}
