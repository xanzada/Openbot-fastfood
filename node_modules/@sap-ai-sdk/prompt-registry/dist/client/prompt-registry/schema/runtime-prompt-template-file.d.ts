import type { PromptTemplateSpec } from './prompt-template-spec.js';
/**
 * Representation of the 'RuntimePromptTemplateFile' schema.
 */
export type RuntimePromptTemplateFile = {
    apiVersion?: string;
    kind?: string;
    metadata?: {
        name?: string;
        version?: string;
        scenario?: string;
    } & Record<string, any>;
    spec?: PromptTemplateSpec;
} & Record<string, any>;
//# sourceMappingURL=runtime-prompt-template-file.d.ts.map