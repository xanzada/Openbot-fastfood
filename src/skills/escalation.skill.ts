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
 * would - but ONLY what a colleague would actually say out loud.
 *
 * The 2026-08-29 nail complaint showed what happens without that discipline: the
 * operator's case read "Тамақтан тырнақ шыққан", then a line calling three of the
 * guest's own past questions their "preferences" ("получать меню в текстовом виде,
 * Курьеру наличкой можно?"), then an ENGLISH paragraph about pizzas ordered days
 * earlier. The one fact that mattered - which order - was missing entirely. Noise
 * around an urgent fact is not context; it buries the fact.
 *
 * So: the reason first, the order number second (the operator's first question),
 * and everything else only when it earns its place. Deterministic from ctx only.
 */

// The guest's own words end in a question mark or read like a request, not a taste.
// The memory layer collects those into `preferences`, which is fine for tone and
// useless - actively misleading - on an operator's screen.
const NOT_A_PREFERENCE_RE = /[?？]|можно|болады ма|бар ма|айтшы|жібер|скинь|дай/iu;

function usefulPreferences(values: unknown): string[] {
  if (!Array.isArray(values)) return [];
  return values
    .map((value) => String(value || "").replace(/\s+/g, " ").trim())
    .filter((value) => value.length >= 3 && value.length <= 40 && !NOT_A_PREFERENCE_RE.test(value))
    .slice(0, 2);
}

// The rolling summary is written by a model and often lands in English, while the
// operator reads Kazakh or Russian. A wall of foreign text at the bottom of an
// urgent case is skipped, so it is better dropped than shown.
function looksLatin(text: string) {
  const letters = text.replace(/[^\p{L}]/gu, "");
  if (letters.length < 12) return false;
  const latin = (letters.match(/[a-z]/gi) || []).length;
  return latin / letters.length > 0.6;
}

export function buildHandoffDigest(ctx: FastFoodContext, reason: string): string {
  const parts: string[] = [String(reason || "").trim()];

  // The operator's very first question is always "which order?". A complaint that
  // reaches a human without it costs one round trip to the guest every time.
  const order = ctx.activeOrder as Record<string, any> | null | undefined;
  const orderNumber = order?.display_number || order?.number || order?.order_number || order?.id || order?.order_id;
  if (orderNumber) parts.push(`Тапсырыс: №${String(orderNumber)}`);

  const thinking = ctx.thinking as Record<string, any> | null | undefined;
  // Only a mood worth warning a human about. "мақсат=info, көңіл-күй=neutral" told
  // the operator nothing and pushed the real content down the screen.
  const mood = String(thinking?.mood || "").toLowerCase();
  if (["upset", "angry", "rushed"].includes(mood) || String(thinking?.urgency || "") === "high") {
    parts.push(`Күйі: ${mood || "шұғыл"}`);
  }

  const profile = ctx.customerProfile as Record<string, any> | null | undefined;
  const memoryBits: string[] = [];
  if (profile?.self_introduced_name) memoryBits.push(`аты: ${String(profile.self_introduced_name)}`);
  // A repeat complainer is a real fact for whoever picks this up.
  if (Number(profile?.complaint_count) > 0) memoryBits.push(`бұрынғы шағымдар: ${Number(profile?.complaint_count)}`);
  const preferences = usefulPreferences(profile?.preferences);
  if (preferences.length) memoryBits.push(`ұнататыны: ${preferences.join(", ")}`);
  if (memoryBits.length) parts.push(`Клиент: ${memoryBits.join("; ")}`);

  const summary = String((ctx.conversationSummary as Record<string, any> | null | undefined)?.summary || "").trim();
  // Kept short and only when the operator can actually read it.
  if (summary && !looksLatin(summary)) parts.push(`Бұған дейін: ${summary.slice(0, 160)}`);

  return parts.filter(Boolean).join("\n").slice(0, 700);
}

export function createEscalateToAdminSkill(ctx: FastFoodContext) {
  return createTool({
    name: "escalateToAdmin",
    description: "Create a human operator case immediately when the guest explicitly asks to speak to a human operator, explains a problem requiring human action, insists after clarification, or provides service-failure photo evidence. An actual current complaint or explicit request for courier contact that the available tools cannot provide creates a case immediately. Missing requested composition/allergen facts after a successful current catalog read require a human check. Authoritative no-item/no-stock results are ordinary catalog answers, not missing-data incidents. action=operator_case_created confirms a persisted case with durable notification plans. It does not confirm an administrator has received a notification; never claim notification delivery without an explicit accepted admin-notification result. Do not infer a missing-data incident from model uncertainty, a failed provider call, a generic menu question, or an authoritative negative catalog result. Use high urgency for a confirmed customer incident (paid but strongly late, wrong order, refund, actual food or medical danger). Model uncertainty, wait consent, ordinary catalog questions, refused requests, and technical diagnostics cannot establish a customer incident. If action=clarification_requested, relay customerReply and wait; no case or notification is confirmed.",
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
        action: routing.action,
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
