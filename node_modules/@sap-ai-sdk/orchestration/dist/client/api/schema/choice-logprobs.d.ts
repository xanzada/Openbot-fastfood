import type { ChatCompletionTokenLogprob } from './chat-completion-token-logprob.js';
/**
 * Log probabilities for the choice.
 */
export type ChoiceLogprobs = {
    /**
     * A list of message content tokens with log probability information.
     */
    content?: ChatCompletionTokenLogprob[];
    /**
     * A list of message refusal tokens with log probability information.
     */
    refusal?: ChatCompletionTokenLogprob[];
} & Record<string, any>;
//# sourceMappingURL=choice-logprobs.d.ts.map