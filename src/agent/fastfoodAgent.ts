import { Agent, stepCountIs } from "@voltagent/core";
import type { FastFoodContext } from "../context/types.js";
import { createFastFoodSkills } from "../skills/index.js";
import { analyzeTurnSituation, critiqueDraftReply, type DraftCritique, type TurnAnalysis } from "../services/agentThinking.service.js";
import { validateFinalText } from "./finalValidator.js";
import { buildAgentInstructions } from "./instructionAssembly.js";
import { resolveModel } from "./modelRouter.js";
import { createAgentStepPolicy, resolveAgentToolPlan } from "./toolPolicy.js";
import { envNumber } from "../utils/envNumber.js";

function enforceExplicitMagicLink(text: string, ctx: FastFoodContext) {
  if (!ctx.explicitMenuLinkIntent || !ctx.magicLink || text.includes(ctx.magicLink)) return text;
  const intro = ctx.language === "kk" ? "Міне мәзір сілтемесі:" : "Вот ссылка на меню:";
  return `${intro}\n${ctx.magicLink}`;
}

function buildAgent(ctx: FastFoodContext, extraInstruction?: string) {
  return new Agent({
    name: "FastFood OpenBot",
    instructions: buildAgentInstructions(ctx, extraInstruction),
    model: resolveModel(ctx),
    tools: createFastFoodSkills(ctx),
    maxSteps: 6,
    markdown: false,
  });
}

function extractToolCalls(result: any) {
  const steps = Array.isArray(result?.steps) ? result.steps : [];
  return steps.flatMap((step: any) =>
    (Array.isArray(step?.toolCalls) ? step.toolCalls : []).map((call: any) => ({
      name: String(call?.toolName || call?.name || ""),
      arguments: call?.input || call?.args || call?.arguments || {},
    }))
  ).filter((call: any) => call.name);
}

export async function runFastFoodAgent(ctx: FastFoodContext) {
  const turnStartedAt = Date.now();
  // Latency budget: the customer waits in WhatsApp, so the optional
  // intelligence layers only run while there is time left. A turn that already
  // burned its budget on model failover answers with the plain (already good)
  // pipeline instead of stacking more calls on top.
  const CRITIC_BUDGET_MS = envNumber(process.env.CRITIC_BUDGET_MS, 20_000, { min: 10_000, max: 60_000 });
  const REGEN_BUDGET_MS = envNumber(process.env.REGEN_BUDGET_MS, 38_000, { min: CRITIC_BUDGET_MS + 5_000, max: 90_000 });

  const toolPlan = resolveAgentToolPlan(ctx);

  // Silent pre-pass: on non-trivial turns the think layer reads the situation
  // first (goal, mood, risk) and lands in FACTS_CONTEXT as advisory guidance.
  // Skipped entirely for greetings, one-word turns, and turns whose tool plan
  // is already confident - so simple chats pay nothing. Any failure is just
  // "no guidance".
  if (ctx.thinking === undefined || ctx.thinking === null) {
    ctx.thinking = await analyzeTurnSituation(ctx, toolPlan).catch(() => null);
  }
  const thinking = (ctx.thinking || null) as TurnAnalysis | null;

  const stepPolicy = createAgentStepPolicy(toolPlan);
  // Typed as any on purpose: allowSystemInMessages is valid in AI SDK v6 but
  // missing from @voltagent/core types. The old key name was allowSystemMessages,
  // which the SDK ignored, so every single generation logged a security warning
  // in production. The model router owns retry/failover, hence maxRetries: 0.
  // STEP_LOOP_FIX: per-call `maxSteps` is stripped from VoltAgent v2 generate
  // options (Omit<..., "maxSteps", ...>), so a turn that called a tool stopped
  // right after the tool step and shipped the partial pre-tool text (e.g. a
  // 3-char reply). `stopWhen` is the supported per-call stop condition, so the
  // agent now finishes its answer after reading the tool result.
  const generateOptions: any = {
    maxSteps: 6,
    stopWhen: stepCountIs(6),
    maxRetries: 0,
    prepareStep: stepPolicy,
    allowSystemInMessages: true,
  };

  let result = await buildAgent(ctx).generateText(ctx.text, generateOptions);
  let validation = validateFinalText(result.text, ctx, { toolsCalled: extractToolCalls(result).map((call: { name: string }) => call.name) });
  let finalText = enforceExplicitMagicLink(validation.text, ctx);
  let critic: DraftCritique | null = null;

  // Bounded self-check: only high-risk turns (money, order state, strong
  // emotion) pay for a critic read, and only a genuinely broken draft is
  // rewritten - exactly once, so latency and cost stay capped.
  if (thinking?.risk === "high" && finalText && Date.now() - turnStartedAt < CRITIC_BUDGET_MS) {
    critic = await critiqueDraftReply({ ctx, analysis: thinking, draft: finalText }).catch(() => null);
    if (critic && !critic.ok && Date.now() - turnStartedAt < REGEN_BUDGET_MS) {
      const critiqueNote = [
        "CRITIC_NOTE (internal, never quote or mention):",
        `issues: ${critic.issues.join(", ")}`,
        critic.fix_hint ? `fix: ${critic.fix_hint}` : "",
        "Rewrite the reply for THIS turn fixing exactly that. Keep every verified fact and every required link.",
      ].filter(Boolean).join("\n");
      try {
        const regenerated = await buildAgent(ctx, critiqueNote).generateText(ctx.text, generateOptions);
        const regeneratedValidation = validateFinalText(regenerated.text, ctx, { toolsCalled: extractToolCalls(regenerated).map((call: { name: string }) => call.name) });
        const regeneratedText = enforceExplicitMagicLink(regeneratedValidation.text, ctx);
        if (regeneratedText && regeneratedText !== finalText) {
          result = regenerated;
          validation = {
            ...regeneratedValidation,
            warnings: [...regeneratedValidation.warnings, "critic_regenerated", ...critic.issues.map((issue) => `critic_${issue}`)],
          };
          finalText = regeneratedText;
          console.info(`[CRITIC] regenerated instance=${ctx.instanceId} issues=${critic.issues.join(",")}`);
        }
      } catch (error: any) {
        console.warn(`[CRITIC] regen_failed instance=${ctx.instanceId} reason=${error?.message || error}`);
        validation = { ...validation, warnings: [...validation.warnings, "critic_regen_failed"] };
      }
    }
  }

  return {
    text: finalText,
    hasLink: validation.hasLink || Boolean(ctx.magicLink && finalText.includes(ctx.magicLink)),
    link: ctx.magicLink,
    rawText: result.text,
    usage: result.usage,
    finishReason: result.finishReason,
    toolPlan,
    toolCalls: extractToolCalls(result),
    validationWarnings: validation.warnings,
    thinking,
    critic,
  };
}
