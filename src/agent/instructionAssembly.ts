import { buildFactsPrompt, turnAnalysis } from "../context/buildFactsPrompt.js";
import type { FastFoodContext } from "../context/types.js";
import { FASTFOOD_AGENT_INSTRUCTIONS } from "./instructions.js";

/**
 * One owner for the model prompt. Restaurant-specific instructions live only
 * in the bounded FACTS_CONTEXT tenant block; the core constitution stays in
 * code and is identical even when the tenant prompt is empty.
 */
export function buildAgentInstructions(ctx: FastFoodContext, extraInstruction = "") {
  return [
    FASTFOOD_AGENT_INSTRUCTIONS,
    buildFactsPrompt(ctx),
    extraInstruction,
  ].filter(Boolean).join("\n\n");
}


/** Turn-local readiness only; publishing after close cannot mutate a completed turn. */
export function createTurnThinkingState(initial: any) {
  let ready = initial || null;
  let open = true;
  return {
    read: () => open ? ready : null,
    settle: (analysis: any) => { if (open) ready = analysis || null; },
    close: () => { open = false; },
  };
}

/** Only change the bounded advisory field in the actual instructions supplied for this pass. */
function refreshAnalysisInstructions(original: string, analysis: any): string | null {
  const start = "FACTS_CONTEXT_START\n";
  const end = "\nFACTS_CONTEXT_END";
  const begin = original.indexOf(start);
  const finish = original.indexOf(end, begin + start.length);
  if (begin < 0 || finish < 0 || original.indexOf(start, begin + 1) >= 0 || original.indexOf(end, finish + 1) >= 0) return null;
  const facts = original.slice(begin + start.length, finish);
  const matches = [...facts.matchAll(/^  "turn_analysis": (?:null|\{[\s\S]*?^  \}),\n(?=  "reply_shape":)/gm)];
  if (matches.length !== 1) return null;
  try {
    const advisory = JSON.stringify(turnAnalysis({ thinking: analysis } as any), null, 2);
    if (advisory.length > 2_048) return null;
    const match = matches[0];
    const offset = begin + start.length + match.index!;
    const replacement = '  "turn_analysis": ' + advisory.replace(/\n/g, "\n  ") + ",\n";
    return original.slice(0, offset) + replacement + original.slice(offset + match[0].length);
  } catch { return null; }
}

/** Synchronous: no waiting, model request, step, or tool-policy override. */
export function composeReadyAnalysisStepPolicy(
  basePolicy: (args: any) => any,
  originalInstructions: string,
  readReady: () => any,
  onSkip: (reason: string) => void = () => {},
) {
  let cachedAnalysis: any;
  let cachedInstructions: string | null = null;
  return (args: any) => {
    const base = basePolicy(args);
    const analysis = readReady();
    if (!analysis || typeof analysis.goal !== "string") return base;
    if (analysis !== cachedAnalysis) {
      cachedAnalysis = analysis;
      cachedInstructions = refreshAnalysisInstructions(originalInstructions, analysis);
    }
    if (cachedInstructions === null) { onSkip("analysis_span_unrecognized_or_unbounded"); return base; }
    const messages = args?.messages;
    if (!Array.isArray(messages) || !originalInstructions) { onSkip("owned_span_missing"); return base; }
    let hits = 0;
    let target = -1;
    let offset = -1;
    messages.forEach((message: any, index: number) => {
      if (typeof message?.content !== "string") return;
      for (let at = message.content.indexOf(originalInstructions); at >= 0; at = message.content.indexOf(originalInstructions, at + 1)) {
        hits++; target = index; offset = at;
      }
    });
    if (hits !== 1) { onSkip(hits ? "owned_span_ambiguous" : "owned_span_missing"); return base; }
    if (messages[target]?.role !== "system") { onSkip("owned_span_wrong_role"); return base; }
    return {
      ...base,
      messages: messages.map((message: any, index: number) => index === target
        ? { ...message, content: message.content.slice(0, offset) + cachedInstructions + message.content.slice(offset + originalInstructions.length) }
        : { ...message }),
    };
  };
}
