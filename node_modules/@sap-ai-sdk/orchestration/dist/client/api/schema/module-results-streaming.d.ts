import type { ModuleResultsBase } from './module-results-base.js';
import type { LLMModuleResultStreaming } from './llm-module-result-streaming.js';
import type { LlmChoiceStreaming } from './llm-choice-streaming.js';
/**
 * Streaming results of each module.
 */
export type ModuleResultsStreaming = ModuleResultsBase & {
    llm?: LLMModuleResultStreaming;
    output_unmasking?: LlmChoiceStreaming[];
} & Record<string, any>;
//# sourceMappingURL=module-results-streaming.d.ts.map