import { OpenApiRequestBuilder as CloudSDKOpenApiRequestBuilder } from '@sap-cloud-sdk/openapi';
import type { HttpDestinationOrFetchOptions } from '@sap-cloud-sdk/connectivity';
import type { OpenApiRequestParameters } from '@sap-cloud-sdk/openapi';
import type { HttpResponse, Method, CustomRequestConfig } from '@sap-cloud-sdk/http-client';
/**
 * Request builder for OpenAPI requests.
 * @template ResponseT - Type of the response for the request.
 */
export declare class OpenApiRequestBuilder<ResponseT> extends CloudSDKOpenApiRequestBuilder<ResponseT> {
    constructor(method: Method, pathPattern: string, parameters?: OpenApiRequestParameters, basePath?: string);
    /**
     * Execute request and get the response data. Use this to conveniently access the data of a service without technical information about the response.
     * @param destination - The destination to execute the request against.
     * @param requestConfig - Custom request configuration.
     * @returns A promise resolving to an HttpResponse.
     */
    executeRaw(destination?: HttpDestinationOrFetchOptions, requestConfig?: CustomRequestConfig): Promise<HttpResponse>;
    /**
     * Execute request and get the response data. Use this to conveniently access the data of a service without technical information about the response.
     * @param destination - The destination to execute the request against.
     * @param requestConfig - Custom request configuration.
     * @returns A promise resolving to the requested return type.
     */
    execute(destination?: HttpDestinationOrFetchOptions, requestConfig?: CustomRequestConfig): Promise<ResponseT>;
}
//# sourceMappingURL=openapi-request-builder.d.ts.map