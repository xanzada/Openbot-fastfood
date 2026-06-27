import { z } from 'zod/v4';
import { ProviderV3, LanguageModelV3, EmbeddingModelV3, RerankingModelV3 } from '@ai-sdk/provider';
import { FetchFunction } from '@ai-sdk/provider-utils';

type CohereChatModelId = 'command-a-03-2025' | 'command-a-reasoning-08-2025' | 'command-a-vision-07-2025' | 'command-r7b-12-2024' | 'command-r-plus-04-2024' | 'command-r-plus' | 'command-r-08-2024' | 'command-r-03-2024' | 'command-r' | 'command' | 'command-nightly' | 'command-light' | 'command-light-nightly' | (string & {});
declare const cohereLanguageModelOptions: z.ZodObject<{
    thinking: z.ZodOptional<z.ZodObject<{
        type: z.ZodOptional<z.ZodEnum<{
            enabled: "enabled";
            disabled: "disabled";
        }>>;
        tokenBudget: z.ZodOptional<z.ZodNumber>;
    }, z.core.$strip>>;
}, z.core.$strip>;
type CohereLanguageModelOptions = z.infer<typeof cohereLanguageModelOptions>;

type CohereRerankingModelId = 'rerank-v3.5' | 'rerank-english-v3.0' | 'rerank-multilingual-v3.0' | (string & {});
type CohereRerankingModelOptions = {
    /**
     * Long documents will be automatically truncated to the specified number of tokens.
     *
     * @default 4096
     */
    maxTokensPerDoc?: number;
    /**
     * The priority of the request.
     *
     * @default 0
     */
    priority?: number;
};

type CohereEmbeddingModelId = 'embed-english-v3.0' | 'embed-multilingual-v3.0' | 'embed-english-light-v3.0' | 'embed-multilingual-light-v3.0' | 'embed-english-v2.0' | 'embed-english-light-v2.0' | 'embed-multilingual-v2.0' | (string & {});
declare const cohereEmbeddingModelOptions: z.ZodObject<{
    inputType: z.ZodOptional<z.ZodEnum<{
        search_document: "search_document";
        search_query: "search_query";
        classification: "classification";
        clustering: "clustering";
    }>>;
    truncate: z.ZodOptional<z.ZodEnum<{
        NONE: "NONE";
        START: "START";
        END: "END";
    }>>;
    outputDimension: z.ZodOptional<z.ZodUnion<readonly [z.ZodLiteral<256>, z.ZodLiteral<512>, z.ZodLiteral<1024>, z.ZodLiteral<1536>]>>;
}, z.core.$strip>;
type CohereEmbeddingModelOptions = z.infer<typeof cohereEmbeddingModelOptions>;

interface CohereProvider extends ProviderV3 {
    (modelId: CohereChatModelId): LanguageModelV3;
    /**
     * Creates a model for text generation.
     */
    languageModel(modelId: CohereChatModelId): LanguageModelV3;
    /**
     * Creates a model for text embeddings.
     */
    embedding(modelId: CohereEmbeddingModelId): EmbeddingModelV3;
    /**
     * Creates a model for text embeddings.
     */
    embeddingModel(modelId: CohereEmbeddingModelId): EmbeddingModelV3;
    /**
     * @deprecated Use `embedding` instead.
     */
    textEmbedding(modelId: CohereEmbeddingModelId): EmbeddingModelV3;
    /**
     * @deprecated Use `embeddingModel` instead.
     */
    textEmbeddingModel(modelId: CohereEmbeddingModelId): EmbeddingModelV3;
    /**
     * Creates a model for reranking.
     */
    reranking(modelId: CohereRerankingModelId): RerankingModelV3;
    /**
     * Creates a model for reranking.
     */
    rerankingModel(modelId: CohereRerankingModelId): RerankingModelV3;
}
interface CohereProviderSettings {
    /**
     * Use a different URL prefix for API calls, e.g. to use proxy servers.
     * The default prefix is `https://api.cohere.com/v2`.
     */
    baseURL?: string;
    /**
     * API key that is being send using the `Authorization` header.
     * It defaults to the `COHERE_API_KEY` environment variable.
     */
    apiKey?: string;
    /**
     * Custom headers to include in the requests.
     */
    headers?: Record<string, string>;
    /**
     * Custom fetch implementation. You can use it as a middleware to intercept requests,
     * or to provide a custom fetch implementation for e.g. testing.
     */
    fetch?: FetchFunction;
    /**
     * Optional function to generate a unique ID for each request.
     */
    generateId?: () => string;
}
/**
 * Create a Cohere AI provider instance.
 */
declare function createCohere(options?: CohereProviderSettings): CohereProvider;
/**
 * Default Cohere provider instance.
 */
declare const cohere: CohereProvider;

declare const VERSION: string;

export { type CohereLanguageModelOptions as CohereChatModelOptions, type CohereEmbeddingModelOptions, type CohereLanguageModelOptions, type CohereProvider, type CohereProviderSettings, type CohereRerankingModelOptions, type CohereRerankingModelOptions as CohereRerankingOptions, VERSION, cohere, createCohere };
