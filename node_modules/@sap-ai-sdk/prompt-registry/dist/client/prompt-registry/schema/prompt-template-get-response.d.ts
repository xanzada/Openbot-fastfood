import type { PromptTemplateSpec } from './prompt-template-spec.js';
/**
 * Representation of the 'PromptTemplateGetResponse' schema.
 */
export type PromptTemplateGetResponse = {
    /**
     * Format: "uuid".
     */
    id?: string;
    name?: string;
    version?: string;
    scenario?: string;
    /**
     * Format: "timestamp".
     */
    creationTimestamp?: string;
    managedBy?: string;
    isVersionHead?: boolean;
    resourceGroupId?: string;
    spec?: PromptTemplateSpec;
} & Record<string, any>;
//# sourceMappingURL=prompt-template-get-response.d.ts.map