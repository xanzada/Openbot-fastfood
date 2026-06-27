/**
 * Server-Sent Event decoder.
 */
export class SSEDecoder {
    data;
    event;
    chunks;
    constructor() {
        this.event = null;
        this.data = [];
        this.chunks = [];
    }
    /**
     * Decode the line into structured server sent event.
     * @param line - Line to decode.
     * @returns Server sent event if the line is empty meaning the end of the received event, or null if there are more lines to come.
     */
    decode(line) {
        if (line.endsWith('\r')) {
            line = line.substring(0, line.length - 1);
        }
        if (!line) {
            // empty line and we didn't previously encounter any messages
            if (!this.event && !this.data.length) {
                return null;
            }
            const sse = {
                event: this.event,
                data: this.data.join('\n'),
                raw: this.chunks
            };
            this.event = null;
            this.data = [];
            this.chunks = [];
            return sse;
        }
        this.chunks.push(line);
        if (line.startsWith(':')) {
            return null;
        }
        const [fieldname, _, value] = partition(line, ':');
        const trimedValue = value.startsWith(' ') ? value.substring(1) : value;
        if (fieldname === 'event') {
            this.event = trimedValue;
        }
        else if (fieldname === 'data') {
            this.data.push(trimedValue);
        }
        else {
            throw new Error(`Invalid SSE payload: ${line}`);
        }
        return null;
    }
}
function partition(str, delimiter) {
    const index = str.indexOf(delimiter);
    if (index !== -1) {
        return [
            str.substring(0, index),
            delimiter,
            str.substring(index + delimiter.length)
        ];
    }
    return [str, '', ''];
}
//# sourceMappingURL=sse-decoder.js.map