import crypto from "node:crypto";

export function safeCompare(a: unknown, b: unknown): boolean {
  const left = Buffer.from(String(a || ""), "utf8");
  const right = Buffer.from(String(b || ""), "utf8");

  if (left.length === 0 || right.length === 0 || left.length !== right.length) {
    return false;
  }

  return crypto.timingSafeEqual(left, right);
}

function scalarSecret(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}

export function getIncomingTenantSecret(req: any) {
  const candidates = [
    req?.headers?.["x-tenant-key"],
    req?.headers?.["x-instance-key"],
    req?.headers?.["x-restaurant-key"],
    req?.body?.tenant_secret,
    req?.body?.instance_secret,
    req?.body?.restaurant_secret,
    // The Alemi site currently delivers its tenant credential as ?token=.
    // Only a scalar string is accepted so repeated/object query parameters
    // cannot be coerced into an authorization value.
    req?.query?.token,
  ];

  for (const candidate of candidates) {
    const secret = scalarSecret(candidate);
    if (secret) return secret;
  }
  return "";
}

function getTenantSecrets(config: Record<string, any> | null | undefined, channel = "webhook") {
  if (!config) return [];

  const values = channel === "kanban"
    ? [
        config.kanban_secret,
        config.alemi_secret,
        config.secret_key,
        config.crm_secret_token,
        config.crm_webhook_secret,
        config.webhook_secret,
        config.instance_secret,
        config.tenant_secret,
        process.env.ALEMI_SECRET,
      ]
    : [config.webhook_secret, config.instance_secret, config.tenant_secret];

  return [...new Set(values.map(scalarSecret).filter(Boolean))];
}

export function getTenantSecret(config: Record<string, any> | null | undefined, channel = "webhook") {
  return getTenantSecrets(config, channel)[0] || "";
}

export function assertTenantSecret(req: any, config: Record<string, any> | null | undefined, channel = "webhook") {
  const expected = getTenantSecrets(config, channel);
  const incoming = getIncomingTenantSecret(req);

  if (!expected.length) {
    const error: any = new Error("TENANT_SECRET_NOT_CONFIGURED");
    error.statusCode = 500;
    throw error;
  }

  let matches = false;
  for (const candidate of expected) {
    // Compare every configured candidate so timing does not reveal which
    // tenant-secret alias is active for this restaurant.
    matches = safeCompare(incoming, candidate) || matches;
  }
  if (!matches) {
    const error: any = new Error("INVALID_TENANT_SECRET");
    error.statusCode = 403;
    throw error;
  }
}
