/**
 * @internal
 * Server-Sent Event, see {@link https://html.spec.whatwg.org/multipage/server-sent-events.html#server-sent-events}.
 */
export interface ServerSentEvent {
    /**
     * Name of the event if field name is `event`.
     */
    event: string | null;
    /**
     * Value of the data if field name is `data`.
     */
    data: string;
    /**
     * Raw string chunks. Each line is either in format `data: ...` or `event: ...`.
     */
    raw: string[];
}
/**
 * Server-Sent Event decoder.
 */
export declare class SSEDecoder {
    private data;
    private event;
    private chunks;
    constructor();
    /**
     * Decode the line into structured server sent event.
     * @param line - Line to decode.
     * @returns Server sent event if the line is empty meaning the end of the received event, or null if there are more lines to come.
     */
    decode(line: string): ServerSentEvent | null;
}
//# sourceMappingURL=sse-decoder.d.ts.map