import { Agent, stepCountIs } from "@voltagent/core";
import type { FastFoodContext } from "../context/types.js";
import { createFastFoodSkills } from "../skills/index.js";
import { analyzeTurnSituation, critiqueDraftReply, type DraftCritique, type TurnAnalysis } from "../services/agentThinking.service.js";
import { validateFinalText } from "./finalValidator.js";
import { buildAgentInstructions } from "./instructionAssembly.js";
import { resolveModel } from "./modelRouter.js";
import { createAgentStepPolicy, resolveAgentToolPlan } from "./toolPolicy.js";
import { envNumber } from "../utils/envNumber.js";

/**
 * The link rides along with the answer, it never becomes the answer.
 *
 * The old version replaced the whole reply with "here is the menu link" on any
 * turn whose text merely contained the word "мәзір"/"заказ", so a price
 * question, a working-hours question and an order request all produced the
 * identical canned URL while the model's real answer was thrown away (live QA
 * round, 2026-08-13). Now the agent itself decides: the link is appended only
 * when the sendMenuLink skill granted it this turn, and the answer is kept.
 */
// A granted link makes "we cannot take your order" a lie by definition. The
// model sometimes parrots an older refusal from the chat history while the tool
// already granted a fresh link for this turn (live round, 2026-08-14: the guest
// heard "тапсырыс қабылдай алмаймыз" and received the link in the same reply).
const GRANTED_LINK_REFUSAL_RE = /(қабылдай алмаймыз|қабылдамаймыз|техникалық себеп|жұмыс істемей тұр|жұмыс істемейді|сілтемелер уақытша|не можем принять|не принимаем заказ|ссылки временно|ссылка не работает)/iu;

/**
 * The link always travels as its own separate WhatsApp message (product rule,
 * 2026-08-14), never glued to the reply text. All this function still owes the
 * text: if the model pasted the URL in anyway, take every occurrence back out -
 * the transport sends it standalone.
 */
function enforceExplicitMagicLink(text: string, ctx: FastFoodContext) {
  if (!ctx.magicLinkGranted || !ctx.magicLink) return text;
  const link = ctx.magicLink;
  if (!text.includes(link)) return text;
  return text.split(link).join(" ").replace(/[ \t]{2,}/g, " ").replace(/\n{3,}/g, "\n\n").trim();
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

function mergeToolCalls(
  first: { name: string; arguments: unknown }[],
  second: { name: string; arguments: unknown }[]
) {
  const seen = new Set<string>();
  const merged: { name: string; arguments: unknown }[] = [];
  for (const call of [...first, ...second]) {
    const key = `${call.name}|${JSON.stringify(call.arguments ?? null)}`;
    if (seen.has(key)) continue;
    seen.add(key);
    merged.push(call);
  }
  return merged;
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
  // Kept separately because the critic can replace `result` below.
  let firstPassToolCalls: { name: string; arguments: unknown }[] = [];
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
          // The first pass's tool calls must survive the swap. `result` used to be
          // replaced outright, so toolCalls reported only the second pass: if the
          // first pass escalated and the regenerated one did not,
          // toolHandledEscalation went false and the webhook text lane routed the
          // SAME episode again - a second case and a second hub signal for one turn
          // (found 2026-08-22).
          firstPassToolCalls = extractToolCalls(result);
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

  if (ctx.magicLinkGranted && ctx.magicLink && GRANTED_LINK_REFUSAL_RE.test(finalText)) {
    // Cut the contradicting sentence, keep the rest. Replacing the WHOLE reply threw
    // away real operational facts that happen to contain the same words: "жеткізу
    // жұмыс істемей тұр, өзіңіз алып кетсеңіз болады" became "тапсырыс беруге
    // болады", telling the guest they could order delivery (found 2026-08-22).
    const kept = finalText
      .split(/(?<=[.!?\u2026])\s+|\n+/)
      .filter((sentence) => sentence.trim() && !GRANTED_LINK_REFUSAL_RE.test(sentence))
      .join(" ")
      .replace(/\s{2,}/g, " ")
      .trim();
    finalText = kept || (ctx.language === "kk"
      ? "Тапсырыс беруге болады - жеке сілтемеңізді бөлек хатпен жібердім."
      : "Можно оформить заказ - отправил вашу персональную ссылку отдельным сообщением.");
    validation = { ...validation, warnings: [...validation.warnings, "granted_link_refusal_clause_removed"] };
  }

  return {
    text: finalText,
    hasLink: Boolean(ctx.magicLinkGranted && ctx.magicLink),
    link: ctx.magicLink,
    rawText: result.text,
    usage: result.usage,
    finishReason: result.finishReason,
    toolPlan,
    // The union of both passes, de-duplicated by name+arguments: the caller uses
    // this to decide whether the escalate tool already handled this episode, and
    // that must not depend on which pass happened to be the last one.
    toolCalls: mergeToolCalls(firstPassToolCalls, extractToolCalls(result)),
    validationWarnings: validation.warnings,
    thinking,
    critic,
  };
}
