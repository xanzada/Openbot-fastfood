import { getOpenRouterProvider, getTextModels } from "./llm.service.js";
import type { FastFoodContext } from "../context/types.js";
import { envNumber } from "../utils/envNumber.js";

/**
 * The agent's silent pre-pass.
 *
 * Before this existed the only "thinking" happened inside the single generation
 * that also had to choose tools, follow forty rules and write the customer
 * reply at once. Complex turns - an upset guest, a vague multi-part message, a
 * complaint wrapped in a joke - got flattened into whatever the first token
 * guessed. This service adds a cheap, separate analysis call on the reserve
 * flash model that only answers: what does this person actually want, how do
 * they feel, and how risky is this turn. The result is injected into
 * FACTS_CONTEXT as advisory guidance; it never decides facts and never reaches
 * the customer.
 *
 * Cost discipline: shouldThink() skips trivial turns (greetings, thanks, short
 * acks), so the extra call only fires when the conversation actually needs
 * judgment. Everything here degrades to null on failure - the pipeline must
 * answer even when the thinker is down.
 */

export interface TurnAnalysis {
  goal: string;
  mood: string;
  urgency: "low" | "normal" | "high";
  complexity: "simple" | "moderate" | "complex";
  risk: "low" | "high";
  style_hint: string;
  reasoning_brief: string;
  proactive_note: string;
}

const TRIVIAL_TEXT_RE =
  /^(сәлем|салем|сәлеметсіз\s*бе|сәлеметсiz\s*бе|қайырлы\s*(?:таң|күні|кеш)|рақмет|рахмет|рахимет|жақсы|жарайды|болды|ок|okay|ok|иә|ия|жоқ|қош|сау\s*бол|привет|здравствуй(?:те)?|добрый\s*(?:день|вечер|утро)|спасибо|благодарю|хорошо|ладно|понял|понятно|да|нет|пока|до\s*свидания|\+|-|👍|🙏|🙂)[\s!.🙂👍🙏]*$/iu;

const THINK_WORTHY_RE =
  /(заказ|тапсырыс|оплат|төлем|чек|түбіртек|курьер|достав|жеткіз|кешік|опозд|задерж|шағым|жалоб|претенз|возврат|қайтар|отмен|болдырма|не\s+при|келмед|не\s+тот|қате|ошиб|холодн|салқын|испорч|бұзыл|бузыл|улан|отрав|волос|шаш(?!л)|гряз|лас|оператор|админ|менеджер|адам|человек|ақша\s+қайт|деньги\s+верн|әлі\s+келмеді|еще\s+не|досихпор|почему|неге|неліктен)/iu;

/**
 * Deterministic gate: spend a think call only where judgment changes the
 * outcome. Short polite turns and one-word answers go straight to the agent;
 * anything with money, orders, complaints, emotion or real length gets the
 * pre-pass. When the regex tool plan is ALREADY confident (menu lookup, price,
 * payment details, business info, link request, order status) and nothing
 * emotional or complaint-like is happening, the pre-pass adds seconds without
 * adding judgment - so it is skipped and the turn stays fast.
 */
const COMPLAINT_OR_EMOTION_RE =
  /(шағым|жалоб|претенз|опозд|опазд|задерж|кешік|кешіг|не\s+привез|келмед|холодн|салқын|испорч|бұзыл|бузыл|улан|отрав|волос|шаш(?!л)|гряз|лас|возврат|қайтар|ақша\s+қайт|деньги\s+верн|оператор|админ|менеджер|адаммен|человек|!!|\?\s*\?)/iu;

export function shouldThink(ctx: FastFoodContext, toolPlan?: { requiredTools?: string[] }): boolean {
  const text = String(ctx.text || "").trim();
  if (!text) return false;
  if (text.length <= 40 && TRIVIAL_TEXT_RE.test(text)) return false;
  const confidentPlan = Boolean(toolPlan && Array.isArray(toolPlan.requiredTools) && toolPlan.requiredTools.length > 0);
  if (confidentPlan && text.length < 200 && !COMPLAINT_OR_EMOTION_RE.test(text) && !ctx.mediaContext) return false;
  if (THINK_WORTHY_RE.test(text)) return true;
  if (text.length >= 140) return true;
  const questionMarks = (text.match(/\?/g) || []).length;
  const clauseBreaks = (text.match(/[,;]/g) || []).length;
  if (questionMarks >= 2 || (questionMarks === 1 && clauseBreaks >= 2)) return true;
  const exclamations = (text.match(/!/g) || []).length;
  if (exclamations >= 2) return true;
  if (ctx.mediaContext) return true;
  return false;
}

function safeJson(raw: string): Record<string, any> | null {
  const start = raw.indexOf("{");
  const end = raw.lastIndexOf("}");
  if (start < 0 || end <= start) return null;
  try {
    return JSON.parse(raw.slice(start, end + 1));
  } catch {
    return null;
  }
}

function pickEnum(value: unknown, allowed: string[], fallback: string) {
  const normalized = String(value || "").trim().toLowerCase();
  return allowed.includes(normalized) ? normalized : fallback;
}

function shortText(value: unknown, max: number) {
  return String(value || "").replace(/\s+/g, " ").trim().slice(0, max);
}

function thinkModel() {
  const modelId = String(process.env.THINK_MODEL || "").trim() || getTextModels().reserve;
  return getOpenRouterProvider().chat(modelId);
}

async function generateWithTimeout(model: any, args: Record<string, any>, timeoutMs: number) {
  const { generateText } = await import("ai");
  return await Promise.race([
    generateText({ model, temperature: 0, ...args } as any),
    new Promise<never>((_resolve, reject) =>
      setTimeout(() => reject(new Error(`THINK_TIMEOUT:${timeoutMs}ms`)), timeoutMs)
    ),
  ]);
}

const THINK_SYSTEM_PROMPT = `You are the silent pre-analysis layer of a fast-food WhatsApp service agent.
You never talk to the customer. You only read the situation and describe it for the answering layer.
Output strict JSON with these keys:
- goal: one of order|menu|payment|status|complaint|info|smalltalk|mixed
- mood: one of neutral|rushed|unsure|confused|pleased|upset|angry
- urgency: low|normal|high
- complexity: simple|moderate|complex
- risk: low|high (high when money, order state, health, or strong emotion is involved)
- style_hint: one short sentence telling the answering layer how to talk to THIS person right now
- reasoning_brief: one short sentence on what this person actually wants - internal only, never shown
- proactive_note: something genuinely useful to mention without being asked, or empty string
No markdown, no commentary, JSON only.`;

/**
 * Runs the silent analysis. Returns null on any failure, timeout, or whenever
 * the turn is trivial - callers must treat null as "no guidance".
 */
export async function analyzeTurnSituation(ctx: FastFoodContext, toolPlan?: { requiredTools?: string[] }): Promise<TurnAnalysis | null> {
  if (!shouldThink(ctx, toolPlan)) return null;
  const timeoutMs = envNumber(process.env.THINK_TIMEOUT_MS, 5_000, { min: 3_000, max: 15_000 });
  try {
    const historyLines = (Array.isArray(ctx.chatHistory) ? ctx.chatHistory : [])
      .slice(-6)
      .map((entry: any) => String(entry?.text || entry?.body || "").replace(/\s+/g, " ").trim().slice(0, 200))
      .filter(Boolean)
      .join("\n");
    const result = await generateWithTimeout(
      thinkModel(),
      {
        system: THINK_SYSTEM_PROMPT,
        prompt: [
          `customer_language: ${ctx.language}`,
          `newest_message: ${String(ctx.text || "").slice(0, 500)}`,
          historyLines ? `recent_context:\n${historyLines}` : "recent_context: (none)",
          ctx.activeOrder ? "active_order: yes" : "active_order: no",
          ctx.mediaContext ? "media_present: yes" : "media_present: no",
        ].join("\n"),
      },
      timeoutMs
    );
    const parsed = safeJson(String((result as any)?.text || ""));
    if (!parsed) return null;
    const analysis: TurnAnalysis = {
      goal: pickEnum(parsed.goal, ["order", "menu", "payment", "status", "complaint", "info", "smalltalk", "mixed"], "mixed"),
      mood: pickEnum(parsed.mood, ["neutral", "rushed", "unsure", "confused", "pleased", "upset", "angry"], "neutral"),
      urgency: pickEnum(parsed.urgency, ["low", "normal", "high"], "normal") as TurnAnalysis["urgency"],
      complexity: pickEnum(parsed.complexity, ["simple", "moderate", "complex"], "moderate") as TurnAnalysis["complexity"],
      risk: pickEnum(parsed.risk, ["low", "high"], "low") as TurnAnalysis["risk"],
      style_hint: shortText(parsed.style_hint, 220),
      reasoning_brief: shortText(parsed.reasoning_brief, 220),
      proactive_note: shortText(parsed.proactive_note, 220),
    };
    console.info(`[THINK] instance=${ctx.instanceId} goal=${analysis.goal} mood=${analysis.mood} risk=${analysis.risk}`);
    return analysis;
  } catch (error: any) {
    console.warn(`[THINK] failed instance=${ctx.instanceId} reason=${error?.message || error}`);
    return null;
  }
}

export interface DraftCritique {
  ok: boolean;
  issues: string[];
  fix_hint: string;
}

const CRITIC_SYSTEM_PROMPT = `You are the critic of a fast-food WhatsApp service agent.
You review the DRAFT reply before it is sent. You never talk to the customer.
Flag only critical problems:
- invented_fact: states a price, status, time, promo, or policy that was not verified
- wrong_tone: cold, robotic, dismissive, or mismatched to the customer's mood
- dodges_question: does not actually answer what the customer asked
- repeats_history: re-asks or re-states something already covered in the recent dialog
- escalation_mismatch: should clearly hand to a human (or clearly should not)
If none apply, the draft is fine.
Output strict JSON: {"ok":true|false,"issues":[],"fix_hint":"one short instruction for a rewrite"}.
JSON only, no commentary.`;

/**
 * One bounded self-check for high-risk turns. Cheap model, hard timeout, and
 * any failure means "no objection" so the draft goes out unchanged.
 */
export async function critiqueDraftReply(input: {
  ctx: FastFoodContext;
  analysis: TurnAnalysis;
  draft: string;
}): Promise<DraftCritique | null> {
  const { ctx, analysis, draft } = input;
  if (!draft.trim()) return null;
  const timeoutMs = envNumber(process.env.THINK_TIMEOUT_MS, 5_000, { min: 3_000, max: 15_000 });
  try {
    const result = await generateWithTimeout(
      thinkModel(),
      {
        system: CRITIC_SYSTEM_PROMPT,
        prompt: [
          `customer_language: ${ctx.language}`,
          `customer_message: ${String(ctx.text || "").slice(0, 400)}`,
          `turn_goal: ${analysis.goal}`,
          `customer_mood: ${analysis.mood}`,
          `draft_reply: ${draft.slice(0, 600)}`,
        ].join("\n"),
      },
      timeoutMs
    );
    const parsed = safeJson(String((result as any)?.text || ""));
    if (!parsed) return null;
    const issues = Array.isArray(parsed.issues)
      ? parsed.issues.map((issue: unknown) => shortText(issue, 80)).filter(Boolean).slice(0, 4)
      : [];
    return {
      ok: parsed.ok !== false && issues.length === 0,
      issues,
      fix_hint: shortText(parsed.fix_hint, 220),
    };
  } catch (error: any) {
    console.warn(`[CRITIC] failed instance=${ctx.instanceId} reason=${error?.message || error}`);
    return null;
  }
}
