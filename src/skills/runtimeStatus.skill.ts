import { createTool } from "@voltagent/core";
import { z } from "zod";
import { getRuntimeStatus } from "../services/dle.service.js";
import { getActiveShiftNotes } from "../services/redis.service.js";
import type { FastFoodContext } from "../context/types.js";

export function createGetKitchenStatusSkill(ctx: FastFoodContext) {
  return createTool({
    name: "getKitchenStatus",
    description:
      "Read current real-time kitchen/workload status from DLE runtime status with Redis fallback. Use this before answering about wait time, emergency stop, delivery availability, pickup availability, or payment requisites.",
    parameters: z.object({}),
    execute: async () => {
      const runtime = await getRuntimeStatus(ctx.instanceId, ctx.config?.domain || "", { forceFresh: true });
      const status = runtime || ctx.runtimeStatus || ctx.hardRealtimeContext || null;
      // A hub outage falls back to the last state pushed into Redis or to a
      // 10-minute backup. That is the right answer to give, but the model used
      // to see `runtime_available: true` and present a remembered "we are open"
      // as a fact checked just now. These flags let it say "last known".
      const source = String(status?.source || "runtime_unavailable");
      const fromFallback = Boolean(
        status?.redis_runtime_fallback || status?.stale_runtime_backup || /fallback|stale|backup/.test(source)
      );
      return {
        source,
        fetched_at: status?.fetched_at || new Date().toISOString(),
        runtime_available: Boolean(runtime || ctx.runtimeStatus),
        live: Boolean(runtime) && !fromFallback,
        is_last_known: fromFallback,
        is_accepting_orders: status?.is_accepting_orders ?? null,
        within_work_hours: status?.within_work_hours ?? null,
        closed_reason: status?.closed_reason || "",
        wait_time: Number(status?.wait_time ?? status?.kitchen_status?.wait_time ?? 0) || 0,
        is_emergency: Boolean(status?.is_emergency ?? status?.kitchen_status?.is_emergency),
        delivery: status?.delivery ?? status?.kitchen_status?.delivery ?? null,
        pickup: status?.pickup ?? status?.kitchen_status?.pickup ?? null,
        reset_at: Number(status?.reset_at ?? status?.kitchen_status?.reset_at ?? 0) || 0,
        payment_details: Array.isArray(status?.payment_details) ? status.payment_details : [],
        kitchen_status: status?.kitchen_status || null,
      };
    },
  });
}

export function createGetShiftNotesSkill(ctx: FastFoodContext) {
  return createTool({
    name: "getShiftNotes",
    description:
      "Read active operator shift notes from Redis memory. Use this before answering about temporary restrictions, kitchen notes, sold-out items, or operational instructions.",
    parameters: z.object({}),
    execute: async () => {
      const notes = await getActiveShiftNotes(ctx.instanceId);
      return {
        source: "redis_shift_notes",
        fetched_at: new Date().toISOString(),
        count: notes.length,
        notes,
      };
    },
  });
}
