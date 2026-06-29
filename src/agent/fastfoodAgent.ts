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
  const agent = new Agent({
    name: "FastFood OpenBot",
    instructions: `${FASTFOOD_AGENT_INSTRUCTIONS}\n\n${buildFactsPrompt(ctx)}`,
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
