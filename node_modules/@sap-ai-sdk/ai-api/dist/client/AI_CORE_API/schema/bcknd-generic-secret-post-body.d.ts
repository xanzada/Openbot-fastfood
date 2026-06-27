import type { BckndGenericSecretData } from './bcknd-generic-secret-data.js';
import type { BckndGenericSecretLabels } from './bcknd-generic-secret-labels.js';
/**
 * Representation of the 'BckndGenericSecretPostBody' schema.
 */
export type BckndGenericSecretPostBody = {
    /**
     * The name of the secret
     * Max Length: 252.
     * Min Length: 1.
     * Pattern: "^[a-z0-9\\-\\.]+$".
     */
    name: string;
    data: BckndGenericSecretData;
    labels?: BckndGenericSecretLabels;
} & Record<string, any>;
//# sourceMappingURL=bcknd-generic-secret-post-body.d.ts.map