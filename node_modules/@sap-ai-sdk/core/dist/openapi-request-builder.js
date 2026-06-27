import { OpenApiRequestBuilder as CloudSDKOpenApiRequestBuilder } from '@sap-cloud-sdk/openapi';
import { executeRequest } from './http-client.js';
/**
 * Request builder for OpenAPI requests.
 * @template ResponseT - Type of the response for the request.
 */
export class OpenApiRequestBuilder extends CloudSDKOpenApiRequestBuilder {
    constructor(method, pathPattern, parameters, basePath) {
        super(method, pathPattern, parameters, basePath);
    }
    /**
     * Execute request and get the response data. Use this to conveniently access the data of a service without technical information about the response.
     * @param destination - The destination to execute the request against.
     * @param requestConfig - Custom request configuration.
     * @returns A promise resolving to an HttpResponse.
     */
    async executeRaw(destination, requestConfig) {
        const { url, data, ...rest } = await this.requestConfig();
        // TODO: Remove explicit url! once we updated the type in the Cloud SDK, since url is always defined.
        return executeRequest({ url: url }, data, {
            ...rest,
            ...requestConfig,
            headers: {
                ...rest.headers?.requestConfig,
                ...rest.headers?.custom,
                ...requestConfig?.headers
            },
            params: {
                ...rest.params?.requestConfig,
                ...rest.params?.custom,
                ...requestConfig?.params
            }
        }, destination);
    }
    /**
     * Execute request and get the response data. Use this to conveniently access the data of a service without technical information about the response.
     * @param destination - The destination to execute the request against.
     * @param requestConfig - Custom request configuration.
     * @returns A promise resolving to the requested return type.
     */
    async execute(destination, requestConfig) {
        const response = await this.executeRaw(destination, requestConfig);
        if ('data' in response) {
            return response.data;
        }
        throw new Error('Could not access response data. Response was not an axios response.');
    }
}
//# sourceMappingURL=openapi-request-builder.js.map