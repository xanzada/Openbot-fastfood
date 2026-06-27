import { ProviderV3, LanguageModelV3, TranscriptionModelV3 } from '@ai-sdk/provider';
import * as _ai_sdk_provider_utils from '@ai-sdk/provider-utils';
import { InferSchema, FetchFunction } from '@ai-sdk/provider-utils';
import { z } from 'zod/v4';

type GroqChatModelId = 'gemma2-9b-it' | 'llama-3.1-8b-instant' | 'llama-3.3-70b-versatile' | 'meta-llama/llama-guard-4-12b' | 'openai/gpt-oss-120b' | 'openai/gpt-oss-20b' | 'deepseek-r1-distill-llama-70b' | 'meta-llama/llama-4-maverick-17b-128e-instruct' | 'meta-llama/llama-4-scout-17b-16e-instruct' | 'meta-llama/llama-prompt-guard-2-22m' | 'meta-llama/llama-prompt-guard-2-86m' | 'moonshotai/kimi-k2-instruct-0905' | 'qwen/qwen3-32b' | 'llama-guard-3-8b' | 'llama3-70b-8192' | 'llama3-8b-8192' | 'mixtral-8x7b-32768' | 'qwen-qwq-32b' | 'qwen-2.5-32b' | 'deepseek-r1-distill-qwen-32b' | (string & {});
declare const groqLanguageModelOptions: z.ZodObject<{
    reasoningFormat: z.ZodOptional<z.ZodEnum<{
        parsed: "parsed";
        raw: "raw";
        hidden: "hidden";
    }>>;
    reasoningEffort: z.ZodOptional<z.ZodEnum<{
        none: "none";
        default: "default";
        low: "low";
        medium: "medium";
        high: "high";
    }>>;
    parallelToolCalls: z.ZodOptional<z.ZodBoolean>;
    user: z.ZodOptional<z.ZodString>;
    structuredOutputs: z.ZodOptional<z.ZodBoolean>;
    strictJsonSchema: z.ZodOptional<z.ZodBoolean>;
    serviceTier: z.ZodOptional<z.ZodEnum<{
        on_demand: "on_demand";
        performance: "performance";
        flex: "flex";
        auto: "auto";
    }>>;
}, z.core.$strip>;
type GroqLanguageModelOptions = z.infer<typeof groqLanguageModelOptions>;

type GroqTranscriptionModelId = 'whisper-large-v3-turbo' | 'whisper-large-v3' | (string & {});
declare const groqTranscriptionModelOptions: _ai_sdk_provider_utils.LazySchema<{
    language?: string | null | undefined;
    prompt?: string | null | undefined;
    responseFormat?: string | null | undefined;
    temperature?: number | null | undefined;
    timestampGranularities?: string[] | null | undefined;
}>;
type GroqTranscriptionModelOptions = InferSchema<typeof groqTranscriptionModelOptions>;

declare const groqTools: {
    browserSearch: _ai_sdk_provider_utils.ProviderToolFactory<{}, {}>;
};

interface GroqProvider extends ProviderV3 {
    /**
     * Creates a model for text generation.
     */
    (modelId: GroqChatModelId): LanguageModelV3;
    /**
     * Creates an Groq chat model for text generation.
     */
    languageModel(modelId: GroqChatModelId): LanguageModelV3;
    /**
     * Creates a model for transcription.
     */
    transcription(modelId: GroqTranscriptionModelId): TranscriptionModelV3;
    /**
     * Tools provided by Groq.
     */
    tools: typeof groqTools;
    /**
     * @deprecated Use `embeddingModel` instead.
     */
    textEmbeddingModel(modelId: string): never;
}
interface GroqProviderSettings {
    /**
     * Base URL for the Groq API calls.
     */
    baseURL?: string;
    /**
     * API key for authenticating requests.
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
}
/**
 * Create an Groq provider instance.
 */
declare function createGroq(options?: GroqProviderSettings): GroqProvider;
/**
 * Default Groq provider instance.
 */
declare const groq: GroqProvider;

/**
 * Browser search tool for Groq models.
 *
 * Provides interactive browser search capabilities that go beyond traditional web search
 * by navigating websites interactively and providing more detailed results.
 *
 * Currently supported on:
 * - openai/gpt-oss-20b
 * - openai/gpt-oss-120b
 *
 * @see https://console.groq.com/docs/browser-search
 */
declare const browserSearch: _ai_sdk_provider_utils.ProviderToolFactory<{}, {}>;

declare const VERSION: string;

export { type GroqLanguageModelOptions, type GroqProvider, type GroqLanguageModelOptions as GroqProviderOptions, type GroqProviderSettings, type GroqTranscriptionModelOptions, VERSION, browserSearch, createGroq, groq };
