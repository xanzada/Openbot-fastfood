/**
 * Representation of the 'TntTenantInfo' schema.
 */
export type TntTenantInfo = {
    /**
     * tenant id
     * @example "aa97b177-9383-4934-8543-0f91a7a0283a"
     */
    tenantId: string;
    servicePlan: string;
    /**
     * Provisioning status of the tenant
     */
    status: string;
} & Record<string, any>;
//# sourceMappingURL=tnt-tenant-info.d.ts.map