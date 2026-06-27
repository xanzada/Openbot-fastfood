import { SseStream } from '@sap-ai-sdk/core';
import { OrchestrationStreamChunkResponse } from './orchestration-stream-chunk-response.js';
import type { CompletionPostResponseStreaming } from './client/api/schema/index.js';
import type { HttpResponse } from '@sap-cloud-sdk/http-client';
import type { OrchestrationStreamResponse } from './orchestration-stream-response.js';
/**
 * Orchestration stream containing post-processing functions.
 */
export declare class OrchestrationStream<Item> extends SseStream<Item> {
    iterator: () => AsyncIterator<Item>;
    /**
     * Create an orchestration stream based on the http response.
     * @param response - Http response.
     * @returns An orchestration stream.
     * @internal
     */
    static _create(response: HttpResponse, controller: AbortController): OrchestrationStream<CompletionPostResponseStreaming>;
    /**
     * Wrap raw chunk data with chunk response class to provide helper functions.
     * @param stream - Orchestration stream.
     * @internal
     */
    static _processChunk(stream: OrchestrationStream<CompletionPostResponseStreaming>): AsyncGenerator<OrchestrationStreamChunkResponse>;
    static _processOrchestrationStreamChunkResponse(stream: OrchestrationStream<OrchestrationStreamChunkResponse>, response?: OrchestrationStreamResponse<OrchestrationStreamChunkResponse>): AsyncGenerator<OrchestrationStreamChunkResponse>;
    static _processStreamEnd(stream: OrchestrationStream<OrchestrationStreamChunkResponse>, response?: OrchestrationStreamResponse<OrchestrationStreamChunkResponse>): AsyncGenerator<OrchestrationStreamChunkResponse>;
    /**
     * Transform a stream of chunks into a stream of content strings.
     * @param stream - Orchestration stream.
     * @param choiceIndex - The index of the choice to parse.
     * @internal
     */
    static _processContentStream(stream: OrchestrationStream<OrchestrationStreamChunkResponse>): AsyncGenerator<string>;
    constructor(iterator: () => AsyncIterator<Item>, controller: AbortController);
    /**
     * Pipe the stream through a processing function.
     * @param processFn - The function to process the input stream.
     * @param response - The `OrchestrationStreamResponse` object for process function to store finish reason, token usage, etc.
     * @returns The output stream containing processed items.
     * @internal
     */
    _pipe<TReturn>(processFn: (stream: OrchestrationStream<Item>, response?: OrchestrationStreamResponse<OrchestrationStreamChunkResponse>) => AsyncIterator<TReturn>, response?: OrchestrationStreamResponse<OrchestrationStreamChunkResponse>): OrchestrationStream<TReturn>;
    /**
     * Transform the stream of chunks into a stream of content strings.
     * @param this - Orchestration stream.
     * @returns A stream of content strings.
     */
    toContentStream(this: OrchestrationStream<OrchestrationStreamChunkResponse>): OrchestrationStream<string>;
}
//# sourceMappingURL=orchestration-stream.d.ts.map