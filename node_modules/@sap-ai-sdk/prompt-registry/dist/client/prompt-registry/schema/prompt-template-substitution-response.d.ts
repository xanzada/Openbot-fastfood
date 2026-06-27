import type { PromptTemplate } from './prompt-template.js';
import type { PromptTemplateGetResponse } from './prompt-template-get-response.js';
/**
 * Representation of the 'PromptTemplateSubstitutionResponse' schema.
 */
export type PromptTemplateSubstitutionResponse = {
    parsedPrompt?: PromptTemplate[];
    resource?: PromptTemplateGetResponse;
} & Record<string, any>;
//# sourceMappingURL=prompt-template-substitution-response.d.ts.map