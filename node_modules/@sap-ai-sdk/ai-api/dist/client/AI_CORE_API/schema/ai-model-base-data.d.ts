import type { AiExecutableId } from './ai-executable-id.js';
import type { AiModelVersionList } from './ai-model-version-list.js';
import type { AiScenarioId } from './ai-scenario-id.js';
/**
 * Representation of the 'AiModelBaseData' schema.
 */
export type AiModelBaseData = {
    /**
     * Name of the model
     */
    model: string;
    executableId: AiExecutableId;
    /**
     * Description of the model and its capabilities
     */
    description: string;
    versions: AiModelVersionList;
    /**
     * Display name of the model
     */
    displayName?: string;
    /**
     * Access type of the model
     */
    accessType?: string;
    /**
     * Provider of the model
     */
    provider?: string;
    /**
     * List of scenarioId:executableId pair where the model supported
     */
    allowedScenarios?: ({
        scenarioId: AiScenarioId;
        executableId: AiExecutableId;
    } & Record<string, any>)[];
} & Record<string, any>;
//# sourceMappingURL=ai-model-base-data.d.ts.map