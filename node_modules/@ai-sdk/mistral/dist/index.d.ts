import { ProviderV3, LanguageModelV3, EmbeddingModelV3 } from '@ai-sdk/provider';
import { FetchFunction } from '@ai-sdk/provider-utils';
import { z } from 'zod/v4';

type MistralChatModelId = 'ministral-3b-latest' | 'ministral-8b-latest' | 'ministral-14b-latest' | 'mistral-large-latest' | 'mistral-medium-latest' | 'mistral-medium-3' | 'mistral-large-2512' | 'mistral-medium-2508' | 'mistral-medium-2505' | 'mistral-small-2506' | 'pixtral-large-latest' | 'mistral-medium-3.5' | 'mistral-small-latest' | 'mistral-small-2603' | 'magistral-medium-latest' | 'magistral-small-latest' | 'magistral-medium-2509' | 'magistral-small-2509' | (string & {});
declare const mistralLanguageModelOptions: z.ZodObject<{
    safePrompt: z.ZodOptional<z.ZodBoolean>;
    documentImageLimit: z.ZodOptional<z.ZodNumber>;
    documentPageLimit: z.ZodOptional<z.ZodNumber>;
    structuredOutputs: z.ZodOptional<z.ZodBoolean>;
    strictJsonSchema: z.ZodOptional<z.ZodBoolean>;
    parallelToolCalls: z.ZodOptional<z.ZodBoolean>;
    reasoningEffort: z.ZodOptional<z.ZodEnum<{
        none: "none";
        high: "high";
    }>>;
}, z.core.$strip>;
type MistralLanguageModelOptions = z.infer<typeof mistralLanguageModelOptions>;

type MistralEmbeddingModelId = 'mistral-embed' | (string & {});

interface MistralProvider extends ProviderV3 {
    (modelId: MistralChatModelId): LanguageModelV3;
    /**
     * Creates a model for text generation.
     */
    languageModel(modelId: MistralChatModelId): LanguageModelV3;
    /**
     * Creates a model for text generation.
     */
    chat(modelId: MistralChatModelId): LanguageModelV3;
    /**
     * Creates a model for text embeddings.
     */
    embedding(modelId: MistralEmbeddingModelId): EmbeddingModelV3;
    /**
     * Creates a model for text embeddings.
     */
    embeddingModel: (modelId: MistralEmbeddingModelId) => EmbeddingModelV3;
    /**
     * @deprecated Use `embedding` instead.
     */
    textEmbedding(modelId: MistralEmbeddingModelId): EmbeddingModelV3;
    /**
     * @deprecated Use `embeddingModel` instead.
     */
    textEmbeddingModel(modelId: MistralEmbeddingModelId): EmbeddingModelV3;
}
interface MistralProviderSettings {
    /**
     * Use a different URL prefix for API calls, e.g. to use proxy servers.
     * The default prefix is `https://api.mistral.ai/v1`.
     */
    baseURL?: string;
    /**
     * API key that is being send using the `Authorization` header.
     * It defaults to the `MISTRAL_API_KEY` environment variable.
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
    generateId?: () => string;
}
/**
 * Create a Mistral AI provider instance.
 */
declare function createMistral(options?: MistralProviderSettings): MistralProvider;
/**
 * Default Mistral provider instance.
 */
declare const mistral: MistralProvider;

declare const VERSION: string;

export { type MistralLanguageModelOptions, type MistralProvider, type MistralProviderSettings, VERSION, createMistral, mistral };
