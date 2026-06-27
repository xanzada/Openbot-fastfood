import type { FunctionObject } from './function-object.js';
/**
 * Representation of the 'ChatCompletionTool' schema.
 */
export type ChatCompletionTool = {
    /**
     * The type of the tool. Currently, only `function` is supported.
     */
    type: 'function';
    function: FunctionObject;
};
//# sourceMappingURL=chat-completion-tool.d.ts.map