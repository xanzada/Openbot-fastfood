import axios from "axios";
import { getRedisTarget, pingRedis } from "./redis.service.js";
import { getMediaFallbackModel, getMediaPrimaryKeys, getMediaPrimaryModel, getTextModels } from "./llm.service.js";
function now() {
    return Date.now();
}
function envPresent(name) {
    return Boolean(String(process.env[name] || "").trim());
}
function hostFromUrl(raw = "") {
    try {
        const url = new URL(raw);
        return url.host;
    }
    catch {
        return raw ? "invalid-url" : "not-configured";
    }
}
function endpointFromBase(raw = "", path = "/health") {
    const base = String(raw || "").trim().replace(/\/+$/, "");
    return base ? `${base}${path}` : "";
}
async function checkRedis() {
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
    }
    catch (error) {
        return {
            name: "redis",
            ok: false,
            target: `${target.host}:${target.port}`,
            message: error?.message || String(error),
            latency_ms: now() - started,
        };
    }
}
async function checkHttp(name, url, headers = {}) {
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
    }
    catch (error) {
        return {
            name,
            ok: false,
            target: hostFromUrl(url),
            message: error?.message || String(error),
            latency_ms: now() - started,
        };
    }
}
function tenantsPlatformEnv() {
    return {
        base: String(process.env.TENANTS_PLATFORM_BASE_URL || process.env.WHATSPRO_BASE_URL || "").replace(/\/+$/, ""),
        token: String(process.env.TENANTS_PLATFORM_API_TOKEN || process.env.WHATSPRO_API_TOKEN || "").trim(),
    };
}
async function checkTenantsPlatform() {
    const { base, token } = tenantsPlatformEnv();
    if (!base || !token) {
        return {
            name: "tenants_platform",
            ok: false,
            target: hostFromUrl(base),
            message: "TENANTS_PLATFORM_BASE_URL or TENANTS_PLATFORM_API_TOKEN is missing",
        };
    }
    const url = `${base}/api/wa/platform-storage`;
    const started = now();
    try {
        const response = await axios.get(url, {
            headers: { authorization: `Bearer ${token}` },
            timeout: 7000,
            validateStatus: () => true,
        });
        return {
            name: "tenants_platform",
            ok: response.status >= 200 && response.status < 400,
            target: hostFromUrl(base),
            status: `${response.status} tenants=${Number(response.data?.tenants || 0)}`,
            latency_ms: now() - started,
        };
    }
    catch (error) {
        return {
            name: "tenants_platform",
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
    const tenantsPlatform = tenantsPlatformEnv();
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
        tenants_platform: {
            source: "tenants_platform_by_instance_id",
            url: hostFromUrl(tenantsPlatform.base),
            token: tenantsPlatform.token ? "present" : "missing",
            note: "tenant config, system_prompt, generated keys, and second-brain memory are loaded by exact instance_id",
        },
        whatspro_transport: {
            note: "transport URLs and credentials are loaded from the current tenant config only",
        },
        chatwoot_adapter: {
            url: hostFromUrl(process.env.CHATWOOT_ADAPTER_URL || ""),
            note: envPresent("CHATWOOT_ADAPTER_URL") ? "will-check-health" : "optional-not-configured",
        },
    };
}
export async function runDependencyChecks() {
    const checks = [];
    checks.push(await checkRedis());
    checks.push(await checkTenantsPlatform());
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
        console.log(`[OPENBOT:BOOT:${status}] ${check.name} target=${check.target || "-"} latency=${check.latency_ms ?? "-"}ms detail=${detail || "-"}`);
    }
    console.log("[OPENBOT:BOOT] startup diagnostics end");
    return checks;
}
