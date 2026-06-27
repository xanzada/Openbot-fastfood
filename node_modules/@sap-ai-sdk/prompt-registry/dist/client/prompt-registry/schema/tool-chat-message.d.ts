import type { ChatMessageContent } from './chat-message-content.js';
/**
 * Representation of the 'ToolChatMessage' schema.
 */
export type ToolChatMessage = {
    /**
     * @example "tool"
     */
    role: 'tool';
    tool_call_id: string;
    content: ChatMessageContent;
};
//# sourceMappingURL=tool-chat-message.d.ts.map