import type { Error } from './error.js';
import type { ErrorList } from './error-list.js';
/**
 * Representation of the 'ErrorResponse' schema.
 */
export type ErrorResponse = {
    error: Error | ErrorList;
} & Record<string, any>;
//# sourceMappingURL=error-response.d.ts.map