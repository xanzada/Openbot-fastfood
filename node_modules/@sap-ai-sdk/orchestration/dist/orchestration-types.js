/**
 * Type guard to check if config is a config reference.
 * @param config - The config to check.
 * @returns Type predicate indicating whether the config is a config reference.
 */
export function isConfigReference(config) {
    return (typeof config === 'object' &&
        !Array.isArray(config) &&
        ('id' in config ||
            ('scenario' in config && 'name' in config && 'version' in config)));
}
/**
 * Validates and asserts that config is a valid list of orchestration module configs.
 * @internal
 * @param config - The config to validate.
 * @throws {Error} If config is not an array, is empty, or contains invalid elements.
 */
export function assertIsOrchestrationModuleConfigList(config) {
    if (!Array.isArray(config)) {
        throw new TypeError('Configuration must be an array for module fallback.');
    }
    if (config.length === 0) {
        throw new RangeError('Configuration array must not be empty.');
    }
    // Check if each element has the required promptTemplating property
    const allValid = config.every(item => item &&
        typeof item === 'object' &&
        'promptTemplating' in item &&
        item.promptTemplating &&
        typeof item.promptTemplating === 'object');
    if (!allValid) {
        throw new TypeError('Configuration array must contain valid OrchestrationModuleConfig objects with promptTemplating property.');
    }
}
/**
 * Type guard to check if config is a valid list of orchestration module configs.
 * @param config - The config to check.
 * @returns True if config is a non-empty array with valid OrchestrationModuleConfig elements.
 */
export function isOrchestrationModuleConfigList(config) {
    try {
        assertIsOrchestrationModuleConfigList(config);
        return true;
    }
    catch {
        return false;
    }
}
/**
 * A descriptive constant for Azure content safety filter threshold.
 * @internal
 */
export const supportedAzureFilterThresholds = {
    ALLOW_SAFE: 0,
    ALLOW_SAFE_LOW: 2,
    ALLOW_SAFE_LOW_MEDIUM: 4,
    ALLOW_ALL: 6
};
//# sourceMappingURL=orchestration-types.js.map