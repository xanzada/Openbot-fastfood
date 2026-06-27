import type { ErrorStreaming } from './error-streaming.js';
import type { ErrorStreamingList } from './error-streaming-list.js';
/**
 * Representation of the 'ErrorResponseStreaming' schema.
 */
export type ErrorResponseStreaming = {
    error: ErrorStreaming | ErrorStreamingList;
} & Record<string, any>;
//# sourceMappingURL=error-response-streaming.d.ts.map