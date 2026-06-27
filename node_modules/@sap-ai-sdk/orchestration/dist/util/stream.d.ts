import type { OrchestrationStreamChunkResponse } from '../orchestration-stream-chunk-response.js';
import type { OrchestrationStreamResponse } from '../orchestration-stream-response.js';
import type { CompletionPostResponseStreaming } from '../client/api/schema/index.js';
/**
 * @internal
 */
export declare function mergeStreamResponse(response: OrchestrationStreamResponse<OrchestrationStreamChunkResponse>, chunk: CompletionPostResponseStreaming): void;
//# sourceMappingURL=stream.d.ts.map