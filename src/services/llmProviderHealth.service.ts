import { createHash } from "node:crypto";
import type { LlmKeyEntry } from "./llmWorkspace.service.js";

export type LlmPoolName = "text" | "media";
export type LlmHealthStatus = "healthy" | "unknown" | "suspect" | "unavailable" | "disabled";

interface LocalProviderState {
  status: LlmHealthStatus;
  failedUntil: number;
  consecutiveFailures: number;
}

const localState = new Map<string, LocalProviderState>();
const TRANSIENT_COOLDOWN_MS = 60_000;
const HARD_COOLDOWN_MS = 5 * 60_000;

export function providerEntryId(entry: LlmKeyEntry, pool: LlmPoolName) {
  if (entry.id) return entry.id;
  return createHash("sha256")
    .update(`${pool}|${entry.type}|${entry.baseUrl}|${entry.model}|${entry.name}`)
    .digest("hex")
    .slice(0, 24);
}

export function classifyProviderError(error: unknown) {
  const message = String((error as any)?.message || error || "");
  if (/\b401\b|unauthori[sz]ed|invalid api key/i.test(message)) return "AUTH_INVALID";
  if (/\b402\b|billing|check-in|required to use free|quota/i.test(message)) return "QUOTA_UNAVAILABLE";
  if (/\b403\b|forbidden/i.test(message)) return "ACCESS_FORBIDDEN";
  if (/\b404\b|model.*not found|retired model/i.test(message)) return "MODEL_NOT_FOUND";
  if (/\b429\b|rate.?limit/i.test(message)) return "RATE_LIMITED";
  if (/timeout|abort/i.test(message)) return "TIMEOUT";
  if (/\b50[0234]\b|server error|temporarily unavailable|service_unavailable/i.test(message)) return "PROVIDER_UNAVAILABLE";
  if (/unsupported|invalid_request|\b400\b/i.test(message)) return "REQUEST_UNSUPPORTED";
  return "REQUEST_FAILED";
}

function remoteStatus(entry: LlmKeyEntry): LlmHealthStatus {
  if (entry.enabled === false) return "disabled";
  const value = String(entry.health?.status || "unknown").toLowerCase();
  return ["healthy", "unknown", "suspect", "unavailable", "disabled"].includes(value)
    ? value as LlmHealthStatus
    : "unknown";
}

function localStatus(entry: LlmKeyEntry, pool: LlmPoolName, now: number): LlmHealthStatus | null {
  const key = providerEntryId(entry, pool);
  const state = localState.get(key);
  if (!state) return null;
  if (state.failedUntil > now) return state.status;
  if (state.failedUntil) localState.delete(key);
  return null;
}

/**
 * Effective request order. The operator's saved order is never rewritten: only
 * known-good providers move to the hot path, and known-bad providers are skipped
 * while at least one non-disabled candidate remains.
 */
export function providersForRequest(entries: LlmKeyEntry[], pool: LlmPoolName, now = Date.now()) {
  const score: Record<LlmHealthStatus, number> = {
    healthy: 0,
    unknown: 1,
    suspect: 2,
    unavailable: 3,
    disabled: 4,
  };
  const ordered = (Array.isArray(entries) ? entries : [])
    .map((entry, index) => ({ entry, index, status: localStatus(entry, pool, now) || remoteStatus(entry) }))
    .sort((a, b) => score[a.status] - score[b.status] || a.index - b.index);
  // suspect means a transient runtime failure is still inside its cooldown.
  // Do not immediately retry it on the next customer message. If every
  // workspace lane is known-bad, return an empty chain so the existing env
  // reserve or graceful operator fallback runs without waiting on them again.
  return ordered
    .filter((item) => item.status === "healthy" || item.status === "unknown")
    .map((item) => item.entry);
}

function reportOutcome(entry: LlmKeyEntry, pool: LlmPoolName, ok: boolean, latencyMs: number, errorCode: string) {
  const base = String(process.env.TENANTS_PLATFORM_BASE_URL || "").trim().replace(/\/+$/, "");
  const token = String(process.env.TENANTS_PLATFORM_API_TOKEN || "").trim();
  if (!base || !token) return;
  void fetch(`${base}/api/wa/llm-workspace/outcomes`, {
    method: "POST",
    headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
    body: JSON.stringify({
      entryId: providerEntryId(entry, pool),
      pool,
      ok,
      latencyMs: Math.max(0, Math.round(latencyMs)),
      errorCode: errorCode || null,
      observedAt: new Date().toISOString(),
    }),
    signal: AbortSignal.timeout(2_000),
  }).catch(() => undefined);
}

export function noteProviderOutcome(input: {
  entry: LlmKeyEntry;
  pool: LlmPoolName;
  ok: boolean;
  latencyMs: number;
  error?: unknown;
}) {
  const key = providerEntryId(input.entry, input.pool);
  if (input.ok) {
    localState.delete(key);
    reportOutcome(input.entry, input.pool, true, input.latencyMs, "");
    return;
  }
  const errorCode = classifyProviderError(input.error);
  const previous = localState.get(key);
  const hard = ["AUTH_INVALID", "QUOTA_UNAVAILABLE", "ACCESS_FORBIDDEN", "MODEL_NOT_FOUND", "REQUEST_UNSUPPORTED"].includes(errorCode);
  localState.set(key, {
    status: hard ? "unavailable" : "suspect",
    failedUntil: Date.now() + (hard ? HARD_COOLDOWN_MS : TRANSIENT_COOLDOWN_MS),
    consecutiveFailures: (previous?.consecutiveFailures || 0) + 1,
  });
  reportOutcome(input.entry, input.pool, false, input.latencyMs, errorCode);
}

export function clearProviderHealthForTests() {
  localState.clear();
}
