import type { DpiEntities } from './dpi-entities.js';
import type { DPIMethodConstant } from './dpi-method-constant.js';
import type { DPIMethodFabricatedData } from './dpi-method-fabricated-data.js';
/**
 * Representation of the 'DPIStandardEntity' schema.
 */
export type DPIStandardEntity = {
    type: DpiEntities;
    /**
     * Replacement strategy to be used for the entity
     */
    replacement_strategy?: DPIMethodConstant | DPIMethodFabricatedData;
};
//# sourceMappingURL=dpi-standard-entity.d.ts.map