import crypto from "node:crypto";
import axios from "axios";
import { getRestaurantConfig, refreshRestaurantConfig } from "./platformConfig.service.js";

export const ALEMI_DEFAULT_API_URL = "https://hub.alemi.kz";
export const ALEMI_COMMAND_PATH = "/v1/integrations/bot/commands";
export const ALEMI_ORDER_DOCUMENT_PATH = "/v1/integrations/bot/order-documents";
export const ALEMI_PRINT_RESULTS_PATH = "/v1/integrations/bot/print-results";
export const ALEMI_SIGNATURE_WINDOW_SECONDS = 5 * 60;

export type AlemiLegacyAction =
  | "get_runtime_status"
  | "get_order_context"
  | "check_status"
  | "get_menu_context"
  | "update_crm"
  | "get_today_crm"
  | "save_daily_analytics";

export type AlemiCommandName =
  | "runtime.status.get"
  | "order.context.get"
  | "order.status.get"
  | "catalog.context.get"
  | "crm.lead.upsert"
  | "crm.today.get"
  | "analytics.daily.upsert"
  | "customer.access_link.issue";

export interface AlemiTransportRequest {
  url: string;
  body: string | FormData;
  headers: Record<string, string>;
  timeoutMs: number;
}

export interface AlemiTransportResponse {
  status: number;
  data: unknown;
}

export type AlemiTransport = (request: AlemiTransportRequest) => Promise<AlemiTransportResponse>;

export type AlemiConfigRefresher = (instanceId: string) => Promise<Record<string, any> | null>;

export interface AlemiCallOptions {
  config?: Record<string, any> | null;
  env?: Record<string, string | undefined>;
  transport?: AlemiTransport;
  refreshConfig?: AlemiConfigRefresher;
  nowMs?: number;
  commandId?: string;
  timeoutMs?: number;
}

export interface AlemiCredentials {
  apiUrl: string;
  instance: string;
  secret: string;
}

export interface AlemiSignedCommand {
  url: string;
  rawBody: string;
  headers: Record<string, string>;
  commandId: string;
  timestamp: string;
}

export interface UploadOrderDocumentInput {
  instanceId: string;
  orderId: string | number;
  sourceMessageId: string;
  bytes: Uint8Array;
  mimeType: string;
  documentKind?: "receipt" | "other";
  fileName?: string;
}

export interface ReportPrintResultInput {
  instanceId: string;
  printJobId: string;
  attemptNumber: number;
  status: "completed" | "failed";
  externalReference?: string;
  errorCode?: string;
  errorMessage?: string;
}

function firstString(...values: unknown[]) {
  for (const value of values) {
    if (value !== undefined && value !== null && String(value).trim()) return String(value).trim();
  }
  return "";
}

function safeJsonObject(value: unknown): Record<string, any> | null {
  if (value && typeof value === "object" && !Array.isArray(value)) return value as Record<string, any>;
  if (typeof value !== "string" || !value.trim()) return null;
  try {
    const parsed = JSON.parse(value);
    return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

function endpoint(baseUrl: string, path: string) {
  const clean = String(baseUrl || ALEMI_DEFAULT_API_URL).trim().replace(/\/+$/, "");
  return clean.endsWith(path) ? clean : `${clean}${path}`;
}

function tenantEnvironmentEntry(instanceId: string, env: Record<string, string | undefined>) {
  const parsed = safeJsonObject(env.ALEMI_TENANT_SECRETS_JSON);
  if (!parsed) return null;
  const candidate = parsed[instanceId] ?? safeJsonObject(parsed.tenants)?.[instanceId];
  if (typeof candidate === "string") return { secret: candidate };
  return safeJsonObject(candidate);
}

export function resolveAlemiCredentials(
  instanceId: string,
  config: Record<string, any> | null | undefined,
  env: Record<string, string | undefined> = process.env
): AlemiCredentials {
  const requestedInstance = firstString(instanceId, config?.instance_id, config?.instance, env.ALEMI_INSTANCE);
  const tenantEntry = tenantEnvironmentEntry(requestedInstance, env);
  const instance = firstString(
    config?.alemi_instance,
    config?.alemiInstance,
    tenantEntry?.instance,
    tenantEntry?.instance_id,
    requestedInstance,
    env.ALEMI_INSTANCE
  );
  const apiUrl = firstString(
    config?.alemi_api_url,
    config?.alemiApiUrl,
    config?.alemi_base_url,
    config?.alemiBaseUrl,
    tenantEntry?.api_url,
    tenantEntry?.apiUrl,
    tenantEntry?.base_url,
    tenantEntry?.baseUrl,
    env.ALEMI_API_URL,
    ALEMI_DEFAULT_API_URL
  );
  const tenantSecret = firstString(
    config?.alemi_secret,
    config?.alemiSecret,
    config?.alemi_api_secret,
    config?.alemiApiSecret,
    tenantEntry?.secret,
    tenantEntry?.secret_key,
    tenantEntry?.secretKey
  );
  // A process-wide credential is only valid for its explicitly named legacy
  // restaurant. Falling back to it for an incomplete SaaS tenant would sign a
  // request as the wrong restaurant and break tenant isolation.
  const globalInstance = firstString(env.ALEMI_INSTANCE);
  const secret = tenantSecret || (globalInstance && instance === globalInstance
    ? firstString(env.ALEMI_SECRET)
    : "");

  if (!instance) throw new Error("ALEMI_INSTANCE_NOT_CONFIGURED");
  if (!secret) throw new Error("ALEMI_SECRET_NOT_CONFIGURED");
  return { apiUrl, instance, secret };
}

function unixTimestamp(nowMs = Date.now()) {
  if (!Number.isFinite(nowMs) || nowMs <= 0) throw new Error("ALEMI_INVALID_TIMESTAMP");
  return String(Math.floor(nowMs / 1000));
}

export function createAlemiCommandId() {
  // Alemi's command schema accepts the documented cmd_ + 26 uppercase-hex
  // operation identifier; a raw RFC 4122 UUID is rejected before auth.
  return `cmd_${crypto.randomBytes(13).toString("hex").toUpperCase()}`;
}

function signature(secret: string, timestamp: string, signedBytes: string) {
  return `v1=${crypto.createHmac("sha256", secret).update(`${timestamp}.${signedBytes}`, "utf8").digest("hex")}`;
}

function commonHeaders(credentials: AlemiCredentials, commandId: string, timestamp: string, signedBytes: string) {
  return {
    "X-Platform-Instance": credentials.instance,
    "X-Command-Id": commandId,
    "X-Command-Timestamp": timestamp,
    "X-Command-Signature": signature(credentials.secret, timestamp, signedBytes),
  };
}

export function buildAlemiSignedCommand(input: {
  command: AlemiCommandName;
  data: Record<string, unknown>;
  credentials: AlemiCredentials;
  nowMs?: number;
  commandId?: string;
}): AlemiSignedCommand {
  const commandId = firstString(input.commandId) || createAlemiCommandId();
  const timestamp = unixTimestamp(input.nowMs);
  const rawBody = JSON.stringify({
    command: input.command,
    command_id: commandId,
    data: input.data,
    instance: input.credentials.instance,
    schema_version: 1,
  });
  return {
    url: endpoint(input.credentials.apiUrl, ALEMI_COMMAND_PATH),
    rawBody,
    headers: {
      "content-type": "application/json",
      ...commonHeaders(input.credentials, commandId, timestamp, rawBody),
    },
    commandId,
    timestamp,
  };
}

const axiosTransport: AlemiTransport = async (request) => {
  const response = await axios.post(request.url, request.body, {
    headers: request.headers,
    timeout: request.timeoutMs,
    maxRedirects: 0,
  });
  return { status: response.status, data: response.data };
};

export function unwrapAlemiResponse(value: unknown): any {
  let current: any = value;
  for (let depth = 0; depth < 3; depth += 1) {
    if (!current || typeof current !== "object" || Array.isArray(current)) return current;
    if (current.result !== undefined) {
      current = current.result;
      continue;
    }
    if (current.data !== undefined) {
      current = current.data;
      continue;
    }
    return current;
  }
  return current;
}

function assertAlemiResponse(response: AlemiTransportResponse) {
  if (response.status < 200 || response.status >= 300) {
    const error: any = new Error(`ALEMI_HTTP_${response.status}`);
    error.statusCode = response.status;
    throw error;
  }
  const raw = response.data as any;
  const unwrapped = unwrapAlemiResponse(response.data);
  if (raw?.ok === false || raw?.success === false || unwrapped?.ok === false || unwrapped?.success === false) {
    const error: any = new Error("ALEMI_COMMAND_REJECTED");
    error.statusCode = response.status;
    error.code = firstString(raw?.error?.code, raw?.error_code, raw?.code, unwrapped?.error?.code, unwrapped?.error_code, unwrapped?.code);
    throw error;
  }
  return unwrapped;
}

function hasTenantAlemiSecret(
  instanceId: string,
  config: Record<string, any> | null | undefined,
  env: Record<string, string | undefined>
) {
  // Ask the real resolver rather than re-listing field names here, so a tenant
  // that legitimately signs with the env credential is not refreshed on every
  // call and no future secret field is missed.
  try {
    resolveAlemiCredentials(instanceId, config, env);
    return true;
  } catch {
    return false;
  }
}

function isAlemiAuthRejection(error: any) {
  const status = Number(error?.statusCode ?? error?.response?.status ?? 0);
  return status === 401;
}

// The hub answers 401 when the request was signed with a secret the operator has
// already rotated in the WhatsPro UI. The cached tenant config is re-read once,
// authoritatively, and the request is signed and sent again exactly once - never
// in a loop. Anything else, including a second 401, surfaces unchanged.
async function withRotatedSecretRetry<T>(
  instanceId: string,
  options: AlemiCallOptions,
  send: (config: Record<string, any> | null | undefined) => Promise<T>
): Promise<T> {
  const config = options.config === undefined
    ? await getRestaurantConfig(instanceId).catch(() => null)
    : options.config;
  // The platform's multi-tenant index redacts Alemi secrets, so a cached config
  // that came from there would make every hub call throw
  // ALEMI_SECRET_NOT_CONFIGURED even though the tenant is configured correctly.
  // One authoritative re-read repairs the cache instead of failing the call.
  const hydrated = hasTenantAlemiSecret(instanceId, config, options.env || process.env)
    ? config
    : (await (options.refreshConfig || refreshRestaurantConfig)(instanceId).catch(() => null)) || config;
  try {
    return await send(hydrated);
  } catch (error: any) {
    if (!isAlemiAuthRejection(error)) throw error;
    const refresh = options.refreshConfig || refreshRestaurantConfig;
    const fresh = await refresh(instanceId).catch(() => null);
    if (!fresh) throw error;
    return await send(fresh);
  }
}

export async function callAlemiCommand(
  instanceId: string,
  command: AlemiCommandName,
  data: Record<string, unknown>,
  options: AlemiCallOptions = {}
) {
  // Both attempts must present the SAME command_id. The 401 retry re-signs the
  // request with a freshly read secret, and it used to re-enter
  // buildAlemiSignedCommand with no id, which minted a new one - so a write the
  // hub had in fact accepted before the secret rotated arrived a second time
  // looking like a different command, defeating hub-side idempotency. Minting it
  // here, once, makes the retry a retry rather than a second command.
  const commandId = firstString(options.commandId) || createAlemiCommandId();
  return withRotatedSecretRetry(instanceId, options, async (config) => {
    const credentials = resolveAlemiCredentials(instanceId, config, options.env || process.env);
    const request = buildAlemiSignedCommand({
      command,
      data,
      credentials,
      nowMs: options.nowMs,
      commandId,
    });
    const response = await (options.transport || axiosTransport)({
      url: request.url,
      body: request.rawBody,
      headers: request.headers,
      timeoutMs: options.timeoutMs || 10_000,
    });
    return assertAlemiResponse(response);
  });
}

function e164Kazakhstan(value: unknown) {
  let digits = String(value || "").replace(/\D/g, "");
  if (digits.length === 10) digits = `7${digits}`;
  if (digits.length === 11 && digits.startsWith("8")) digits = `7${digits.slice(1)}`;
  if (!/^7\d{10}$/.test(digits)) return "";
  return `+${digits}`;
}

export function mapLegacyAlemiAction(action: AlemiLegacyAction, payload: Record<string, any>): {
  command: AlemiCommandName;
  data: Record<string, unknown>;
} {
  const phone = e164Kazakhstan(payload.phone);
  switch (action) {
    case "get_runtime_status":
      return { command: "runtime.status.get", data: {} };
    // Both order commands are keyed on the guest's phone and reject `order_id`
    // outright: hub answers 400 INTEGRATION_COMMAND_INVALID for the whole
    // command as soon as the field is present. So a guest who quoted their
    // order number ("заказым №13 қайда?") got "cannot read status" while the
    // same question without a number worked. The number is still honoured -
    // normalizeOrderContextPayload picks the matching order out of the pools
    // the hub returns - so it must never reach the wire.
    case "get_order_context":
      if (!phone) throw new Error("ALEMI_ORDER_CONTEXT_PHONE_REQUIRED");
      return {
        command: "order.context.get",
        data: { phone_e164: phone, limit: 5 },
      };
    case "check_status":
      if (!phone) throw new Error("ALEMI_ORDER_STATUS_PHONE_REQUIRED");
      return {
        command: "order.status.get",
        data: { phone_e164: phone },
      };
    case "get_menu_context":
      return {
        command: "catalog.context.get",
        data: { locale: String(payload.lang || "").toLowerCase() === "ru" ? "ru" : "kk" },
      };
    case "update_crm":
      return {
        command: "crm.lead.upsert",
        data: {
          phone_e164: phone,
          interest: String(payload.interest || ""),
          sales_stage: String(payload.sales_stage || ""),
          psycho_analysis: String(payload.psycho_analysis || ""),
        },
      };
    case "get_today_crm":
      return { command: "crm.today.get", data: { date: String(payload.date || "") } };
    case "save_daily_analytics":
      return {
        command: "analytics.daily.upsert",
        data: {
          report_date: String(payload.report_date || ""),
          total_chats: Number(payload.total_chats || 0),
          total_complaints: Number(payload.total_complaints || 0),
          total_canceled: Number(payload.total_canceled || 0),
          conversion_rate: Number(payload.conversion_rate || 0),
          popular_items: payload.popular_items ?? "",
          critical_alert: payload.critical_alert ?? "",
          ai_daily_advice: payload.ai_daily_advice ?? "",
        },
      };
    default:
      throw new Error("ALEMI_ACTION_UNSUPPORTED");
  }
}

export async function callAlemiLegacyAction(
  action: AlemiLegacyAction,
  payload: Record<string, any>,
  options: AlemiCallOptions = {}
) {
  const instanceId = firstString(payload.restaurant_id, payload.instance, payload.instanceId, options.config?.instance_id, options.config?.instance);
  const mapped = mapLegacyAlemiAction(action, payload);
  return callAlemiCommand(instanceId, mapped.command, mapped.data, options);
}

export async function issueCustomerAccessLink(input: {
  instanceId: string;
  phone: string;
  locale: "kk" | "ru";
  config?: Record<string, any> | null;
}, options: AlemiCallOptions = {}): Promise<string | null> {
  const phone = e164Kazakhstan(input.phone);
  if (!phone) return null;
  const result = await callAlemiCommand(
    input.instanceId,
    "customer.access_link.issue",
    { phone_e164: phone, locale: input.locale },
    { ...options, config: options.config === undefined ? input.config : options.config }
  );
  if (typeof result === "string") return result.trim() || null;
  return firstString(result?.url, result?.access_url, result?.link) || null;
}

function extensionForMime(mimeType: string) {
  const mime = String(mimeType || "").toLowerCase();
  if (mime === "image/png") return "png";
  if (mime === "image/webp") return "webp";
  if (mime === "application/pdf") return "pdf";
  return "jpg";
}

export async function uploadOrderDocument(input: UploadOrderDocumentInput, options: AlemiCallOptions = {}) {
  return withRotatedSecretRetry(input.instanceId, options, async (config) => {
    const credentials = resolveAlemiCredentials(input.instanceId, config, options.env || process.env);
    const commandId = firstString(options.commandId) || createAlemiCommandId();
    const timestamp = unixTimestamp(options.nowMs);
    const orderId = firstString(input.orderId);
    const sourceMessageId = firstString(input.sourceMessageId);
    const kind = input.documentKind || "receipt";
    const mimeType = firstString(input.mimeType);
    if (!orderId) throw new Error("ALEMI_ORDER_ID_REQUIRED");
    if (!sourceMessageId) throw new Error("ALEMI_SOURCE_MESSAGE_ID_REQUIRED");
    if (!mimeType || !input.bytes?.byteLength) throw new Error("ALEMI_RECEIPT_BYTES_REQUIRED");
    const contentSha256 = crypto.createHash("sha256").update(input.bytes).digest("hex");
    const canonical = [
      "order-document-upload-v1",
      commandId,
      credentials.instance,
      orderId,
      sourceMessageId,
      kind,
      mimeType,
      contentSha256,
    ].join("\n");
    const form = new FormData();
    const blobBytes = new ArrayBuffer(input.bytes.byteLength);
    new Uint8Array(blobBytes).set(input.bytes);
    form.append(
      "file",
      new Blob([blobBytes], { type: mimeType }),
      input.fileName || `receipt.${extensionForMime(mimeType)}`
    );
    const response = await (options.transport || axiosTransport)({
      url: endpoint(credentials.apiUrl, ALEMI_ORDER_DOCUMENT_PATH),
      body: form,
      headers: {
        ...commonHeaders(credentials, commandId, timestamp, canonical),
        "X-Order-Id": orderId,
        "X-Source-Message-Id": sourceMessageId,
        "X-Document-Kind": kind,
        "X-Document-Mime-Type": mimeType,
        "X-Content-SHA256": contentSha256,
      },
      timeoutMs: options.timeoutMs || 15_000,
    });
    return assertAlemiResponse(response);
  });
}

export async function reportPrintResult(input: ReportPrintResultInput, options: AlemiCallOptions = {}) {
  return withRotatedSecretRetry(input.instanceId, options, async (config) => {
    const credentials = resolveAlemiCredentials(input.instanceId, config, options.env || process.env);
    const commandId = firstString(options.commandId) || createAlemiCommandId();
    const timestamp = unixTimestamp(options.nowMs);
    const printJobId = firstString(input.printJobId);
    const attemptNumber = Math.max(1, Math.trunc(Number(input.attemptNumber) || 0));
    const status = input.status;
    const externalReference = firstString(input.externalReference);
    const errorCode = firstString(input.errorCode);
    const errorMessage = firstString(input.errorMessage);
    if (!printJobId) throw new Error("ALEMI_PRINT_JOB_ID_REQUIRED");
    if (status !== "completed" && status !== "failed") throw new Error("ALEMI_PRINT_STATUS_INVALID");
    const canonical = [
      "print-result-v1",
      commandId,
      credentials.instance,
      printJobId,
      String(attemptNumber),
      status,
      externalReference,
      errorCode,
      errorMessage,
    ].join("\n");
    const rawBody = JSON.stringify({
      print_job_id: printJobId,
      attempt_number: attemptNumber,
      status,
      external_reference: externalReference,
      error_code: errorCode,
      error_message: errorMessage,
    });
    const response = await (options.transport || axiosTransport)({
      url: endpoint(credentials.apiUrl, ALEMI_PRINT_RESULTS_PATH),
      body: rawBody,
      headers: {
        "content-type": "application/json",
        ...commonHeaders(credentials, commandId, timestamp, canonical),
      },
      timeoutMs: options.timeoutMs || 10_000,
    });
    return assertAlemiResponse(response);
  });
}
