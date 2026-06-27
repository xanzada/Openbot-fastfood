import { ProviderV3, LanguageModelV3 } from '@ai-sdk/provider';
import { FetchFunction } from '@ai-sdk/provider-utils';
import { z } from 'zod/v4';

type DeepSeekChatModelId = 'deepseek-chat' | 'deepseek-reasoner' | (string & {});
declare const deepseekLanguageModelOptions: z.ZodObject<{
    thinking: z.ZodOptional<z.ZodObject<{
        type: z.ZodOptional<z.ZodEnum<{
            adaptive: "adaptive";
            enabled: "enabled";
            disabled: "disabled";
        }>>;
    }, z.core.$strip>>;
    reasoningEffort: z.ZodOptional<z.ZodEnum<{
        low: "low";
        medium: "medium";
        high: "high";
        xhigh: "xhigh";
        max: "max";
    }>>;
}, z.core.$strip>;
type DeepSeekLanguageModelOptions = z.infer<typeof deepseekLanguageModelOptions>;

interface DeepSeekProviderSettings {
    /**
     * DeepSeek API key.
     */
    apiKey?: string;
    /**
     * Base URL for the API calls.
     */
    baseURL?: string;
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
interface DeepSeekProvider extends ProviderV3 {
    /**
     * Creates a DeepSeek model for text generation.
     */
    (modelId: DeepSeekChatModelId): LanguageModelV3;
    /**
     * Creates a DeepSeek model for text generation.
     */
    languageModel(modelId: DeepSeekChatModelId): LanguageModelV3;
    /**
     * Creates a DeepSeek chat model for text generation.
     */
    chat(modelId: DeepSeekChatModelId): LanguageModelV3;
    /**
     * @deprecated Use `embeddingModel` instead.
     */
    textEmbeddingModel(modelId: string): never;
}
declare function createDeepSeek(options?: DeepSeekProviderSettings): DeepSeekProvider;
declare const deepseek: DeepSeekProvider;

declare const VERSION: string;

declare const deepSeekErrorSchema: z.ZodObject<{
    error: z.ZodObject<{
        message: z.ZodString;
        type: z.ZodOptional<z.ZodNullable<z.ZodString>>;
        param: z.ZodOptional<z.ZodNullable<z.ZodAny>>;
        code: z.ZodOptional<z.ZodNullable<z.ZodUnion<readonly [z.ZodString, z.ZodNumber]>>>;
    }, z.core.$strip>;
}, z.core.$strip>;
type DeepSeekErrorData = z.infer<typeof deepSeekErrorSchema>;

export { type DeepSeekLanguageModelOptions as DeepSeekChatOptions, type DeepSeekErrorData, type DeepSeekLanguageModelOptions, type DeepSeekProvider, type DeepSeekProviderSettings, VERSION, createDeepSeek, deepseek };
