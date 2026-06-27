/**
 * Representation of the 'TemplateRefByScenarioNameVersion' schema.
 */
export type TemplateRefByScenarioNameVersion = {
    /**
     * Scenario name
     * @example "some-scenario"
     */
    scenario: string;
    /**
     * Name of the template
     * @example "some-template-name"
     */
    name: string;
    /**
     * Version of the template
     * @example "some version, can be `latest`"
     */
    version: string;
    /**
     * Defines the scope that is searched for the referenced template.  'tenant' indicates the template is shared across all resource groups within the tenant,  while 'resource_group' indicates the template is only accessible within the specific resource group.
     *
     * Default: "tenant".
     */
    scope?: 'resource_group' | 'tenant';
};
//# sourceMappingURL=template-ref-by-scenario-name-version.d.ts.map