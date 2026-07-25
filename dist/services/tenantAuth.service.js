import crypto from "node:crypto";
function safeCompare(a, b) {
  const left = Buffer.from(String(a || ""), "utf8");
  const right = Buffer.from(String(b || ""), "utf8");
  if (left.length === 0 || right.length === 0 || left.length !== right.length) {
    return false;
  }
  return crypto.timingSafeEqual(left, right);
}
function getIncomingTenantSecret(req) {
  return req.headers["x-tenant-key"] || req.headers["x-instance-key"] || req.headers["x-restaurant-key"] || req.body?.tenant_secret || req.body?.instance_secret || req.body?.restaurant_secret;
}
function getTenantSecret(config, channel = "webhook") {
  if (!config) return "";
  if (channel === "kanban") {
    return config.kanban_secret || config.crm_webhook_secret || config.webhook_secret || config.instance_secret || config.tenant_secret || "";
  }
  return config.webhook_secret || config.instance_secret || config.tenant_secret || "";
}
function assertTenantSecret(req, config, channel = "webhook") {
  const expected = getTenantSecret(config, channel);
  const incoming = getIncomingTenantSecret(req);
  if (!expected) {
    const error = new Error("TENANT_SECRET_NOT_CONFIGURED");
    error.statusCode = 500;
    throw error;
  }
  if (!safeCompare(incoming, expected)) {
    const error = new Error("INVALID_TENANT_SECRET");
    error.statusCode = 403;
    throw error;
  }
}
export {
  assertTenantSecret,
  getIncomingTenantSecret,
  getTenantSecret,
  safeCompare
};
