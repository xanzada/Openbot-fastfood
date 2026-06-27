import axios from "axios";
import { getRedisTarget, pingRedis } from "./redis.service.js";

type CheckResult = {
  name: string;
  ok: boolean;
  target?: string;
  status?: number | string;
  message?: string;
  latency_ms?: number;
};

function now() {
  return Date.now();
}

function envPresent(name: string) {
  return Boolean(String(process.env[name] || "").trim());
}

function hostFromUrl(raw = "") {
  try {
    const url = new URL(raw);
    return url.host;
  } catch {
    return raw ? "invalid-url" : "not-configured";
  }
}

function endpointFromBase(raw = "", path = "/health") {
  const base = String(raw || "").trim().replace(/\/+$/, "");
  return base ? `${base}${path}` : "";
}

async function checkRedis(): Promise<CheckResult> {
  const started = now();
  const target = getRedisTarget();
  try {
    const pong = await pingRedis();
    return {
      name: "redis",
      ok: true,
      target: `${target.host}:${target.port}`,
      status: pong,
      latency_ms: now() - started,
    };
  } catch (error: any) {
    return {
      name: "redis",
      ok: false,
      target: `${target.host}:${target.port}`,
      message: error?.message || String(error),
      latency_ms: now() - started,
    };
  }
}

async function checkHttp(name: string, url: string, headers: Record<string, string> = {}): Promise<CheckResult> {
  const started = now();
  if (!url) {
    return { name, ok: false, target: "not-configured", message: "URL is not configured" };
  }

  try {
    const response = await axios.get(url, {
      timeout: 5000,
      headers,
      validateStatus: () => true,
    });
    return {
      name,
      ok: response.status >= 200 && response.status < 400,
      target: hostFromUrl(url),
      status: response.status,
      latency_ms: now() - started,
    };
  } catch (error: any) {
    return {
      name,
      ok: false,
      target: hostFromUrl(url),
      message: error?.message || String(error),
      latency_ms: now() - started,
    };
  }
}

async function checkNocoDB(): Promise<CheckResult> {
  const base = String(process.env.NOCODB_URL || "").replace(/\/+$/, "");
  const tableId = String(process.env.NOCODB_TABLE_ID || "").trim();
  if (!base || !tableId || !envPresent("NOCODB_TOKEN")) {
    return {
      name: "nocodb",
      ok: false,
      target: hostFromUrl(base),
      message: "NOCODB_URL, NOCODB_TOKEN or NOCODB_TABLE_ID is missing",
    };
  }

  const url = `${base}/api/v2/tables/${tableId}/records`;
  const started = now();
  try {
    const response = await axios.get(url, {
      headers: { "xc-token": process.env.NOCODB_TOKEN || "" },
      params: { limit: 1 },
      timeout: 7000,
      validateStatus: () => true,
    });
    const sample = Array.isArray(response.data?.list) ? response.data.list[0] : null;
    const instance = sample?.instance_id ? ` sample_instance=${sample.instance_id}` : "";
    return {
      name: "nocodb",
      ok: response.status >= 200 && response.status < 400,
      target: hostFromUrl(base),
      status: `${response.status}${instance}`,
      latency_ms: now() - started,
    };
  } catch (error: any) {
    return {
      name: "nocodb",
      ok: false,
      target: hostFromUrl(base),
      message: error?.message || String(error),
      latency_ms: now() - started,
    };
  }
}

export function getConfigSummary() {
  const redis = getRedisTarget();
  return {
    port: Number(process.env.PORT || 4100),
    redis: `${redis.host}:${redis.port}`,
    openrouter_model: process.env.OPENROUTER_AGENT_MODEL || "google/gemini-2.5-flash",
    openrouter_key: envPresent("OPENROUTER_API_KEY") ? "present" : "missing",
    crm_secret: envPresent("CRM_SECRET_TOKEN") ? "present" : "missing",
    openbot_webhook_secret: envPresent("OPENBOT_WEBHOOK_SECRET") ? "present" : "missing",
    nocodb: {
      url: hostFromUrl(process.env.NOCODB_URL || ""),
      token: envPresent("NOCODB_TOKEN") ? "present" : "missing",
      table: envPresent("NOCODB_TABLE_ID") ? "present" : "missing",
      shpor_table: envPresent("NOCODB_SHPOR_TABLE_ID") ? "present" : "missing",
    },
    whatspro: {
      base_url: hostFromUrl(process.env.WHATSPRO_BASE_URL || process.env.WHATSPRO_SEND_URL || ""),
      api_token: envPresent("WHATSPRO_API_TOKEN") ? "present" : "missing",
    },
    chatwoot_adapter: {
      url: hostFromUrl(process.env.CHATWOOT_ADAPTER_URL || ""),
      note: envPresent("CHATWOOT_ADAPTER_URL") ? "will-check-health" : "optional-not-configured",
    },
  };
}

export async function runDependencyChecks() {
  const checks: CheckResult[] = [];
  checks.push(await checkRedis());
  checks.push(await checkNocoDB());
  checks.push(await checkHttp("whatspro", endpointFromBase(process.env.WHATSPRO_BASE_URL || "", "/health")));
  if (process.env.CHATWOOT_ADAPTER_URL) {
    checks.push(await checkHttp("chatwoot_adapter", endpointFromBase(process.env.CHATWOOT_ADAPTER_URL, "/health")));
  }
  return checks;
}

export async function logStartupDiagnostics() {
  console.log("[OPENBOT:BOOT] startup diagnostics begin");
  console.log("[OPENBOT:BOOT] config", JSON.stringify(getConfigSummary()));
  const checks = await runDependencyChecks();
  for (const check of checks) {
    const status = check.ok ? "OK" : "FAIL";
    const detail = check.ok ? check.status : check.message;
    console.log(
      `[OPENBOT:BOOT:${status}] ${check.name} target=${check.target || "-"} latency=${check.latency_ms ?? "-"}ms detail=${detail || "-"}`
    );
  }
  console.log("[OPENBOT:BOOT] startup diagnostics end");
  return checks;
}
