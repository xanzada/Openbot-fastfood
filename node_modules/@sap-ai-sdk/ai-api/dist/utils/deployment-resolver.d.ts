import { type AiDeployment } from '../client/AI_CORE_API/index.js';
import { type FoundationModel } from './model.js';
import type { HttpDestinationOrFetchOptions } from '@sap-cloud-sdk/connectivity';
/**
 * The model deployment configuration when using a model.
 * @template ModelNameT - String literal type representing the name of the model.
 */
export interface ModelConfig<ModelNameT = string> {
    /**
     * The name of the model.
     */
    modelName: ModelNameT;
    /**
     * The version of the model.
     */
    modelVersion?: string;
}
/**
 * The deployment configuration when using a deployment ID.
 */
export interface DeploymentIdConfig {
    /**
     * The deployment ID.
     */
    deploymentId: string;
}
/**
 * The deployment configuration when using a resource group.
 */
export interface ResourceGroupConfig {
    /**
     * The resource group of the deployment.
     */
    resourceGroup?: string;
}
/**
 * The configuration of a model deployment.
 * @template ModelNameT - String literal type representing the name of the model.
 */
export type ModelDeployment<ModelNameT = string> = ModelNameT | ((ModelConfig<ModelNameT> | DeploymentIdConfig) & ResourceGroupConfig);
/**
 * @internal
 */
export declare function getResourceGroup(modelDeployment: ModelDeployment): string | undefined;
/**
 * The options for the deployment resolution.
 * @internal
 */
export interface DeploymentResolutionOptions {
    /**
     * The scenario ID of the deployment.
     */
    scenarioId: string;
    /**
     * The name and potentially version of the model to look for.
     */
    model?: FoundationModel;
    /**
     * The executable ID of the deployment.
     */
    executableId?: string;
    /**
     * The resource group of the deployment.
     */
    resourceGroup?: string;
    /**
     * The destination to use for the request.
     */
    destination?: HttpDestinationOrFetchOptions;
}
/**
 * Query the AI Core service for a deployment that matches the given criteria.
 * If more than one deployment matches the criteria, the first one's ID is returned.
 * @param opts - The options for the deployment resolution.
 * @returns A promise of a deployment, if a deployment was found, fails otherwise.
 * @internal
 */
export declare function resolveDeployment(opts: DeploymentResolutionOptions): Promise<AiDeployment>;
/**
 * Type guard to check if the model deployment is a deployment ID config.
 * @param modelDeployment - The model deployment configuration.
 * @returns Whether the model deployment is a deployment ID config.
 * @internal
 */
export declare function isDeploymentIdConfig(modelDeployment: ModelDeployment | ResourceGroupConfig): modelDeployment is {
    deploymentId: string;
};
/**
 * Query the AI Core service for a deployment that matches the given criteria.
 * If more than one deployment matches the criteria, the first one's ID is returned.
 * @param opts - The options for the deployment resolution.
 * @returns A promise of a deployment, if a deployment was found, fails otherwise.
 * @internal
 */
export declare function resolveDeploymentId(opts: DeploymentResolutionOptions): Promise<string>;
/**
 * Query the AI Core service for a deployment that matches the given criteria.
 * If more than one deployment matches the criteria, the first one's URL is returned.
 * @param opts - The options for the deployment resolution.
 * @returns A promise of the deployment URL, if a deployment was found, fails otherwise.
 */
export declare function resolveDeploymentUrl(opts: DeploymentResolutionOptions): Promise<string | undefined>;
/**
 * Get all deployments that match the given criteria.
 * @param opts - The options for the deployment resolution.
 * @returns A promise of an array of deployments.
 * @internal
 */
export declare function getAllDeployments(opts: DeploymentResolutionOptions): Promise<AiDeployment[]>;
/**
 * Get the deployment ID for a foundation model scenario.
 * @param modelDeployment - This configuration is used to retrieve a deployment. Depending on the configuration use either the given deployment ID or the model name to retrieve matching deployments. If model and deployment ID are given, the model is verified against the deployment.
 * @param executableId - The scenario ID.
 * @param destination - The destination to use for the request.
 * @returns The ID of the deployment, if found.
 * @internal
 */
export declare function getFoundationModelDeploymentId(modelDeployment: ModelDeployment, executableId: string, destination?: HttpDestinationOrFetchOptions): Promise<string>;
/**
 * Get the deployment ID for an orchestration scenario.
 * @param deploymentConfig - The deployment configuration (resource group or deployment ID).
 * @param destination - The destination to use for the request.
 * @returns The ID of the deployment, if found.
 * @internal
 */
export declare function getOrchestrationDeploymentId(deploymentConfig: ResourceGroupConfig | DeploymentIdConfig, destination?: HttpDestinationOrFetchOptions): Promise<string>;
//# sourceMappingURL=deployment-resolver.d.ts.map