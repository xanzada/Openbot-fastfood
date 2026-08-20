import { getJsonCache, setJsonCache } from "./redis.service.js";
import type { FastFoodContext } from "../context/types.js";
import type { TurnAnalysis } from "./agentThinking.service.js";

/**
 * Multi-turn goal tracking.
 *
 * A real guest rarely finishes what they want in one message: they ask about
 * the menu, then price, then payment, then the link, then the order status.
 * Without a goal record every turn was judged in isolation, so the agent
 * celebrated answering the current sentence while the actual job - get this
 * person fed - quietly drifted. The tracker keeps one small record of what
 * this customer is trying to get done right now and whether it is resolved,
 * so the next turn continues the mission instead of restarting it.
 *
 * Deterministic only: goal transitions come from the think-layer goal label,
 * the tools that actually ran, and escalation facts - never from a second
 * model guessing. Stored per customer, advisory in FACTS_CONTEXT, and it can
 * never block an answer.
 */

export type GoalKind =
  | "order"
  | "menu"
  | "payment"
  | "status"
  | "complaint"
  | "info"
  | "smalltalk"
  | "human"
  | "unknown";

export type GoalStatus = "active" | "resolved" | "escalated";

export interface ActiveGoal {
  kind: GoalKind;
  status: GoalStatus;
  detail: string;
  started_at: string;
  updated_at: string;
  turns: number;
}

const GOAL_TTL_SECONDS = 60 * 60 * 36;

export function goalKey(instanceId: string, phone: string) {
  return `goal:${instanceId}:${phone}`;
}

export async function getActiveGoal(instanceId: string, phone: string): Promise<ActiveGoal | null> {
  return getJsonCache<ActiveGoal>(goalKey(instanceId, phone)).catch(() => null);
}

export async function saveActiveGoal(instanceId: string, phone: string, goal: ActiveGoal): Promise<void> {
  await setJsonCache(goalKey(instanceId, phone), GOAL_TTL_SECONDS, goal).catch(() => undefined);
}

const GOAL_KINDS: GoalKind[] = ["order", "menu", "payment", "status", "complaint", "info", "smalltalk", "human", "unknown"];

function normalizeKind(value: unknown): GoalKind {
  const normalized = String(value || "").trim().toLowerCase() as GoalKind;
  return GOAL_KINDS.includes(normalized) ? normalized : "unknown";
}

const ORDER_TEXT_RE = /(заказ\s*(?:хочу|сдел|оформ)|заказать|оформить|тапсырыс\s*(?:бер|жасай|ет)|себет|корзин)/iu;
const PAYMENT_TEXT_RE = /(оплат|төлем|kaspi|каспи|чек|түбіртек|аударым|перевод)/iu;
const STATUS_TEXT_RE = /(статус|қайда\s*(?:тапсырыс|заказ)|где\s*заказ|курьер\s*қайда|когда\s*привез|қашан\s*келед)/iu;
const COMPLAINT_TEXT_RE = /(шағым|жалоб|претенз|опозд|опазд|задерж|кешік|кешіг|не\s+привез|келмед|холодн|салқын|испорч|бұзыл|улан|отрав|волос|шаш(?!л)|гряз|лас)/iu;
const HUMAN_TEXT_RE = /(оператор|админ|менеджер|адаммен|человек|шақыр)/iu;

function kindFromText(text: string): GoalKind {
  if (HUMAN_TEXT_RE.test(text)) return "human";
  if (COMPLAINT_TEXT_RE.test(text)) return "complaint";
  if (STATUS_TEXT_RE.test(text)) return "status";
  if (PAYMENT_TEXT_RE.test(text)) return "payment";
  if (ORDER_TEXT_RE.test(text)) return "order";
  return "unknown";
}

export function resolveGoalKind(ctx: FastFoodContext, analysis: TurnAnalysis | null): GoalKind {
  const fromAnalysis = analysis ? normalizeKind(analysis.goal) : "unknown";
  if (fromAnalysis !== "unknown" && fromAnalysis !== "smalltalk") return fromAnalysis;
  const fromText = kindFromText(ctx.text || "");
  if (fromText !== "unknown") return fromText;
  return fromAnalysis === "smalltalk" ? "smalltalk" : "unknown";
}

/**
 * Advances the customer's goal after a completed turn. Fire-and-forget: it
 * reads and writes one tiny Redis value and never throws.
 */
export async function updateGoalAfterTurn(input: {
  ctx: FastFoodContext;
  analysis: TurnAnalysis | null;
  escalated: boolean;
}): Promise<void> {
  const { ctx, analysis, escalated } = input;
  try {
    const existing = await getActiveGoal(ctx.instanceId, ctx.phone);
    const kind = resolveGoalKind(ctx, analysis);
    const nowIso = new Date().toISOString();

    if (kind === "unknown" && !escalated) {
      // No new information about the mission: keep whatever was already open.
      if (existing && existing.status === "active") {
        await saveActiveGoal(ctx.instanceId, ctx.phone, { ...existing, updated_at: nowIso });
      }
      return;
    }

    if (kind === "smalltalk") {
      // Small talk after an active goal usually means the guest got what they
      // came for. Close the mission instead of letting it linger forever.
      if (existing && existing.status === "active") {
        await saveActiveGoal(ctx.instanceId, ctx.phone, { ...existing, status: "resolved", updated_at: nowIso });
      }
      return;
    }

    const sameMission = existing && existing.kind === kind && existing.status === "active";
    const detail = String(analysis?.reasoning_brief || ctx.text || "").replace(/\s+/g, " ").trim().slice(0, 160);
    const next: ActiveGoal = {
      kind,
      status: escalated ? "escalated" : "active",
      detail: detail || (sameMission ? existing?.detail || "" : ""),
      started_at: sameMission ? existing?.started_at || nowIso : nowIso,
      updated_at: nowIso,
      turns: sameMission ? (existing?.turns || 0) + 1 : 1,
    };
    await saveActiveGoal(ctx.instanceId, ctx.phone, next);
  } catch {
    // Goal tracking is advisory; a failure must never surface to the customer.
  }
}
