import type { GenericModuleResult } from './generic-module-result.js';
import type { TemplatingChatMessage } from './templating-chat-message.js';
import type { InputTranslationModuleResult } from './input-translation-module-result.js';
/**
 * Results of each module of /embeddings endpoint(e.g. input masking).
 */
export type ModuleResultsBase = {
    grounding?: GenericModuleResult;
    templating?: TemplatingChatMessage;
    input_translation?: InputTranslationModuleResult;
    input_masking?: GenericModuleResult;
    input_filtering?: GenericModuleResult;
    output_filtering?: GenericModuleResult;
    output_translation?: GenericModuleResult;
};
//# sourceMappingURL=module-results-base.d.ts.map