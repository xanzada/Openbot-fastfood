import type { Template } from './template.js';
import type { TemplateRef } from './template-ref.js';
import type { LLMModelDetails } from './llm-model-details.js';
/**
 * Representation of the 'PromptTemplatingModuleConfig' schema.
 */
export type PromptTemplatingModuleConfig = {
    /**
     * The prompt template to be used. Can be either a user defined template or a reference to a template in the prompt registry.
     *
     */
    prompt: Template | TemplateRef;
    model: LLMModelDetails;
};
//# sourceMappingURL=prompt-templating-module-config.d.ts.map