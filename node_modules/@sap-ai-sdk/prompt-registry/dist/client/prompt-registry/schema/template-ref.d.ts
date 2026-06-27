import type { TemplateRefByID } from './template-ref-by-id.js';
import type { TemplateRefByScenarioNameVersion } from './template-ref-by-scenario-name-version.js';
/**
 * Representation of the 'TemplateRef' schema.
 */
export type TemplateRef = {
    /**
     * Reference to a template in the prompt registry by ID or by scenario, name and version
     */
    template_ref: TemplateRefByID | TemplateRefByScenarioNameVersion;
};
//# sourceMappingURL=template-ref.d.ts.map