import { getAllRestaurantConfigs } from "../services/platformConfig.service.js";
import { getRuntimeStatus } from "../services/dle.service.js";
import { getActiveShiftNotes, getKitchenStatus } from "../services/redis.service.js";
import { drainDeveloperAlertOutbox } from "../services/developerNotify.service.js";
import { auditDecision, auditError } from "../services/auditLogger.service.js";

/**
 * The kitchen state and the operator's shift notes are the two facts that change
 * without any webhook the bot can rely on: hub pushes `kitchen.status_changed`
 * and `shift_note.*` only when the operator touches the panel, and a `runtime_status`
 * cache entry that expired between two guests left the agent answering from a
 * snapshot taken minutes earlier. This worker re-reads both on a fixed interval so
 * the cache the agent reads is never stale by more than one tick, and so a change
 * is visible in the audit log even when no guest is talking.
 *
 * It only refreshes caches — it sends nothing to guests. Failures are logged, never
 * thrown: one tenant's site being down must not stop the other tenants' refresh.
 */

const DEFAULT_INTERVAL_MS = 45_000;
const MIN_INTERVAL_MS = 15_000;

type WatchSnapshot = {
  acceptingOrders: unknown;
  withinWorkHours: unknown;
  waitTime: number;
  isEmergency: boolean;
  closedReason: string;
  noteCount: number;
  noteFingerprint: string;
};

const lastSnapshot = new Map<string, WatchSnapshot>();

export function runtimeWatchIntervalMs(env: NodeJS.ProcessEnv = process.env) {
  const configured = Number(env.RUNTIME_WATCH_INTERVAL_MS || 0);
  if (!Number.isFinite(configured) || configured <= 0) return DEFAULT_INTERVAL_MS;
  return Math.max(MIN_INTERVAL_MS, Math.floor(configured));
}

export function isRuntimeWatchEnabled(env: NodeJS.ProcessEnv = process.env) {
  const configured = String(env.RUNTIME_WATCH_ENABLED ?? "").trim().toLowerCase();
  if (["0", "false", "no", "off"].includes(configured)) return false;
  return true;
}

function buildSnapshot(
  runtime: Record<string, any> | null,
  kitchen: Record<string, any> | null,
  notes: Array<{ noteId: string; text: string }>,
): WatchSnapshot {
  const source = runtime || {};
  return {
    acceptingOrders: source.is_accepting_orders ?? kitchen?.is_accepting_orders ?? null,
    withinWorkHours: source.within_work_hours ?? null,
    waitTime: Number(source.wait_time ?? kitchen?.wait_time ?? 0) || 0,
    isEmergency: Boolean(source.is_emergency ?? kitchen?.is_emergency),
    closedReason: String(source.closed_reason || "").slice(0, 120),
    noteCount: notes.length,
    // Note ids only — the note text can name a guest or a supplier and this line
    // goes to the audit log on every change.
    noteFingerprint: notes.map((note) => note.noteId).sort().join(","),
  };
}

function snapshotChanged(previous: WatchSnapshot | undefined, next: WatchSnapshot) {
  if (!previous) return true;
  return previous.acceptingOrders !== next.acceptingOrders
    || previous.withinWorkHours !== next.withinWorkHours
    || previous.waitTime !== next.waitTime
    || previous.isEmergency !== next.isEmergency
    || previous.closedReason !== next.closedReason
    || previous.noteCount !== next.noteCount
    || previous.noteFingerprint !== next.noteFingerprint;
}

export async function refreshTenantRuntimeWatch(instanceId: string, domain = "") {
  const runtime = await getRuntimeStatus(instanceId, domain, { forceFresh: true }).catch((error) => {
    auditError("Runtime watch: live status read failed", error, { instance: instanceId });
    return null;
  });
  const kitchen = await getKitchenStatus(instanceId).catch(() => null);
  const notes = await getActiveShiftNotes(instanceId).catch(() => []);
  const snapshot = buildSnapshot(runtime, kitchen as Record<string, any> | null, notes);
  const changed = snapshotChanged(lastSnapshot.get(instanceId), snapshot);
  lastSnapshot.set(instanceId, snapshot);
  if (changed) {
    auditDecision("Runtime watch: kitchen/notes state changed", {
      instance: instanceId,
      runtime_available: Boolean(runtime),
      ...snapshot,
    });
  }
  return { changed, snapshot, runtimeAvailable: Boolean(runtime) };
}

export async function runRuntimeWatchTick() {
  const configs = await getAllRestaurantConfigs().catch((error) => {
    auditError("Runtime watch: tenant list read failed", error, {});
    return [] as Record<string, any>[];
  });
  const tenants = configs
    .map((config) => ({
      instanceId: String(config.instance_id || config.instance || "").trim(),
      domain: String(config.domain || "").trim(),
      enabled: config.bot_enabled !== false,
    }))
    .filter((tenant) => tenant.instanceId && tenant.enabled);

  let changedCount = 0;
  // Sequential on purpose: this box has 2 vCPU and every tenant refresh is one
  // outbound HTTPS call to hub. A parallel fan-out over many tenants would spike
  // both at once for no gain at a 45 s cadence.
  let alertsRetried = 0;
  for (const tenant of tenants) {
    const result = await refreshTenantRuntimeWatch(tenant.instanceId, tenant.domain).catch(() => null);
    if (result?.changed) changedCount += 1;
    // A developer alert that could not be sent used to be "persisted for retry" into
    // an outbox nothing ever read. This tick already has the tenant list and already
    // runs every 45s, so it drains it here rather than adding another timer. The
    // alerts that fail are exactly the ones about a broken WhatsPro, which usually
    // recovers minutes later (found 2026-08-22).
    const drained = await drainDeveloperAlertOutbox(tenant.instanceId).catch(() => null);
    if (drained?.sent) alertsRetried += drained.sent;
  }
  return { tenants: tenants.length, changed: changedCount, alertsRetried };
}

export function startRuntimeWatcher() {
  if (!isRuntimeWatchEnabled()) {
    console.log("[OPENBOT:WATCH] runtime watcher disabled by RUNTIME_WATCH_ENABLED");
    return;
  }
  const intervalMs = runtimeWatchIntervalMs();
  const tick = () => {
    void runRuntimeWatchTick()
      .catch((error) => auditError("Runtime watch tick failed", error, {}))
      .finally(() => {
        setTimeout(tick, intervalMs).unref();
      });
  };
  // First pass a few seconds after boot, so the cache is warm before the first
  // guest message instead of on it.
  setTimeout(tick, 5_000).unref();
  console.log(`[OPENBOT:WATCH] kitchen status + shift notes watcher every ${intervalMs} ms`);
}
