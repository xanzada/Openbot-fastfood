import { Agent } from "@voltagent/core";
import { buildFactsPrompt } from "../context/buildFactsPrompt.js";
import type { FastFoodContext } from "../context/types.js";
import { createFastFoodSkills } from "../skills/index.js";
import { FASTFOOD_AGENT_INSTRUCTIONS } from "./instructions.js";
import { validateFinalText } from "./finalValidator.js";
import { resolveModel } from "./modelRouter.js";

function enforceExplicitMagicLink(text: string, ctx: FastFoodContext) {
  if (!ctx.explicitMenuLinkIntent || !ctx.magicLink || text.includes(ctx.magicLink)) return text;
  const intro = ctx.language === "kk" ? "Міне мәзір сілтемесі:" : "Вот ссылка на меню:";
  return `${intro}\n${ctx.magicLink}`;
}

export async function runFastFoodAgent(ctx: FastFoodContext) {
  const instructions = `${FASTFOOD_AGENT_INSTRUCTIONS}\n\n${buildFactsPrompt(ctx)}`;
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
