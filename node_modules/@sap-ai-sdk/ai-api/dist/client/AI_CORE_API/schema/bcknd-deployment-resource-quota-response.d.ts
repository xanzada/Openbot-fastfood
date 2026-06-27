import type { BckndDeploymentUsage } from './bcknd-deployment-usage.js';
import type { BckndDeploymentQuotaItem } from './bcknd-deployment-quota-item.js';
/**
 * Representation of the 'BckndDeploymentResourceQuotaResponse' schema.
 */
export type BckndDeploymentResourceQuotaResponse = {
    usage?: BckndDeploymentUsage;
    quotas: BckndDeploymentQuotaItem[];
} & Record<string, any>;
//# sourceMappingURL=bcknd-deployment-resource-quota-response.d.ts.map