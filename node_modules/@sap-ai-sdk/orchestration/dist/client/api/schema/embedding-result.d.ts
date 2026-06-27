import type { Embedding } from './embedding.js';
/**
 * Represents an embedding vector returned by embedding endpoint.
 *
 */
export type EmbeddingResult = {
    /**
     * The object type, which is always "embedding".
     */
    object: 'embedding';
    embedding: Embedding;
    /**
     * The index of the embedding in the list of embeddings.
     */
    index: number;
};
//# sourceMappingURL=embedding-result.d.ts.map