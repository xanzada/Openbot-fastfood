import { OrchestrationEmbeddingResponse } from './orchestration-embedding-response.js';
import type { CustomRequestConfig } from '@sap-cloud-sdk/http-client';
import type { DeploymentIdConfig, ResourceGroupConfig } from '@sap-ai-sdk/ai-api/internal.js';
import type { EmbeddingModuleConfig, EmbeddingRequest } from './orchestration-types.js';
import type { HttpDestinationOrFetchOptions } from '@sap-cloud-sdk/connectivity';
/**
 * Orchestration embedding client for generating embeddings with optional orchestration modules.
 */
export declare class OrchestrationEmbeddingClient {
    private config;
    private deploymentConfig?;
    private destination?;
    /**
     * Creates an instance of the orchestration embedding client.
     * @param config - Embedding module configuration.
     * @param deploymentConfig - Deployment configuration.
     * @param destination - The destination to use for the request.
     */
    constructor(config: EmbeddingModuleConfig, deploymentConfig?: (ResourceGroupConfig | DeploymentIdConfig) | undefined, destination?: HttpDestinationOrFetchOptions | undefined);
    /**
     * Generate embeddings for the given input.
     * @param request - Embedding request configuration.
     * @param requestConfig - Custom request configuration.
     * @returns Promise resolving to embedding response.
     */
    embed(request: EmbeddingRequest, requestConfig?: CustomRequestConfig): Promise<OrchestrationEmbeddingResponse>;
    private executeRequest;
}
//# sourceMappingURL=orchestration-embedding-client.d.ts.map