/**
 * Representation of the 'GroundingFilterSearchConfiguration' schema.
 */
export type GroundingFilterSearchConfiguration = {
    /**
     * Maximum number of chunks to be returned. Cannot be used with 'maxDocumentCount'.
     */
    max_chunk_count?: number;
    /**
     * [Only supports 'vector' dataRepositoryType] - Maximum number of documents to be returned. Cannot be used with 'maxChunkCount'. If maxDocumentCount is given, then only one chunk per document is returned.
     */
    max_document_count?: number;
};
//# sourceMappingURL=grounding-filter-search-configuration.d.ts.map