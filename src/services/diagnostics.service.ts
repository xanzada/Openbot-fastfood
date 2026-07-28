import axios from "axios";
import { getRedisTarget, pingRedis } from "./redis.service.js";
import { getMediaFallbackModel, getMediaPrimaryKeys, getMediaPrimaryModel, getTextModels } from "./llm.service.js";

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

async function checkWhatsProPlatform(): Promise<CheckResult> {
  const base = String(process.env.WHATSPRO_BASE_URL || "").replace(/\/+$/, "");
  if (!base || !envPresent("WHATSPRO_API_TOKEN")) {
    return {
      name: "whatspro_platform",
      ok: false,
      target: hostFromUrl(base),
      message: "WHATSPRO_BASE_URL or WHATSPRO_API_TOKEN is missing",
    };
  }

  const url = `${base}/api/wa/platform-storage`;
  const started = now();
  try {
    const response = await axios.get(url, {
      headers: { authorization: `Bearer ${process.env.WHATSPRO_API_TOKEN || ""}` },
      timeout: 7000,
      validateStatus: () => true,
    });
    return {
      name: "whatspro_platform",
      ok: response.status >= 200 && response.status < 400,
      target: hostFromUrl(base),
      status: `${response.status} tenants=${Number(response.data?.tenants || 0)}`,
      latency_ms: now() - started,
    };
  } catch (error: any) {
    return {
      name: "whatspro_platform",
      ok: false,
      target: hostFromUrl(base),
      message: error?.message || String(error),
      latency_ms: now() - started,
    };
  }
}

export function getConfigSummary() {
  const redis = getRedisTarget();
  const textModels = getTextModels();
  return {
    port: Number(process.env.PORT || 4100),
    redis: `${redis.host}:${redis.port}`,
    text_models: textModels,
    media_models: {
      primary_provider: "gemini_free_key_rotation",
      primary_model: getMediaPrimaryModel(),
      primary_keys: getMediaPrimaryKeys().length,
      fallback_provider: "openrouter",
      fallback_model: getMediaFallbackModel(),
    },
    openrouter_key: envPresent("OPENROUTER_API_KEY") ? "present" : "missing",
    openbot_webhook_secret: envPresent("OPENBOT_WEBHOOK_SECRET") ? "present" : "missing",
    whatspro: {
      source: "whatspro_platform_tenant_config",
      url: hostFromUrl(process.env.WHATSPRO_BASE_URL || ""),
      token: envPresent("WHATSPRO_API_TOKEN") ? "present" : "missing",
      note: "whatspro_base_url, whatspro_send_url, and whatspro_api_token are loaded per instance",
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
  checks.push(await checkWhatsProPlatform());
  if (process.env.CHATWOOT_ADAPTER_URL) {
    checks.push(await checkHttp("chatwoot_adapter", endpointFromBase(process.env.CHATWOOT_ADAPTER_URL, "/health")));
  }
  return checks;
}

export async function logStartupDiagnostics() {
  console.log("[OPENBOT:BOOT] startup diagnostics begin");
  console.info("[OPENBOT:BOOT] config", JSON.stringify(getConfigSummary()));
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
