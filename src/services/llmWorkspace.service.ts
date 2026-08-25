import { envText } from "./llm.service.js";

/**
 * The platform's LLM key workspace ("Жұмыс кеңістігі" in the WhatsPro panel):
 * two ordered pools — text and media — each entry a named provider/model/key.
 * The first entry is the workhorse; when one entry fails the runtime hops to
 * the next, and an empty pool means "use the platform-wide env keys as before".
 *
 * Polled once a minute with the master token and kept in memory: generation is
 * on the hot path, so nothing here ever blocks or throws — a stale snapshot is
 * always better than no snapshot.
 */

export type LlmProvider = "openai" | "gemini";

export interface LlmKeyEntry {
  name: string;
  type: LlmProvider;
  baseUrl: string;
  model: string;
  key: string;
}

export interface LlmWorkspacePools {
  text: LlmKeyEntry[];
  media: LlmKeyEntry[];
}

const TYPES = new Set<string>(["openai", "gemini"]);
const MAX_ENTRIES_PER_POOL = 12;
const DEFAULT_BASE_URL: Record<string, string> = {
  openai: "https://openrouter.ai/api/v1",
  gemini: "https://generativelanguage.googleapis.com/v1beta",
};

function normalizeBaseUrl(value: unknown, type: string): string {
  const raw = String(value ?? "").trim().replace(/\/+$/, "");
  const fallback = DEFAULT_BASE_URL[type] || DEFAULT_BASE_URL.openai;
  if (!raw) return fallback;
  try {
    const url = new URL(raw);
    if (url.protocol !== "https:") return fallback;
    return url.toString().replace(/\/+$/, "");
  } catch {
    return fallback;
  }
}

export function sanitizeWorkspace(raw: unknown): LlmWorkspacePools {
  const sanitizePool = (list: unknown): LlmKeyEntry[] => {
    const source = Array.isArray(list) ? list : [];
    const out: LlmKeyEntry[] = [];
    const seen = new Set<string>();
    for (const item of source) {
      const record = (item && typeof item === "object" ? item : {}) as Record<string, any>;
      let type = String(record.type || "").trim().toLowerCase();
      let baseUrl = String(record.baseUrl ?? "").trim().replace(/\/+$/, "");
      if (!type && record.provider) {
        // Legacy rows from the first cut used a provider select.
        const legacy = String(record.provider).trim().toLowerCase();
        if (legacy === "gemini") { type = "gemini"; baseUrl = baseUrl || DEFAULT_BASE_URL.gemini; }
        else if (legacy === "openrouter") { type = "openai"; baseUrl = baseUrl || DEFAULT_BASE_URL.openai; }
      }
      if (!TYPES.has(type)) type = "openai";
      const model = String(record.model || "").replace(/[\r\n\t]+/g, " ").trim().slice(0, 120);
      const key = String(record.key ?? "").replace(/\s+/g, "").slice(0, 400);
      if (!model || !key) continue;
      const name = String(record.name || "").replace(/[\r\n\t]+/g, " ").trim().slice(0, 80) || model;
      const normalizedBase = normalizeBaseUrl(baseUrl, type);
      const fingerprint = `${type}|${normalizedBase}|${model}|${key}`;
      if (seen.has(fingerprint)) continue;
      seen.add(fingerprint);
      out.push({ name, type: type as LlmProvider, baseUrl: normalizedBase, model, key });
      if (out.length >= MAX_ENTRIES_PER_POOL) break;
    }
    return out;
  };
  const source = (raw && typeof raw === "object" ? raw : {}) as Record<string, any>;
  return { text: sanitizePool(source.text), media: sanitizePool(source.media) };
}

let latest: LlmWorkspacePools | null = null;
let polling: ReturnType<typeof setInterval> | null = null;
let inFlight = false;

async function refreshOnce(): Promise<void> {
  const base = envText("TENANTS_PLATFORM_BASE_URL").replace(/\/+$/, "");
  const token = envText("TENANTS_PLATFORM_API_TOKEN");
  if (!base || !token || inFlight) return;
  inFlight = true;
  try {
    const response = await fetch(`${base}/api/wa/llm-workspace`, {
      headers: { authorization: `Bearer ${token}` },
      signal: AbortSignal.timeout(10_000),
    } as any);
    if (!response.ok) return;
    const payload = await response.json().catch(() => null);
    if (!payload || typeof payload !== "object") return;
    latest = sanitizeWorkspace((payload as any).workspace);
  } catch {
    // Keep the previous snapshot; polling tries again in a minute.
  } finally {
    inFlight = false;
  }
}

/** Starts the 60-second poll. Safe to call repeatedly; never throws. */
export function startLlmWorkspacePolling(): void {
  if (polling) return;
  void refreshOnce();
  void refreshSettingsOnce();
  polling = setInterval(() => {
    void refreshOnce();
    void refreshSettingsOnce();
  }, 60_000);
  (polling as any)?.unref?.();
}

/** The last known pools, or null when the workspace has never answered. */
export function getLlmWorkspacePools(): LlmWorkspacePools | null {
  if (!latest) return null;
  if (!latest.text.length && !latest.media.length) return null;
  return latest;
}

export interface RuntimeSettings {
  developerPhone?: string;
  testModeEnabled?: boolean;
  testAllowedPhones?: string[];
  receiptFilterEnabled?: boolean;
}

function sanitizeSettings(raw: unknown): RuntimeSettings {
  const source = (raw && typeof raw === "object" ? raw : {}) as Record<string, any>;
  const out: RuntimeSettings = {};
  const dev = String(source.developer_phone ?? "").replace(/[^\d+]/g, "").trim();
  if (dev) out.developerPhone = dev;
  if (source.test_mode_enabled === true || source.test_mode_enabled === false) {
    out.testModeEnabled = Boolean(source.test_mode_enabled);
  }
  if (Array.isArray(source.test_allowed_phones)) {
    out.testAllowedPhones = source.test_allowed_phones
      .map((item: unknown) => String(item ?? "").replace(/\D/g, ""))
      .filter((phone: string) => phone.length >= 10);
  }
  if (source.receipt_filter_enabled === true || source.receipt_filter_enabled === false) {
    out.receiptFilterEnabled = Boolean(source.receipt_filter_enabled);
  }
  return out;
}

let latestSettings: RuntimeSettings | null = null;

async function refreshSettingsOnce(): Promise<void> {
  const base = envText("TENANTS_PLATFORM_BASE_URL").replace(/\/+$/, "");
  const token = envText("TENANTS_PLATFORM_API_TOKEN");
  if (!base || !token) return;
  try {
    const response = await fetch(`${base}/api/wa/runtime-settings`, {
      headers: { authorization: `Bearer ${token}` },
      signal: AbortSignal.timeout(10_000),
    } as any);
    if (!response.ok) return;
    const payload = await response.json().catch(() => null);
    if (!payload || typeof payload !== "object") return;
    const settings = sanitizeSettings((payload as any).settings);
    latestSettings = Object.keys(settings).length ? settings : {};
  } catch {
    // Keep the previous snapshot.
  }
}

/** Platform runtime controls, or null before the first successful poll. */
export function getRuntimeSettings(): RuntimeSettings | null {
  return latestSettings;
}

/** Test-mode switch: the panel's Настройки toggle wins, env is the fallback. */
export function runtimeTestModeEnabled(env: Record<string, string | undefined> = process.env): boolean {
  return getRuntimeSettings()?.testModeEnabled ?? env.TEST_MODE_ENABLED === "true";
}

export function stopLlmWorkspacePolling(): void {
  if (polling) clearInterval(polling);
  polling = null;
}
