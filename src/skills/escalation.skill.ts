import { createTool } from "@voltagent/core";
import { z } from "zod";
import type { FastFoodContext } from "../context/types.js";
import { routeComplaintToAdmin } from "../services/complaintRouting.service.js";

/**
 * Builds the operator-facing handoff digest.
 *
 * A raw "customer is angry about a late order" used to be all the operator
 * received, so their first messages went into re-collecting what the bot
 * already knew. This digest hands over the situation the way a good colleague
 * would: what the customer wants, how they feel, what we remember about them,
 * and what has already been verified - so the human continues the conversation
 * instead of restarting it. Deterministic from ctx only: no extra model call.
 */
export function buildHandoffDigest(ctx: FastFoodContext, reason: string): string {
  const parts: string[] = [String(reason || "").trim()];
  const thinking = ctx.thinking as Record<string, any> | null | undefined;
  if (thinking?.goal || thinking?.mood) {
    parts.push(
      `Контекст: мақсат=${String(thinking?.goal || "-")}, көңіл-күй=${String(thinking?.mood || "-")}, шұғылдылық=${String(thinking?.urgency || "-")}`
    );
  }
  const profile = ctx.customerProfile as Record<string, any> | null | undefined;
  const memoryBits: string[] = [];
  if (profile?.self_introduced_name) memoryBits.push(`аты: ${String(profile.self_introduced_name)}`);
  if (profile?.complaint_count) memoryBits.push(`бұрынғы шағымдар: ${Number(profile.complaint_count)}`);
  if (Array.isArray(profile?.preferences) && profile.preferences.length) {
    memoryBits.push(`тілейіндері: ${profile.preferences.slice(0, 3).join(", ")}`);
  }
  if (memoryBits.length) parts.push(`Клиент жайлы белгілісі: ${memoryBits.join("; ")}`);
  const order = ctx.activeOrder as Record<string, any> | null | undefined;
  const orderNumber = order?.number || order?.order_number || order?.id || order?.order_id;
  if (orderNumber) parts.push(`Белсенді тапсырыс: №${String(orderNumber)}`);
  const summary = (ctx.conversationSummary as Record<string, any> | null | undefined)?.summary;
  if (summary) parts.push(`Алдыңғы сөйлесу қорытындысы: ${String(summary).slice(0, 220)}`);
  return parts.filter(Boolean).join("\n").slice(0, 900);
}

export function createEscalateToAdminSkill(ctx: FastFoodContext) {
  return createTool({
    name: "escalateToAdmin",
    description: "Create a human operator case only when a person is truly needed: the guest has explained the problem and it takes human action, they insist on a human after being asked what happened, or there is photo evidence of a service failure. A bare demand for a person or a complaint with no details is NOT escalated here - ask what happened first; routing turns a bare demand into one clarifying question automatically. Missing menu, payment, address, or business data alone is never a reason to escalate.",
    parameters: z.object({
      reason: z.string(),
      customerReply: z.string(),
      urgency: z.enum(["low", "normal", "high"]).default("normal"),
    }),
    execute: async ({ reason, customerReply, urgency }) => {
      const routing = await routeComplaintToAdmin(ctx, {
        summary: buildHandoffDigest(ctx, reason),
        customerReply,
        urgency,
        source: "ai_tool_escalate_to_admin",
      });

      return {
        action: "operator_case_created",
        caseId: routing.caseId,
        queuedForChat: routing.queuedForChat,
        escalationAvailable: routing.escalationAvailable,
        mediaAttached: routing.mediaAttached,
        urgency,
        customerReply: routing.customerReply,
      };
    },
  });
}
