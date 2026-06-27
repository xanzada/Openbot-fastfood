import type { ChatMessageContent } from './chat-message-content.js';
import type { MessageToolCalls } from './message-tool-calls.js';
/**
 * Representation of the 'AssistantChatMessage' schema.
 */
export type AssistantChatMessage = {
    role: 'assistant';
    content?: ChatMessageContent;
    refusal?: string;
    tool_calls?: MessageToolCalls;
};
//# sourceMappingURL=assistant-chat-message.d.ts.map