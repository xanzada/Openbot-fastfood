import type { AzureContentSafetyFilterParameters, AzureContentSafetyFilterReturnType, LlamaGuard38BCategory, LlamaGuard38BFilterReturnType, ConfigType } from '../orchestration-types.js';
/**
 * Convenience function to build Azure content filter.
 * @param type - Type of the filter, either 'input' or 'output'.
 * @param config - Configuration for Azure content safety filter.
 * If skipped, the default configuration of `ALLOW_SAFE_LOW` is used for all filter categories.
 * @returns Azure content safety configuration.
 * @example "buildAzureContentSafetyFilter('input', { hate: 'ALLOW_SAFE', violence: 'ALLOW_SAFE_LOW_MEDIUM' })"
 */
export declare function buildAzureContentSafetyFilter<T extends ConfigType>(type: T, config?: AzureContentSafetyFilterParameters<T>): AzureContentSafetyFilterReturnType<T>;
/**
 * Convenience function to build Llama Guard 3 8B filter.
 * @param type - Type of the filter, either `input` or `output`.
 * @param categories - Categories to be enabled for filtering. Provide at least one category.
 * @returns Llama Guard 3 8B filter configuration.
 * @example buildLlamaGuard38BFilter('input', ['elections', 'hate'])
 */
export declare function buildLlamaGuard38BFilter<T extends ConfigType>(type: T, categories: [LlamaGuard38BCategory, ...LlamaGuard38BCategory[]]): LlamaGuard38BFilterReturnType<T>;
//# sourceMappingURL=filtering.d.ts.map