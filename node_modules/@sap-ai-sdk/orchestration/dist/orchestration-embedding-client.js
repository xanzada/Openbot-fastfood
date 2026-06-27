import { executeRequest } from '@sap-ai-sdk/core';
import { getOrchestrationDeploymentId } from '@sap-ai-sdk/ai-api/internal.js';
import { OrchestrationEmbeddingResponse } from './orchestration-embedding-response.js';
import { constructEmbeddingPostRequest } from './util/index.js';
/**
 * Orchestration embedding client for generating embeddings with optional orchestration modules.
 */
export class OrchestrationEmbeddingClient {
    config;
    deploymentConfig;
    destination;
    /**
     * Creates an instance of the orchestration embedding client.
     * @param config - Embedding module configuration.
     * @param deploymentConfig - Deployment configuration.
     * @param destination - The destination to use for the request.
     */
    constructor(config, deploymentConfig, destination) {
        this.config = config;
        this.deploymentConfig = deploymentConfig;
        this.destination = destination;
    }
    /**
     * Generate embeddings for the given input.
     * @param request - Embedding request configuration.
     * @param requestConfig - Custom request configuration.
     * @returns Promise resolving to embedding response.
     */
    async embed(request, requestConfig) {
        const response = await this.executeRequest(request, requestConfig);
        return new OrchestrationEmbeddingResponse(response);
    }
    async executeRequest(request, requestConfig) {
        const body = constructEmbeddingPostRequest(this.config, request);
        const deploymentId = await getOrchestrationDeploymentId(this.deploymentConfig || {}, this.destination);
        if (!deploymentId) {
            throw new Error('Failed to resolve deployment ID');
        }
        return executeRequest({
            url: `/inference/deployments/${deploymentId}/v2/embeddings`,
            ...(this.deploymentConfig ?? {})
        }, body, requestConfig, this.destination);
    }
}
//# sourceMappingURL=orchestration-embedding-client.js.map