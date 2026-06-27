import type { ModuleResultsBase } from './module-results-base.js';
import type { EmbeddingsResponse } from './embeddings-response.js';
/**
 * Representation of the 'EmbeddingsPostResponse' schema.
 */
export type EmbeddingsPostResponse = {
    request_id: string;
    intermediate_results?: ModuleResultsBase;
    final_result: EmbeddingsResponse;
};
//# sourceMappingURL=embeddings-post-response.d.ts.map