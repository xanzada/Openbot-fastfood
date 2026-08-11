import axios from "axios";
import { getRedisTarget, pingRedis } from "./redis.service.js";
import { getMediaFallbackModel, getMediaPrimaryKeys, getMediaPrimaryModel, getTextModels } from "./llm.service.js";
import { getWhatsProOutboxSummary } from "../transport/whatspro.client.js";
import { getAllRestaurantConfigs } from "./platformConfig.service.js";
import { callAlemiCommand } from "./alemiApi.service.js";
import { envNumber } from "../utils/envNumber.js";
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
        port: envNumber(process.env.PORT, 4100, { min: 1 }),
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
        runtime_controls: {
            test_mode: String(process.env.TEST_MODE_ENABLED || "false").trim().toLowerCase() === "true",
            developer_phone: envPresent("OPENBOT_DEVELOPER_PHONE") ? "present" : "missing",
            receipt_ai_filter: !["false", "0", "off", "no"].includes(String(process.env.RECEIPT_AI_FILTER_ENABLED ?? "true").trim().toLowerCase()),
            inbound_buffer_ms: envNumber(process.env.OPENBOT_INBOUND_BUFFER_MS, 2400, { min: 600 }),
            response_chunk_max: envNumber(process.env.OPENBOT_RESPONSE_CHUNK_MAX, 320, { min: 180 }),
        },
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
// hub.alemi.kz is the one dependency a guest notices immediately - it answers
// kitchen state, order status and the menu - and it was the only one missing
// from boot. A rotated secret or a moved API URL surfaced hours later as guests
// being told "белсенді тапсырыс табылмады", never as a startup failure. The
// credential is per tenant, so the check is per tenant, and it is deliberately
// read-only (runtime.status.get) and never fatal.
export async function checkAlemiHub(loadConfigs = () => getAllRestaurantConfigs(), call = callAlemiCommand) {
    const configs = await loadConfigs().catch(() => []);
    const tenants = configs.filter((config) => String(config?.alemi_secret || "").trim());
    if (!tenants.length) {
        return [{
                name: "alemi_hub",
                ok: false,
                message: configs.length
                    ? `no tenant carries alemi_secret (tenants=${configs.length})`
                    : "no tenant config could be loaded",
            }];
    }
    return Promise.all(tenants.map(async (config) => {
        const instance = String(config.instance_id || config.instance || "unknown");
        const started = now();
        try {
            const status = await call(instance, "runtime.status.get", {}, { config, timeoutMs: 7000 });
            return {
                name: `alemi_hub[${instance}]`,
                ok: true,
                target: hostFromUrl(String(config.alemi_api_url || "")),
                status: `accepting_orders=${status?.accepting_orders ?? status?.is_accepting_orders ?? "-"}`,
                latency_ms: now() - started,
            };
        }
        catch (error) {
            return {
                name: `alemi_hub[${instance}]`,
                ok: false,
                target: hostFromUrl(String(config.alemi_api_url || "")),
                message: String(error?.message || error),
                latency_ms: now() - started,
            };
        }
    }));
}
export async function runDependencyChecks() {
    const checks = [];
    checks.push(await checkRedis());
    checks.push(await checkTenantsPlatform());
    checks.push(...await checkAlemiHub().catch((error) => [{
            name: "alemi_hub",
            ok: false,
            message: String(error?.message || error),
        }]));
    const outboxStarted = now();
    const outbox = await getWhatsProOutboxSummary().catch(() => ({ volatilePending: -1, filePending: -1, redisPending: -1 }));
    checks.push({
        name: "whatspro_outbox",
        ok: outbox.volatilePending >= 0,
        status: `volatile=${outbox.volatilePending} file=${outbox.filePending} redis=${outbox.redisPending}`,
        latency_ms: now() - outboxStarted,
    });
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
