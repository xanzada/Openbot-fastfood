import type { ModuleResultsBase } from './module-results-base.js';
import type { LlmModuleResult } from './llm-module-result.js';
import type { LlmChoice } from './llm-choice.js';
/**
 * Synchronous results of each module.
 */
export type ModuleResults = ModuleResultsBase & {
    llm?: LlmModuleResult;
    output_unmasking?: LlmChoice[];
} & Record<string, any>;
//# sourceMappingURL=module-results.d.ts.map