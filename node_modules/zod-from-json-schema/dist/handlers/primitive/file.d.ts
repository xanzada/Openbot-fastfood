import type { JSONSchema } from "zod/v4/core";
import { PrimitiveHandler, TypeSchemas } from "../../core/types";
/**
 * Detects file schemas based on JSON Schema format
 * File schemas have: type: "string", format: "binary", contentEncoding: "binary"
 */
export declare class FileHandler implements PrimitiveHandler {
    apply(types: TypeSchemas, schema: JSONSchema.BaseSchema): void;
}
