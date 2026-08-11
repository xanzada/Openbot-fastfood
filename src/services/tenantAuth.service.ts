import crypto from "node:crypto";
import { auditDecision } from "./auditLogger.service.js";

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

  // The kanban webhook only ever presents the Alemi Secret Key, so it must not
  // accept credentials issued for other integrations (CRM tokens, the DLE
  // secret_key, the generic webhook secrets) as an authorization value.
  // kanban_secret is retired: WhatsPro auto-generated it for itself and rotates
  // it silently, so the hub never holds it and it can no longer authorize.
  const values = channel === "kanban"
    ? [config.alemi_secret]
    : [config.webhook_secret, config.instance_secret, config.tenant_secret];

  return [...new Set(values.map(scalarSecret).filter(Boolean))];
}

function alemiEnvironmentSecret(instanceId: unknown) {
  const instance = String(instanceId || "").trim();
  if (!instance) return "";
  try {
    const parsed = JSON.parse(String(process.env.ALEMI_TENANT_SECRETS_JSON || "{}"));
    const candidate = parsed?.[instance] ?? parsed?.tenants?.[instance];
    if (typeof candidate === "string") return candidate.trim();
    return scalarSecret(candidate?.secret ?? candidate?.secret_key);
  } catch {
    return "";
  }
}

export function getTenantSecret(config: Record<string, any> | null | undefined, channel = "webhook") {
  return getTenantSecrets(config, channel)[0] || "";
}

function resolveInstanceId(req: any, config: Record<string, any> | null | undefined) {
  return scalarSecret(config?.alemi_instance)
    || scalarSecret(config?.alemiInstance)
    || scalarSecret(req?.body?.instance)
    || scalarSecret(req?.query?.instance)
    || scalarSecret(config?.instance_id)
    || scalarSecret(config?.instance)
    || "unknown";
}

function alemiDeploymentSecret(req: any, config: Record<string, any> | null | undefined) {
  // Same rule as resolveAlemiCredentials(): the process-wide credential belongs
  // to one explicitly named legacy restaurant, so it may only authorize that
  // instance. Unlike the signing path the instance is never defaulted to
  // ALEMI_INSTANCE here, because a request that names no tenant must not be
  // able to borrow the deployment secret.
  const globalInstance = scalarSecret(process.env.ALEMI_INSTANCE);
  if (!globalInstance) return "";
  const instance = scalarSecret(config?.alemi_instance)
    || scalarSecret(config?.alemiInstance)
    || scalarSecret(req?.body?.instance)
    || scalarSecret(req?.query?.instance)
    || scalarSecret(config?.instance_id)
    || scalarSecret(config?.instance);
  if (!instance || instance !== globalInstance) return "";
  return scalarSecret(process.env.ALEMI_SECRET);
}

/**
 * Diagnostic only: never changes the outcome, and never logs a credential value.
 *
 * `getIncomingTenantSecret` reads `?token=` and the `X-*-Key` headers, so a caller
 * that puts its key in the JSON body instead is denied with exactly the same
 * INVALID_TENANT_SECRET as a caller holding a wrong key. The two are the same
 * three words in the log and a completely different fix - one is a rotated secret,
 * the other is a caller reading the contract wrong - and the body field is the
 * easier mistake to make: the whole rest of this webhook is JSON. Naming the
 * field that was found tells whoever is integrating where to move it.
 */
const BODY_CREDENTIAL_FIELDS = ["token", "secret", "secret_key", "api_key", "apikey", "key", "auth"];

function noteBodyCarriedCredential(req: any, config: Record<string, any> | null | undefined, channel: string) {
  const body = req?.body;
  if (!body || typeof body !== "object") return;
  const found = BODY_CREDENTIAL_FIELDS.filter((field) => scalarSecret(body[field]));
  if (!found.length) return;
  auditDecision("caller presented its credential in the JSON body; this webhook reads ?token= or X-Tenant-Key only", {
    instance: resolveInstanceId(req, config),
    channel,
    reason: "credential_in_body",
    // Field names only. The values are exactly the credential we must not log.
    fields: found.join(","),
  });
}

function noteRetiredKanbanToken(
  req: any,
  config: Record<string, any> | null | undefined,
  channel: string,
  incoming: string,
) {
  // Diagnostic only: never changes the outcome. Records that some caller is
  // still presenting the retired auto-generated kanban token so it can be
  // identified after deploy. The token value itself is never logged.
  if (channel !== "kanban") return;
  if (!safeCompare(incoming, scalarSecret(config?.kanban_secret))) return;
  auditDecision("kanban caller is still using the retired kanban_secret token; request denied", {
    instance: resolveInstanceId(req, config),
    channel,
    reason: "retired_kanban_secret",
  });
}

export function assertTenantSecret(req: any, config: Record<string, any> | null | undefined, channel = "webhook") {
  const expected = getTenantSecrets(config, channel);
  if (channel === "kanban") {
    const environmentSecret = alemiEnvironmentSecret(req?.body?.instance);
    if (environmentSecret && !expected.includes(environmentSecret)) expected.push(environmentSecret);
    const deploymentSecret = alemiDeploymentSecret(req, config);
    if (deploymentSecret && !expected.includes(deploymentSecret)) expected.push(deploymentSecret);
  }
  const incoming = getIncomingTenantSecret(req);

  if (!expected.length) {
    noteRetiredKanbanToken(req, config, channel, incoming);
    if (!incoming) noteBodyCarriedCredential(req, config, channel);
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
    noteRetiredKanbanToken(req, config, channel, incoming);
    if (!incoming) noteBodyCarriedCredential(req, config, channel);
    const error: any = new Error("INVALID_TENANT_SECRET");
    error.statusCode = 403;
    throw error;
  }
}
