import { Agent } from "@voltagent/core";
import { buildFactsPrompt } from "../context/buildFactsPrompt.js";
import type { FastFoodContext } from "../context/types.js";
import { createFastFoodSkills } from "../skills/index.js";
import { FASTFOOD_AGENT_INSTRUCTIONS } from "./instructions.js";
import { validateFinalText } from "./finalValidator.js";
import { resolveModel } from "./modelRouter.js";
import { buildTenantInstructions } from "./persona.js";
import { createAgentStepPolicy, resolveAgentToolPlan } from "./toolPolicy.js";

function enforceExplicitMagicLink(text: string, ctx: FastFoodContext) {
  if (!ctx.explicitMenuLinkIntent || !ctx.magicLink || text.includes(ctx.magicLink)) return text;
  const intro = ctx.language === "kk" ? "Міне мәзір сілтемесі:" : "Вот ссылка на меню:";
  return `${intro}\n${ctx.magicLink}`;
}

export async function runFastFoodAgent(ctx: FastFoodContext) {
  const toolPlan = resolveAgentToolPlan(ctx);
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
    prepareStep: createAgentStepPolicy(toolPlan),
    // @ts-expect-error - allowSystemMessages is valid in AI SDK v6 but missing from @voltagent/core types
    allowSystemMessages: true,
  });

  const validation = validateFinalText(result.text, ctx);
  const finalText = enforceExplicitMagicLink(validation.text, ctx);
  const steps = Array.isArray((result as any).steps) ? (result as any).steps : [];
  const toolCalls = steps.flatMap((step: any) =>
    (Array.isArray(step?.toolCalls) ? step.toolCalls : []).map((call: any) => ({
      name: String(call?.toolName || call?.name || ""),
      arguments: call?.input || call?.args || call?.arguments || {},
    }))
  ).filter((call: any) => call.name);
  return {
    text: finalText,
    hasLink: validation.hasLink || Boolean(ctx.magicLink && finalText.includes(ctx.magicLink)),
    link: ctx.magicLink,
    rawText: result.text,
    usage: result.usage,
    finishReason: result.finishReason,
    toolPlan,
    toolCalls,
    validationWarnings: validation.warnings,
  };
}
