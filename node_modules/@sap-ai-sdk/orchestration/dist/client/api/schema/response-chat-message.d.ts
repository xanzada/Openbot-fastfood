import type { MessageToolCalls } from './message-tool-calls.js';
/**
 * Representation of the 'ResponseChatMessage' schema.
 */
export type ResponseChatMessage = {
    role: 'assistant';
    content?: string;
    refusal?: string;
    tool_calls?: MessageToolCalls;
};
//# sourceMappingURL=response-chat-message.d.ts.map