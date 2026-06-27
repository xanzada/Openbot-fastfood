import type { BckndGenericSecretLabels } from './bcknd-generic-secret-labels.js';
/**
 * Representation of the 'BckndGenericSecretDetails' schema.
 */
export type BckndGenericSecretDetails = {
    /**
     * Name of the secret
     */
    name: string;
    /**
     * Timestamp at which secret was created
     */
    createdAt: string;
    labels?: BckndGenericSecretLabels;
    /**
     * Sync status of the replicated secrets in all resource groups of the tenant
     */
    resourceGroupSecretsSyncStatus?: Record<string, boolean>;
} & Record<string, any>;
//# sourceMappingURL=bcknd-generic-secret-details.d.ts.map