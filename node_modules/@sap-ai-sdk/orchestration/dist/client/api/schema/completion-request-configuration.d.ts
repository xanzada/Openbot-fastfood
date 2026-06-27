import type { OrchestrationConfig } from './orchestration-config.js';
import type { ChatMessages } from './chat-messages.js';
/**
 * Representation of the 'CompletionRequestConfiguration' schema.
 */
export type CompletionRequestConfiguration = {
    config: OrchestrationConfig;
    /**
     * @example {
     *   "groundingInput": "What is SAP Joule?",
     *   "inputContext": "optimizing supply chain management"
     * }
     */
    placeholder_values?: Record<string, string>;
    /**
     * History of chat messages. Can be used to provide system and assistant messages to set the context of the conversation. Will be merged with the template message
     */
    messages_history?: ChatMessages;
};
//# sourceMappingURL=completion-request-configuration.d.ts.map