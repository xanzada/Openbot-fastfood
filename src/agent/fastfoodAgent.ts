import { Agent, stepCountIs } from "@voltagent/core";
import type { FastFoodContext } from "../context/types.js";
import { createFastFoodSkills } from "../skills/index.js";
import { analyzeTurnSituation, critiqueDraftReply, type DraftCritique, type TurnAnalysis } from "../services/agentThinking.service.js";
import { fallbackReply, validateFinalText, type ToolGroundingFindings } from "./finalValidator.js";
import { readGuestGreeting } from "./greeting.js";
import { buildAgentInstructions, composeReadyAnalysisStepPolicy, createTurnThinkingState } from "./instructionAssembly.js";
import { resolveModel } from "./modelRouter.js";
import { createAgentStepPolicy, resolveLiveAgentToolPlan } from "./toolPolicy.js";
import { groundMenuTurn, menuQueryForTurn } from "../skills/searchMenu.skill.js";
import { honorMenuLinkPromise } from "./linkPromise.js";
import { classifyKitchenSalesPolicyForContext } from "../services/kitchenPolicy.service.js";
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

function buildAgent(ctx: FastFoodContext, extraInstruction?: string, capture?: (instructions: string) => void) {
  const instructions = buildAgentInstructions(ctx, extraInstruction);
  capture?.(instructions);
  return new Agent({
    name: "FastFood OpenBot",
    instructions,
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

// What the tools RETURNED, not just that they ran. The validator needs this to tell a
// successful order lookup from an empty one: every "your order is on the way" guard was
// unlocked by the call alone, so the reply the model is most confident about - the one
// where the lookup found nothing - was the one that shipped (found 2026-08-22).
function extractToolFindings(result: any): ToolGroundingFindings {
  const steps = Array.isArray(result?.steps) ? result.steps : [];
  let sawLookup = false;
  let found = false;
  let orderLookup: string | undefined;
  let orderStatus: string | undefined, orderStage: string | undefined, orderStatusLabel: string | undefined;
  let orderItems: Array<{ name: string }> | undefined;
  let escalationCreated: boolean | undefined;
  let escalationNotificationAccepted: boolean | undefined;
  for (const step of steps) {
    const results = Array.isArray(step?.toolResults) ? step.toolResults : [];
    for (const entry of results) {
      const name = String(entry?.toolName || entry?.name || "");
      if (name === "checkOrderStatus") {
        sawLookup = true;
        const payload: any = entry?.output ?? entry?.result ?? entry?.response ?? null;
        orderLookup = String(payload?.lookup || "unavailable");
        found = orderLookup === "found";
        orderStatus = found ? String(payload.status || "") : undefined;
        orderStage = found ? String(payload.stage || "") : undefined;
        orderStatusLabel = found ? String(payload.statusLabel || "") : undefined;
        orderItems = found && Array.isArray(payload.items) ? payload.items.map((item: any) => ({ name: String(item.name || "") })).filter((item: any) => item.name) : undefined;
      }
      // What the escalation tool RETURNED decides what the agent may claim. Only
      // action=operator_case_created means a human was actually notified; the clarify-first
      // outcome is a question owed to the guest, not a notification.
      if (name === "escalateToAdmin") {
        const payload: any = entry?.output ?? entry?.result ?? entry?.response ?? null;
        if (escalationCreated !== true) {
          escalationCreated = Boolean(payload && String(payload.action || "") === "operator_case_created");
          escalationNotificationAccepted = escalationCreated && payload?.adminNotificationAccepted === true;
        }
      }
    }
  }
  // Undefined means the runtime supplied no positive lookup evidence.
  if (!sawLookup && escalationCreated === undefined) return {};
  return {
    ...(sawLookup ? { orderFound: found, orderLookup, orderStatus, orderStage, orderStatusLabel, orderItems } : {}),
    ...(escalationCreated !== undefined ? { escalationCreated, escalationNotificationAccepted } : {}),
  };
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

  const toolPlan = await resolveLiveAgentToolPlan(ctx);
  const menuGrounding = toolPlan.requiredTools.includes("searchMenu") ? await groundMenuTurn(ctx) : null;
  const groundedCalls = menuGrounding ? [{ name: "searchMenu", arguments: { query: typeof menuGrounding.lookup_query === "string" ? menuGrounding.lookup_query : menuQueryForTurn(ctx.text, ctx), limit: 12 } }] : [];
  const menuInstruction = menuGrounding
    ? "searchMenu already executed for THIS turn. Use this verified result, including unavailable flags; do not invent a missing exact match. When needs_dish_clarification is true, ask which dish the customer means instead of selecting one from previous assistant text.\n" + JSON.stringify(menuGrounding)
    : undefined;
  const kitchenPolicy = classifyKitchenSalesPolicyForContext(ctx.runtimeStatus, ctx.activeShiftNotes);
  const consentInstruction = kitchenPolicy.requiresConsent && ctx.kitchenCheckoutFingerprint === kitchenPolicy.fingerprint
    ? "The customer has ALREADY accepted this exact kitchen wait in persisted checkout state. Do not ask for consent again. Continue actual requested site checkout using sendMenuLink; never collect manual order/address details."
    : undefined;
  const groundingInstruction = [menuInstruction, consentInstruction].filter(Boolean).join("\n");
  const remainingPlan = menuGrounding
    ? { requiredTools: toolPlan.requiredTools.filter((tool) => tool !== "searchMenu"), reason: toolPlan.reason }
    : toolPlan;

  // Silent pre-pass: on non-trivial turns the think layer reads the situation
  // first (goal, mood, risk) and lands in FACTS_CONTEXT as advisory guidance.
  // Skipped entirely for greetings, one-word turns, and turns whose tool plan
  // is already confident - so simple chats pay nothing. Any failure is just
  // "no guidance".
  //
  // Zero-lag THINK (2026-10-04): the pre-pass used to block the answer for up to
  // THINK_TIMEOUT_MS - live, a 39 s turn lost 5 s here and THINK timed out anyway.
  // It now runs IN PARALLEL with the answer and is joined right after it (bounded by
  // THINK_JOIN_MS) for the critic, metrics and routing. THINK_MODE=blocking restores
  // the old order, THINK_MODE=off skips it.
  const thinkMode = String(process.env.THINK_MODE || "parallel").trim().toLowerCase();
  const thinkingState = createTurnThinkingState(ctx.thinking);
  let pendingThinking: Promise<TurnAnalysis | null> | null = null;
  if (ctx.thinking === undefined || ctx.thinking === null) {
    if (thinkMode === "blocking") {
      ctx.thinking = await analyzeTurnSituation(ctx, toolPlan).catch(() => null);
      thinkingState.settle(ctx.thinking);
    } else if (thinkMode !== "off") {
      ctx.thinking = null;
      pendingThinking = analyzeTurnSituation(ctx, toolPlan).then(
        analysis => { thinkingState.settle(analysis); return analysis; },
        () => { thinkingState.settle(null); return null; },
      );
    }
  }
  let thinking = thinkingState.read() as TurnAnalysis | null;

  try {
    // A turn that is nothing but a greeting needs no tool: live calibration (2026-10-04) saw
    // «Сәлем» spend an extra model round on updateCrmLead and take 8-22 s instead of 2-4 s.
    const greetingOnly = Boolean(readGuestGreeting(String(ctx.text || ""))?.pure) && !toolPlan.requiredTools.length;
    const stepPolicy = greetingOnly ? () => ({ toolChoice: "none" as const }) : createAgentStepPolicy(remainingPlan);
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

    const generatePass = (extraInstruction: string) => {
      let actualInstructions = "";
      const agent = buildAgent(ctx, extraInstruction, instructions => { actualInstructions = instructions; });
      return agent.generateText(ctx.text, {
        ...generateOptions,
        prepareStep: composeReadyAnalysisStepPolicy(stepPolicy, actualInstructions, thinkingState.read,
          reason => console.info("[THINK] ready_guidance_skipped=" + reason)),
      });
    };
    let result = await generatePass(groundingInstruction);
    if (pendingThinking) {
      const joinMs = envNumber(process.env.THINK_JOIN_MS, 300, { min: 0, max: 5_000 });
      const joined = await Promise.race([
        pendingThinking,
        new Promise<null>((resolve) => setTimeout(() => resolve(null), joinMs)),
      ]);
      thinking = joined || thinkingState.read() || null;
      ctx.thinking = thinking;
      console.info(`[THINK] parallel instance=${ctx.instanceId} joined=${thinking ? "yes" : "no"}`);
    }
    // Kept separately because the critic can replace `result` below.
    let firstPassToolCalls: { name: string; arguments: unknown }[] = [];
    let validation = validateFinalText(result.text, ctx, {
      toolsCalled: mergeToolCalls(groundedCalls, extractToolCalls(result)).map((call: { name: string }) => call.name),
      toolFindings: extractToolFindings(result),
    });
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
          const regenerated = await generatePass([groundingInstruction, critiqueNote].filter(Boolean).join("\n"));
          // The critic rewrite is validated against the UNION of both passes. Validating
          // it against its own calls alone stripped the prices and the allergen statement
          // the first pass had grounded, because the critic note tells the model to keep
          // the facts without re-calling the tools - so the guest got "состав подтвердить
          // не могу" after a correct first draft, on exactly the high-risk turns the
          // critic exists for (found 2026-08-22).
          const unionCalls = mergeToolCalls(groundedCalls, mergeToolCalls(extractToolCalls(result), extractToolCalls(regenerated)));
          const firstFindings = extractToolFindings(result);
          const regenFindings = extractToolFindings(regenerated);
          const regeneratedValidation = validateFinalText(regenerated.text, ctx, {
            toolsCalled: unionCalls.map((call: { name: string }) => call.name),
            // The latest status read wins; without another read, keep the first result.
            // A real escalation created in either pass remains created.
            toolFindings: {
              ...(regenFindings.orderFound !== undefined || firstFindings.orderFound !== undefined
                ? {
                    orderFound: regenFindings.orderFound ?? firstFindings.orderFound,
                    orderLookup: regenFindings.orderFound !== undefined ? regenFindings.orderLookup : firstFindings.orderLookup,
                    orderStatus: regenFindings.orderFound !== undefined ? regenFindings.orderStatus : firstFindings.orderStatus,
                    orderStage: regenFindings.orderFound !== undefined ? regenFindings.orderStage : firstFindings.orderStage,
                    orderStatusLabel: regenFindings.orderFound !== undefined ? regenFindings.orderStatusLabel : firstFindings.orderStatusLabel,
                    orderItems: regenFindings.orderFound !== undefined ? regenFindings.orderItems : firstFindings.orderItems,
                  }
                : {}),
              ...(regenFindings.escalationCreated !== undefined || firstFindings.escalationCreated !== undefined
                ? {
                    escalationCreated:
                      regenFindings.escalationCreated === true || firstFindings.escalationCreated === true
                        ? true
                        : (regenFindings.escalationCreated ?? firstFindings.escalationCreated),
                    escalationNotificationAccepted: regenFindings.escalationNotificationAccepted === true || firstFindings.escalationNotificationAccepted === true,
                  }
                : {}),
            },
          });
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

    // A promise the guest can see must be a promise the guest receives. Runs after every
    // rewrite, so it judges the text that will actually be sent.
    const promise = await honorMenuLinkPromise(ctx, finalText).catch(() => ({ action: "none" as const }));
    if (promise.action === "granted") {
      validation = { ...validation, warnings: [...validation.warnings, "link_promise_honored"] };
      console.info(`[LINK PROMISE] honored instance=${ctx.instanceId}`);
    } else if (promise.action === "stripped") {
      finalText = promise.text || fallbackReply(ctx);
      validation = { ...validation, warnings: [...validation.warnings, `link_promise_removed_${promise.reason}`] };
      console.warn(`[LINK PROMISE] removed instance=${ctx.instanceId} reason=${promise.reason}`);
    }

    const policy = classifyKitchenSalesPolicyForContext(ctx.runtimeStatus, ctx.activeShiftNotes);
    if (policy.mode !== "off_hours" && ctx.magicLinkGranted && ctx.magicLink && GRANTED_LINK_REFUSAL_RE.test(finalText)) {
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
        ? "Тапсырыс беруге болады - мәзірді бөлек хатпен жібердім, осы арқылы кіріп қойсаңыз болғаны."
        : "Можно оформить заказ - отправил меню отдельным сообщением, зайдите и выберите.");
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
      toolCalls: mergeToolCalls(groundedCalls, mergeToolCalls(firstPassToolCalls, extractToolCalls(result))),
      validationWarnings: validation.warnings,
      thinking,
      critic,
    };
  } finally {
    thinkingState.close();
  }
}
