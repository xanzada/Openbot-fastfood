import type { ResponseFormatJsonSchemaSchema } from './response-format-json-schema-schema.js';
/**
 * Representation of the 'ResponseFormatJsonSchema' schema.
 */
export type ResponseFormatJsonSchema = {
    /**
     * The type of response format being defined: `json_schema`
     */
    type: 'json_schema';
    json_schema: {
        /**
         * A description of what the response format is for, used by the model to determine how to respond in the format.
         */
        description?: string;
        /**
         * The name of the response format. Must be a-z, A-Z, 0-9, or contain underscores and dashes, with a maximum length of 64.
         * Max Length: 64.
         * Pattern: "^[a-zA-Z0-9-_]+$".
         */
        name: string;
        schema?: ResponseFormatJsonSchemaSchema;
        /**
         * Whether to enable strict schema adherence when generating the output. If set to true, the model will always follow the exact schema defined in the `schema` field. Only a subset of JSON Schema is supported when `strict` is `true`. To learn more, read the [Structured Outputs guide](https://platform.openai.com/docs/guides/structured-outputs).
         */
        strict?: boolean | null;
    };
};
//# sourceMappingURL=response-format-json-schema.d.ts.map