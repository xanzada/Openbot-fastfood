import type { AzureThreshold } from './azure-threshold.js';
/**
 * Filter configuration for Azure Content Safety
 */
export type AzureContentSafetyInput = {
    hate?: AzureThreshold;
    self_harm?: AzureThreshold;
    sexual?: AzureThreshold;
    violence?: AzureThreshold;
    /**
     * Filter prompts for harmful content such as jailbreaks and prompt injections.
     */
    prompt_shield?: boolean;
};
//# sourceMappingURL=azure-content-safety-input.d.ts.map