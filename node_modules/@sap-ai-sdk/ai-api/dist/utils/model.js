function isFoundationModel(model) {
    return typeof model === 'object' && 'name' in model;
}
/**
 * Get the model information from a deployment.
 * @param deployment - AI core model deployment.
 * @returns The model information.
 * @internal
 */
export function extractModel(deployment) {
    const model = deployment.details?.resources?.backendDetails?.model;
    if (isFoundationModel(model)) {
        return model;
    }
}
/**
 * Translate a model configuration to a foundation model.
 * @param modelConfig - Representation of a model.
 * @returns The model as foundation model.
 * @internal
 */
export function translateToFoundationModel(modelConfig) {
    if (typeof modelConfig === 'string') {
        return { name: modelConfig };
    }
    return {
        name: modelConfig.modelName,
        ...(modelConfig.modelVersion && { version: modelConfig.modelVersion })
    };
}
//# sourceMappingURL=model.js.map