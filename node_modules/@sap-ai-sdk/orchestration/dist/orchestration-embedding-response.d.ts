import type { HttpResponse } from '@sap-cloud-sdk/http-client';
import type { EmbeddingsPostResponse, EmbeddingsUsage, ModuleResultsBase } from './client/api/schema/index.js';
import type { EmbeddingData } from './orchestration-types.js';
/**
 * Response wrapper for orchestration embedding requests.
 */
export declare class OrchestrationEmbeddingResponse {
    readonly response: HttpResponse;
    readonly _data: EmbeddingsPostResponse;
    constructor(response: HttpResponse);
    /**
     * Final embedding results with index and object type (which is always `embedding`) information.
     * @returns Array of embedding data objects containing both vectors, indices, and object types.
     */
    getEmbeddings(): EmbeddingData[];
    /**
     * Usage information.
     * @returns Usage information or undefined.
     */
    getTokenUsage(): EmbeddingsUsage;
    /**
     * Intermediate results from orchestration modules.
     * @returns Intermediate results or undefined.
     */
    getIntermediateResults(): ModuleResultsBase | undefined;
    /**
     * Gets the request ID for the embedding response.
     * @returns The request ID.
     */
    getRequestId(): string;
}
//# sourceMappingURL=orchestration-embedding-response.d.ts.map