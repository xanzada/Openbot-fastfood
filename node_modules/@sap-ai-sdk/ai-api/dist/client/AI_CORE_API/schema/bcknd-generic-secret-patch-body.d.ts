import type { BckndGenericSecretData } from './bcknd-generic-secret-data.js';
import type { BckndGenericSecretLabels } from './bcknd-generic-secret-labels.js';
/**
 * Representation of the 'BckndGenericSecretPatchBody' schema.
 */
export type BckndGenericSecretPatchBody = {
    data: BckndGenericSecretData;
    labels?: BckndGenericSecretLabels;
} & Record<string, any>;
//# sourceMappingURL=bcknd-generic-secret-patch-body.d.ts.map