import type { BckndArgoCDApplicationDataResponse } from './bcknd-argo-cd-application-data-response.js';
/**
 * list of applications
 */
export type BckndAllArgoCDApplicationData = {
    /**
     * Number of the resource instances in the list
     */
    count: number;
    resources: BckndArgoCDApplicationDataResponse[];
} & Record<string, any>;
//# sourceMappingURL=bcknd-all-argo-cd-application-data.d.ts.map