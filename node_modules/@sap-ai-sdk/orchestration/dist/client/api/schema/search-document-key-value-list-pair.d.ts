import type { SearchSelectOptionEnum } from './search-select-option-enum.js';
/**
 * Representation of the 'SearchDocumentKeyValueListPair' schema.
 */
export type SearchDocumentKeyValueListPair = {
    /**
     * Max Length: 1024.
     */
    key: string;
    value: string[];
    /**
     * Select mode for search filters
     */
    select_mode?: SearchSelectOptionEnum[];
};
//# sourceMappingURL=search-document-key-value-list-pair.d.ts.map