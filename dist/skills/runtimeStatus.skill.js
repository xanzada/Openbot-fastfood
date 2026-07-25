import { createTool } from "@voltagent/core";
import { z } from "zod";
import { getRuntimeStatus } from "../services/dle.service.js";
import { getActiveShiftNotes } from "../services/redis.service.js";
function createGetKitchenStatusSkill(ctx) {
  return createTool({
    name: "getKitchenStatus",
    description: "Read current real-time kitchen/workload status from DLE runtime status with Redis fallback. Use this before answering about wait time, emergency stop, delivery availability, pickup availability, or payment requisites.",
    parameters: z.object({}),
    execute: async () => {
      const runtime = await getRuntimeStatus(ctx.instanceId, ctx.config?.domain || "", { forceFresh: true });
      const status = runtime || ctx.runtimeStatus || ctx.hardRealtimeContext || null;
      return {
        source: status?.source || "runtime_unavailable",
        fetched_at: status?.fetched_at || (/* @__PURE__ */ new Date()).toISOString(),
        runtime_available: Boolean(runtime || ctx.runtimeStatus),
        is_accepting_orders: status?.is_accepting_orders ?? null,
        within_work_hours: status?.within_work_hours ?? null,
        closed_reason: status?.closed_reason || "",
        wait_time: Number(status?.wait_time ?? status?.kitchen_status?.wait_time ?? 0) || 0,
        is_emergency: Boolean(status?.is_emergency ?? status?.kitchen_status?.is_emergency),
        delivery: status?.delivery ?? status?.kitchen_status?.delivery ?? null,
        pickup: status?.pickup ?? status?.kitchen_status?.pickup ?? null,
        reset_at: Number(status?.reset_at ?? status?.kitchen_status?.reset_at ?? 0) || 0,
        payment_details: Array.isArray(status?.payment_details) ? status.payment_details : [],
        kitchen_status: status?.kitchen_status || null
      };
    }
  });
}
function createGetShiftNotesSkill(ctx) {
  return createTool({
    name: "getShiftNotes",
    description: "Read active operator shift notes from Redis memory. Use this before answering about temporary restrictions, kitchen notes, sold-out items, or operational instructions.",
    parameters: z.object({}),
    execute: async () => {
      const notes = await getActiveShiftNotes(ctx.instanceId);
      return {
        source: "redis_shift_notes",
        fetched_at: (/* @__PURE__ */ new Date()).toISOString(),
        count: notes.length,
        notes
      };
    }
  });
}
export {
  createGetKitchenStatusSkill,
  createGetShiftNotesSkill
};
