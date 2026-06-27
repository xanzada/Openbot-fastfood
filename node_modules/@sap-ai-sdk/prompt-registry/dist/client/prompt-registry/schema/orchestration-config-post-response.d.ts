/**
 * Representation of the 'OrchestrationConfigPostResponse' schema.
 */
export type OrchestrationConfigPostResponse = {
    message: string;
    /**
     * Format: "uuid".
     */
    id: string;
    scenario: string;
    name: string;
    version: string;
} & Record<string, any>;
//# sourceMappingURL=orchestration-config-post-response.d.ts.map