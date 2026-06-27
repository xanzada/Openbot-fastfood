import type { ServerSentEvent } from './sse-decoder.js';
import type { HttpResponse } from '@sap-cloud-sdk/http-client';
/**
 * Stream implemented as an async iterable.
 */
export declare class SseStream<Item> implements AsyncIterable<Item> {
    iterator: () => AsyncIterator<Item>;
    protected static transformToSseStream<Item>(response: HttpResponse, controller: AbortController): SseStream<Item>;
    controller: AbortController;
    constructor(iterator: () => AsyncIterator<Item>, controller: AbortController);
    [Symbol.asyncIterator](): AsyncIterator<Item>;
}
/**
 * @internal
 */
export declare function _iterSseMessages(response: HttpResponse, controller: AbortController): AsyncGenerator<ServerSentEvent, void, unknown>;
/**
 * This is an internal helper function that's just used for testing.
 * @param chunks - The chunks to decode.
 * @returns The decoded lines.
 * @internal
 */
export declare function _decodeChunks(chunks: string[]): string[];
//# sourceMappingURL=sse-stream.d.ts.map