const NEW_DLE_ACTIONS = /* @__PURE__ */ new Set([
  "new_order",
  "status_changed",
  "request_payment",
  "order_rejected",
  "shift_note_created",
  "shift_note_deleted"
]);
const SECRET_KEY_RE = /(token|secret|authorization|cookie|password|api[_-]?key|base64|mediaData|dataUrl)/i;
const PII_KEY_RE = /^(phone|to|from|address|text|body|payload|response)$/i;
function maskAuditPhone(value) {
  const v = String(value || "").replace(/\D/g, "");
  return v.length > 6 ? `${v.slice(0, 3)}***${v.slice(-3)}` : v;
}
function sanitizeAudit(value, key = "", depth = 0) {
  if (depth > 5) return "[Truncated]";
  if (SECRET_KEY_RE.test(key)) return "[REDACTED]";
  if (typeof value === "string") {
    if (key.toLowerCase().includes("phone") || ["to", "from"].includes(key.toLowerCase())) return maskAuditPhone(value);
    if (PII_KEY_RE.test(key)) return `[REDACTED:${value.length}]`;
    return value.length > 500 ? `${value.slice(0, 500)}\u2026` : value;
  }
  if (Array.isArray(value)) return value.slice(0, 30).map((v) => sanitizeAudit(v, key, depth + 1));
  if (value && typeof value === "object") return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, sanitizeAudit(v, k, depth + 1)]));
  return value;
}
function safeStringify(value) {
  const seen = /* @__PURE__ */ new WeakSet();
  try {
    return JSON.stringify(sanitizeAudit(value), (_key, nestedValue) => {
      if (typeof nestedValue === "object" && nestedValue !== null) {
        if (seen.has(nestedValue)) return "[Circular]";
        seen.add(nestedValue);
      }
      if (nestedValue instanceof Error) {
        return {
          name: nestedValue.name,
          message: nestedValue.message,
          stack: nestedValue.stack
        };
      }
      return nestedValue;
    });
  } catch (error) {
    return JSON.stringify({
      stringify_error: error instanceof Error ? error.message : String(error),
      fallback: String(value)
    });
  }
}
function normalizeError(error) {
  if (error instanceof Error) {
    return {
      name: error.name,
      message: error.message,
      stack: error.stack
    };
  }
  return { message: String(error || "unknown error") };
}
function emit(stage, message, fields = {}, error) {
  const entry = {
    ts: (/* @__PURE__ */ new Date()).toISOString(),
    stage,
    message,
    ...sanitizeAudit(fields),
    ...error === void 0 ? {} : { error: normalizeError(error) }
  };
  const line = `>>> [AUDIT: ${stage}] ${message} | ${safeStringify(entry)}`;
  if (stage === "ERROR") {
    console.error(line);
    return;
  }
  console.info(line);
}
function isNewDleAction(action) {
  return NEW_DLE_ACTIONS.has(String(action || "").trim());
}
function auditInbound(message, fields = {}) {
  emit("INBOUND", message, fields);
}
function auditProcessing(message, fields = {}) {
  emit("PROCESSING", message, fields);
}
function auditDecision(message, fields = {}) {
  emit("DECISION", message, fields);
}
function auditOutbound(message, fields = {}) {
  emit("OUTBOUND", message, fields);
}
function auditError(message, error, fields = {}) {
  emit("ERROR", message, fields, error);
}
export {
  auditDecision,
  auditError,
  auditInbound,
  auditOutbound,
  auditProcessing,
  isNewDleAction
};
