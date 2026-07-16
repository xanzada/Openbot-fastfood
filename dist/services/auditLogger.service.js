const NEW_DLE_ACTIONS = new Set([
    "new_order",
    "status_changed",
    "request_payment",
    "order_rejected",
    "shift_note_created",
    "shift_note_deleted",
]);
function safeStringify(value) {
    const seen = new WeakSet();
    try {
        return JSON.stringify(value, (_key, nestedValue) => {
            if (typeof nestedValue === "object" && nestedValue !== null) {
                if (seen.has(nestedValue))
                    return "[Circular]";
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
    }
    catch (error) {
        return JSON.stringify({
            stringify_error: error instanceof Error ? error.message : String(error),
            fallback: String(value),
        });
    }
}
function normalizeError(error) {
    if (error instanceof Error) {
        return {
            name: error.name,
            message: error.message,
            stack: error.stack,
        };
    }
    return { message: String(error || "unknown error") };
}
function emit(stage, message, fields = {}, error) {
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
export function isNewDleAction(action) {
    return NEW_DLE_ACTIONS.has(String(action || "").trim());
}
export function auditInbound(message, fields = {}) {
    emit("INBOUND", message, fields);
}
export function auditProcessing(message, fields = {}) {
    emit("PROCESSING", message, fields);
}
export function auditDecision(message, fields = {}) {
    emit("DECISION", message, fields);
}
export function auditOutbound(message, fields = {}) {
    emit("OUTBOUND", message, fields);
}
export function auditError(message, error, fields = {}) {
    emit("ERROR", message, fields, error);
}
