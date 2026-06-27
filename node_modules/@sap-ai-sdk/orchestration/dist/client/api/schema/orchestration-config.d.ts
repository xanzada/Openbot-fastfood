import type { ModuleConfigs } from './module-configs.js';
import type { ModuleConfigsList } from './module-configs-list.js';
import type { GlobalStreamOptions } from './global-stream-options.js';
/**
 * Representation of the 'OrchestrationConfig' schema.
 */
export type OrchestrationConfig = {
    modules: ModuleConfigs | ModuleConfigsList;
    stream?: GlobalStreamOptions;
};
//# sourceMappingURL=orchestration-config.d.ts.map