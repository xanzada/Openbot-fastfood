/**
 * Representation of the 'PromptTemplatePostResponse' schema.
 */
export type PromptTemplatePostResponse = {
    message: string;
    /**
     * Format: "uuid".
     */
    id: string;
    scenario: string;
    name: string;
    version: string;
} & Record<string, any>;
//# sourceMappingURL=prompt-template-post-response.d.ts.map