import { Agent } from "@voltagent/core";
import { buildFactsPrompt } from "../context/buildFactsPrompt.js";
import type { FastFoodContext } from "../context/types.js";
import { createFastFoodSkills } from "../skills/index.js";
import { FASTFOOD_AGENT_INSTRUCTIONS } from "./instructions.js";
import { validateFinalText } from "./finalValidator.js";
import { resolveModel } from "./modelRouter.js";

function firstConfigText(config: Record<string, any>, ...keys: string[]) {
  for (const key of keys) {
    const value = config?.[key];
    if (value !== undefined && value !== null && String(value).trim()) return String(value).trim();
  }
  return "";
}

function buildTenantInstructions(ctx: FastFoodContext) {
  const prompt = firstConfigText(
    ctx.config,
    "system_prompt",
    "systemPrompt",
    "bot_prompt",
    "botPrompt",
    "ai_prompt",
    "aiPrompt",
    "restaurant_prompt",
    "restaurantPrompt",
    "prompt"
  );
  if (!prompt) return "";
  return [
    "TENANT_INSTRUCTIONS_START",
    `instance_id: ${ctx.instanceId}`,
    "These instructions come from the NocoDB Restaurants row for this exact instance only.",
    prompt,
    "TENANT_INSTRUCTIONS_END",
  ].join("\n");
}

function enforceExplicitMagicLink(text: string, ctx: FastFoodContext) {
  if (!ctx.explicitMenuLinkIntent || !ctx.magicLink || text.includes(ctx.magicLink)) return text;
  const intro = ctx.language === "kk" ? "Міне мәзір сілтемесі:" : "Вот ссылка на меню:";
  return `${intro}\n${ctx.magicLink}`;
}

export async function runFastFoodAgent(ctx: FastFoodContext) {
  const instructions = [
    FASTFOOD_AGENT_INSTRUCTIONS,
    buildTenantInstructions(ctx),
    buildFactsPrompt(ctx),
  ].filter(Boolean).join("\n\n");
  const agent = new Agent({
    name: "FastFood OpenBot",
    instructions,
    model: resolveModel(ctx),
    tools: createFastFoodSkills(ctx),
    maxSteps: 6,
    markdown: false,
  });

  const result = await agent.generateText(ctx.text, {
    maxSteps: 6,
    // @ts-expect-error - allowSystemMessages is valid in AI SDK v6 but missing from @voltagent/core types
    allowSystemMessages: true,
  });

  const validation = validateFinalText(result.text, ctx);
  const finalText = enforceExplicitMagicLink(validation.text, ctx);
  return {
    text: finalText,
    hasLink: validation.hasLink || Boolean(ctx.magicLink && finalText.includes(ctx.magicLink)),
    link: ctx.magicLink,
    rawText: result.text,
    usage: result.usage,
    finishReason: result.finishReason,
  };
}
