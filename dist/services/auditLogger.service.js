const NEW_DLE_ACTIONS = new Set([
    "new_order",
    "status_changed",
    "request_payment",
    "order_rejected",
    "shift_note_created",
    "shift_note_deleted",
    // Kitchen state is handled by the same webhook and the same controller, so
    // leaving it out made a handled signal log matchesNewDleLogic=false.
    "update_kitchen_status",
    "get_kitchen_status",
]);
const SECRET_KEY_RE = /(token|secret|authorization|cookie|password|api[_-]?key|base64|mediaData|dataUrl)/i;
const PII_KEY_RE = /^(phone|to|from|address|text|body|payload|response)$/i;
function maskAuditPhone(value) { const v = String(value || "").replace(/\D/g, ""); return v.length > 6 ? `${v.slice(0, 3)}***${v.slice(-3)}` : v; }
function sanitizeAudit(value, key = "", depth = 0) {
    if (depth > 5)
        return "[Truncated]";
    if (SECRET_KEY_RE.test(key))
        return "[REDACTED]";
    if (typeof value === "string") {
        if (key.toLowerCase().includes("phone") || ["to", "from"].includes(key.toLowerCase()))
            return maskAuditPhone(value);
        // Already-redacted values pass through untouched. Without this a value that
        // was sanitized by an earlier audit call gets re-measured here and the log
        // reports 13 ("[REDACTED:51]".length) instead of the real 51 characters.
        if (/^\[REDACTED(?::\d+)?\]$/.test(value))
            return value;
        if (PII_KEY_RE.test(key))
            return `[REDACTED:${value.length}]`;
        return value.length > 500 ? `${value.slice(0, 500)}…` : value;
    }
    if (Array.isArray(value))
        return value.slice(0, 30).map((v) => sanitizeAudit(v, key, depth + 1));
    if (value && typeof value === "object")
        return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, sanitizeAudit(v, k, depth + 1)]));
    return value;
}
function safeStringify(value) {
    const seen = new WeakSet();
    try {
        return JSON.stringify(sanitizeAudit(value), (_key, nestedValue) => {
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
        ...sanitizeAudit(fields),
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
