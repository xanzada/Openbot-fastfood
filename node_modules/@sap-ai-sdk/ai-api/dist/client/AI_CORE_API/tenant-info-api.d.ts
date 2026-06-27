import { OpenApiRequestBuilder } from '@sap-ai-sdk/core';
import type { TntTenantInfo } from './schema/index.js';
/**
 * Representation of the 'TenantInfoApi'.
 * This API is part of the 'AI_CORE_API' service.
 */
export declare const TenantInfoApi: {
    _defaultBasePath: undefined;
    /**
     * Tenant information containing the service plan that the tenant is subscribed to.
     * @returns The request builder, use the `execute()` method to trigger the request.
     */
    tenantInfoGet: () => OpenApiRequestBuilder<TntTenantInfo>;
};
//# sourceMappingURL=tenant-info-api.d.ts.map