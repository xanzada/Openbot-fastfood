import { buildFactsPrompt } from "../context/buildFactsPrompt.js";
import { FASTFOOD_AGENT_INSTRUCTIONS } from "./instructions.js";
/**
 * One owner for the model prompt. Restaurant-specific instructions live only
 * in the bounded FACTS_CONTEXT tenant block; the core constitution stays in
 * code and is identical even when the tenant prompt is empty.
 */
export function buildAgentInstructions(ctx, extraInstruction = "") {
    return [
        FASTFOOD_AGENT_INSTRUCTIONS,
        buildFactsPrompt(ctx),
        extraInstruction,
    ].filter(Boolean).join("\n\n");
}
