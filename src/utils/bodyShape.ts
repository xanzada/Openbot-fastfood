/**
 * Keys and value types only — never values. A real order.created was thrown away
 * with `invalid phone` and nothing in the logs said what hub had actually sent,
 * because no raw body is logged anywhere. This is the smallest thing that makes
 * the next unknown field name visible without putting guest data in the log.
 *
 * Lives in utils (not in the route) so the kanban controller can log the same
 * shape on BAD_ACTION without importing the route that imports it.
 */
export function describeBodyShape(value: unknown, depth = 0): string {
  if (Array.isArray(value)) {
    return depth >= 2 ? "array" : `array<${value.length ? describeBodyShape(value[0], depth + 1) : "empty"}>`;
  }
  if (value && typeof value === "object") {
    if (depth >= 2) return "object";
    return `{${Object.entries(value as Record<string, any>)
      .slice(0, 60)
      .map(([key, item]) => `${key}:${describeBodyShape(item, depth + 1)}`)
      .join(",")}}`;
  }
  return value === null ? "null" : typeof value;
}
