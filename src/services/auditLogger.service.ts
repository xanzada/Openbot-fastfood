const NEW_DLE_ACTIONS = new Set([
  "new_order",
  "status_changed",
  "request_payment",
  "order_rejected",
  "shift_note_created",
  "shift_note_deleted",
]);

type AuditStage = "INBOUND" | "PROCESSING" | "DECISION" | "OUTBOUND" | "ERROR";

function safeStringify(value: unknown): string {
  const seen = new WeakSet<object>();
  try {
    return JSON.stringify(value, (_key, nestedValue) => {
      if (typeof nestedValue === "object" && nestedValue !== null) {
        if (seen.has(nestedValue)) return "[Circular]";
        seen.add(nestedValue);
      }
      if (nestedValue instanceof Error) {
        return {
          name: nestedValue.name,
          message: nestedValue.message,
          stack: nestedValue.stack,
        };
      }
      return nestedValue;
    });
  } catch (error) {
    return JSON.stringify({
      stringify_error: error instanceof Error ? error.message : String(error),
      fallback: String(value),
    });
  }
}

function normalizeError(error: unknown) {
  if (error instanceof Error) {
    return {
      name: error.name,
      message: error.message,
      stack: error.stack,
    };
  }
  return { message: String(error || "unknown error") };
}

function emit(stage: AuditStage, message: string, fields: Record<string, unknown> = {}, error?: unknown) {
  const entry = {
    ts: new Date().toISOString(),
    stage,
    message,
    ...fields,
    ...(error === undefined ? {} : { error: normalizeError(error) }),
  };
  const line = `>>> [AUDIT: ${stage}] ${message} | ${safeStringify(entry)}`;
  if (stage === "ERROR") {
    console.error(line);
    return;
  }
  console.info(line);
}

export function isNewDleAction(action: unknown): boolean {
  return NEW_DLE_ACTIONS.has(String(action || "").trim());
}

export function auditInbound(message: string, fields: Record<string, unknown> = {}) {
  emit("INBOUND", message, fields);
}

export function auditProcessing(message: string, fields: Record<string, unknown> = {}) {
  emit("PROCESSING", message, fields);
}

export function auditDecision(message: string, fields: Record<string, unknown> = {}) {
  emit("DECISION", message, fields);
}

export function auditOutbound(message: string, fields: Record<string, unknown> = {}) {
  emit("OUTBOUND", message, fields);
}

export function auditError(message: string, error: unknown, fields: Record<string, unknown> = {}) {
  emit("ERROR", message, fields, error);
}
