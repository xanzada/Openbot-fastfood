import { Agent } from "@voltagent/core";
import { buildFactsPrompt } from "../context/buildFactsPrompt.js";
import { createFastFoodSkills } from "../skills/index.js";
import { FASTFOOD_AGENT_INSTRUCTIONS } from "./instructions.js";
import { validateFinalText } from "./finalValidator.js";
import { resolveModel } from "./modelRouter.js";
import { buildTenantInstructions } from "./persona.js";
function enforceExplicitMagicLink(text, ctx) {
  if (!ctx.explicitMenuLinkIntent || !ctx.magicLink || text.includes(ctx.magicLink)) return text;
  const intro = ctx.language === "kk" ? "\u041C\u0456\u043D\u0435 \u043C\u04D9\u0437\u0456\u0440 \u0441\u0456\u043B\u0442\u0435\u043C\u0435\u0441\u0456:" : "\u0412\u043E\u0442 \u0441\u0441\u044B\u043B\u043A\u0430 \u043D\u0430 \u043C\u0435\u043D\u044E:";
  return `${intro}
${ctx.magicLink}`;
}
async function runFastFoodAgent(ctx) {
  const instructions = [
    buildTenantInstructions(ctx),
    FASTFOOD_AGENT_INSTRUCTIONS,
    buildFactsPrompt(ctx)
  ].filter(Boolean).join("\n\n");
  const agent = new Agent({
    name: "FastFood OpenBot",
    instructions,
    model: resolveModel(ctx),
    tools: createFastFoodSkills(ctx),
    maxSteps: 6,
    markdown: false
  });
  const result = await agent.generateText(ctx.text, {
    maxSteps: 6,
    // @ts-expect-error - allowSystemMessages is valid in AI SDK v6 but missing from @voltagent/core types
    allowSystemMessages: true
  });
  const validation = validateFinalText(result.text, ctx);
  const finalText = enforceExplicitMagicLink(validation.text, ctx);
  return {
    text: finalText,
    hasLink: validation.hasLink || Boolean(ctx.magicLink && finalText.includes(ctx.magicLink)),
    link: ctx.magicLink,
    rawText: result.text,
    usage: result.usage,
    finishReason: result.finishReason
  };
}
export {
  runFastFoodAgent
};
