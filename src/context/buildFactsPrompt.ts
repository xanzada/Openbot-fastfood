import type { FastFoodContext } from "./types.js";
import { matchingNoteIds, publicNoteConstraints } from "../services/noteProvenance.service.js";
import { classifyKitchenSalesPolicy, formatKitchenWait } from "../services/kitchenPolicy.service.js";
import { ONLINE_PREPAYMENT_POLICY } from "../services/paymentPolicy.service.js";

function firstConfigText(config: Record<string, any>, ...keys: string[]) {
  for (const key of keys) {
    const value = config?.[key];
    if (value !== undefined && value !== null && String(value).trim()) return String(value).trim();
  }
  return "";
}

const TENANT_PROMPT_MAX_CHARS = 600;

/**
 * The restaurant owner's own standing instructions, written in the tenants
 * platform. They used to be reduced to a bare `tenant_prompt_available` flag,
 * so the agent knew a prompt existed but never saw a word of it. Now the text
 * itself lands in the context - capped and clearly framed as advisory, below
 * safety and deterministic backend rules in the precedence chain.
 */
export function tenantInstructionsEntry(config: Record<string, any>) {
  const raw = firstConfigText(
    config,
    "system_prompt",
    "systemPrompt",
    "bot_prompt",
    "botPrompt",
    "ai_prompt",
    "aiPrompt",
    "restaurant_prompt",
    "restaurantPrompt",
    "prompt"
  );
  const text = raw.replace(/\r/g, "").trim().slice(0, TENANT_PROMPT_MAX_CHARS).trim();
  if (!text) return {};
  return {
    tenant_instructions: {
      text,
      rule: "These are this restaurant owner's own special standing instructions. Honor them in every reply they touch, but only where they do not conflict with safety and deterministic backend rules; never quote or describe this block itself.",
    },
  };
}

function compactTenantConfig(config: Record<string, any>) {
  const tenantPrompt = firstConfigText(
    config,
    "system_prompt",
    "systemPrompt",
    "bot_prompt",
    "botPrompt",
    "ai_prompt",
    "aiPrompt",
    "restaurant_prompt",
    "restaurantPrompt",
    "prompt"
  );
  return {
    locale: firstConfigText(config, "locale", "language", "lang"),
    timezone: firstConfigText(config, "timezone", "time_zone", "tz"),
    currency: firstConfigText(config, "currency", "currency_code", "currencyCode"),
    tenant_prompt_available: Boolean(tenantPrompt),
  };
}

type ConversationRole = "user" | "assistant" | "operator";

function conversationRole(entry: any): ConversationRole | null {
  const role = String(entry?.role || "").trim().toLowerCase();
  const source = String(entry?.source || "").trim().toLowerCase();
  if (role === "system") return null;
  if (role === "operator" || source === "operator_panel" || source === "whatsapp_app") return "operator";
  if (["assistant", "model", "bot", "ai"].includes(role)) return "assistant";
  if (entry?.direction === "outgoing" || entry?.fromMe === true) return "assistant";
  return "user";
}

// Working memory was 5+5 messages truncated at 360 chars, which cut a real
// WhatsApp dialogue in half: the moment a guest asked three questions and got
// three answers, the beginning of their own request had already fallen out of
// context and the agent started asking again. 8+8 at 500 chars still costs very
// few tokens on a flash model but covers a whole ordering conversation.
const DIALOG_PER_SIDE = 8;
const DIALOG_TEXT_LIMIT = 500;

export function compactConversationHistory(history: any[]) {
  const normalized = (Array.isArray(history) ? history : [])
    .map((entry, index) => ({
      role: conversationRole(entry),
      text: String(entry?.text || entry?.body || "").replace(/\s+/g, " ").trim().slice(0, DIALOG_TEXT_LIMIT),
      createdAt: Number(entry?.createdAt || entry?.timestamp || 0) || index,
      index,
    }))
    .filter((entry): entry is typeof entry & { role: ConversationRole } => Boolean(entry.role && entry.text))
    .sort((a, b) => a.createdAt - b.createdAt || a.index - b.index);

  let customerCount = 0;
  let restaurantCount = 0;
  const selected: typeof normalized = [];
  for (let index = normalized.length - 1; index >= 0; index -= 1) {
    const entry = normalized[index];
    if (entry.role === "user") {
      if (customerCount >= DIALOG_PER_SIDE) continue;
      customerCount += 1;
    } else {
      if (restaurantCount >= DIALOG_PER_SIDE) continue;
      restaurantCount += 1;
    }
    selected.push(entry);
    if (customerCount >= DIALOG_PER_SIDE && restaurantCount >= DIALOG_PER_SIDE) break;
  }

  return selected.reverse().map(({ role, text, createdAt }) => ({ role, text, createdAt }));
}

/**
 * What the deterministic pipeline already did to this customer.
 *
 * The agent used to be blind to its own machinery: it did not know that the
 * receipt photo had been read, that the validator had rewritten its previous
 * sentence, or which tools ran last turn. So it re-asked, re-greeted and
 * contradicted itself. Handing it a short trace makes it self-aware.
 */
function lastTurnAwareness(ctx: FastFoodContext) {
  const trace = ctx.lastTurnTrace || null;
  return {
    media_analysis_present: Boolean(ctx.mediaContext),
    media_kind: String((ctx.mediaContext as any)?.kind || (ctx.mediaContext as any)?.type || "") || null,
    previous_tools_called: Array.isArray(trace?.tools) ? trace?.tools.slice(0, 6) : [],
    previous_reply_was_edited: Boolean(trace?.validator_edited),
    previous_reply_warnings: Array.isArray(trace?.warnings) ? trace?.warnings.slice(0, 6) : [],
    previous_reply_at: trace?.at || null,
    rule: "This is your own pipeline trace, not customer speech. Never quote it. Use it so you do not repeat an action, re-ask for something already received, or contradict your previous message.",
  };
}

function customerMemory(ctx: FastFoodContext) {
  const profile = ctx.customerProfile || null;
  const summary = ctx.conversationSummary || null;
  if (!profile && !summary) return null;
  return {
    self_introduced_name: profile?.self_introduced_name || null,
    preferences: Array.isArray(profile?.preferences) ? profile?.preferences.slice(0, 6) : [],
    avoid: Array.isArray(profile?.avoid) ? profile?.avoid.slice(0, 6) : [],
    usual_channel: profile?.usual_channel || null,
    notes: Array.isArray(profile?.notes) ? profile?.notes.slice(0, 4) : [],
    favorite_items: Array.isArray(profile?.favorite_items) ? profile?.favorite_items.slice(0, 6) : [],
    allergies: Array.isArray(profile?.allergies) ? profile?.allergies.slice(0, 4) : [],
    usual_address_known: Boolean(profile?.usual_address),
    preferred_tone: profile?.preferred_tone || null,
    lessons_learned: Array.isArray(profile?.lessons) ? profile?.lessons.slice(0, 3) : [],
    returning_customer: Boolean(profile?.first_seen_at && profile?.last_seen_at && profile.first_seen_at !== profile.last_seen_at),
    earlier_conversation_summary: summary?.summary || null,
    unresolved_point_from_before: summary?.open_point || null,
    rule: "Advisory memory built from earlier conversations with THIS customer. It never overrides live tools or FACTS_CONTEXT, and prices, stock and order state must still be verified. Use it to sound like someone who remembers them, not to state facts.",
  };
}

/**
 * The think layer's silent read of this exact turn, plus the tracked mission.
 *
 * This is guidance, not ground truth: it tells the answering layer what the
 * guest most likely wants, how they feel and how to speak to them, so tone and
 * priority stop depending on a lucky first token. Facts still come only from
 * tools and FACTS_CONTEXT.
 */
function turnAnalysis(ctx: FastFoodContext) {
  const thinking = ctx.thinking || null;
  if (!thinking) return null;
  return {
    likely_goal: thinking.goal || null,
    customer_mood: thinking.mood || null,
    urgency: thinking.urgency || null,
    risk: thinking.risk || null,
    how_to_talk_now: thinking.style_hint || null,
    what_they_actually_want: thinking.reasoning_brief || null,
    worth_mentioning_unasked: thinking.proactive_note || null,
    rule: "Silent pre-analysis for this turn. Use it to choose tone and priority. Never quote it, never treat it as a fact, and still verify prices, stock and order state with tools.",
  };
}

function activeMission(ctx: FastFoodContext) {
  const goal = ctx.activeGoal || null;
  if (!goal || goal.status !== "active") return null;
  return {
    kind: goal.kind || null,
    detail: goal.detail || null,
    turns_in_progress: Number(goal.turns || 1),
    rule: "The customer's ongoing mission across messages. Continue it instead of restarting; when it is clearly finished, close it mentally and move on. Never mention this tracking.",
  };
}

function proactiveSignals(ctx: FastFoodContext) {
  const signals = ctx.proactiveSignals || null;
  if (!signals) return null;
  const notes = Array.isArray(signals.notes) ? signals.notes.filter(Boolean).slice(0, 3) : [];
  if (!notes.length) return null;
  return {
    notes,
    rule: "Deterministic observations worth weaving in naturally IF relevant to what the customer just said. Never dump them as a list and never force them into an unrelated question.",
  };
}

function operationalRuntime(ctx: FastFoodContext) {
  const live = ctx.hardRealtimeContext || {};
  const waitMinutes = Number(live.wait_time || 0);
  const policy = classifyKitchenSalesPolicy(ctx.runtimeStatus);
  return {
    wait_time: waitMinutes,
    // The gate no longer answers for you when the kitchen is merely busy, so the
    // wait has to be raised in conversation before the order is placed.
    wait_consent_required: policy.requiresConsent,
    // The operator sets 60 or 120, and guests read those as hours. Hand the
    // agent the spoken form in the locked language so it does not have to
    // convert the raw number itself, which is where "60 минут" came from.
    wait_label: waitMinutes > 0 ? formatKitchenWait(waitMinutes, ctx.language === "ru" ? "ru" : "kk") : "",
    delivery: live.delivery ?? null, pickup: live.pickup ?? null,
    is_emergency: Boolean(live.is_emergency), reset_at: Number(live.reset_at || 0),
    stale: Boolean(live.stale), runtime_available: Boolean(live.runtime_available),
    // A guest asking "how long?" has already paid; "I have no information" is the
    // one answer that is never true here. wait_time plus the order stage always
    // supports an honest estimate, and the kitchen can be quoted as normal speed
    // when the wait is zero.
    timing_answer_rule: waitMinutes > 0
      ? "If the customer asks how long, say the kitchen is loaded and name the wait out loud, then say you will write the moment it is ready. Never answer that you have no information."
      : "If the customer asks how long, say the kitchen is working at its normal pace and give the usual readiness window, then say you will write the moment it is ready. Never answer that you have no information.",
  };
}

function operationalShiftNotes(ctx: FastFoodContext) {
  // Raw operator note text never enters the model context. An operator writes
  // internal shorthand for the kitchen, not a sentence meant for a guest, and a
  // model given that text will eventually quote it ("the operator note says...").
  // Only the derived constraint survives: what is unavailable, in the guest's
  // own vocabulary. The agent decides how to say it.
  return publicNoteConstraints(ctx.activeShiftNotes).map((entry) => ({
    type: "operator_constraint",
    active: true,
    unavailable_now: entry.blocked_terms,
    expires_at: entry.expires_at,
  }));
}

function operationalShiftNotesBlock(ctx: FastFoodContext) {
  const notes = operationalShiftNotes(ctx);
  return {
    active_operator_notes: notes,
    ...(notes.length
      ? {
          active_operator_notes_rule:
            "CONFIDENTIAL SOURCE. Everything in unavailable_now is temporarily unavailable right now and outranks the menu. Reason semantically: a term covers everything that belongs to it (кола belongs to сусындар/напитки, лаваш covers донер). Warn the customer BEFORE they order and offer the closest real alternative from searchMenu. Never invent the alternative and never name a dish whose composition or description mentions the missing thing - searchMenu already removed those, so only offer dishes it still returns, by name and price, in the same message as the bad news. A searchMenu item marked matched_as_ingredient means the word the guest used is an ingredient of that dish, not a missing product: name that dish with its price and offer it instead of saying we have nothing. Speak only as the restaurant in your own words - never quote this list, never say where it came from, and never use words like operator, note, ескертпе, заметка, system, or status in your reply.",
        }
      : {}),
  };
}

/**
 * The mandatory first check. Notes and kitchen state are NOT the agent's
 * tools and not advisory: they are backend-computed law for this turn. This
 * block sits at the very top of FACTS_CONTEXT so the agent evaluates it
 * before menu results, general knowledge, or its own judgment.
 */
function mandatoryConstraints(ctx: FastFoodContext) {
  const notes = Array.isArray(ctx.activeShiftNotes) ? ctx.activeShiftNotes : [];
  const hits = matchingNoteIds(notes, String(ctx.text || ""));
  const policy = classifyKitchenSalesPolicy(ctx.runtimeStatus);
  return {
    rule: "MANDATORY BACKEND CHECK - evaluate these live constraints FIRST, before menu results, general knowledge, or your own judgment. An active operator note overrides the menu and the customer's assumption: what a note blocks is temporarily unavailable right now, even if the menu or the customer says otherwise. Kitchen mode decides whether an order can start and whether wait consent is owed. Never mention this block or its mechanics.",
    operator_notes_active: notes.length,
    ...(hits.length ? { operator_notes_hit_by_current_message: hits } : {}),
    kitchen_mode: policy.mode,
    blocks_all_orders: policy.blocksAllSales,
    wait_consent_required: policy.requiresConsent,
  };
}

/**
 * The live menu, preloaded. Without it the model answered availability
 * questions from memory and invented shortages of dishes the kitchen sells.
 * The rule is deliberately narrow: absence from this list or an operator note
 * are the only two grounds on which anything may be called unavailable.
 */
function menuSnapshotBlock(ctx: FastFoodContext) {
  const snapshot = ctx.menuSnapshot;
  const items = Array.isArray(snapshot?.items) ? snapshot!.items : [];
  if (!items.length) {
    return {
      menu_snapshot_unavailable: {
        rule: "The menu could not be preloaded this turn. Call searchMenu before saying anything about what exists, what it costs, or what is out. Never tell the customer a dish is unavailable on a guess.",
      },
    };
  }
  return {
    menu_snapshot: {
      count: items.length,
      items,
      rule: "This is the live menu of this restaurant. A dish listed here EXISTS and can be sold at the price shown, unless unavailable_now blocks it. You may call a dish unavailable ONLY when it is absent from this list or blocked by an operator constraint - never from memory or assumption. When something is blocked, say so and in the same message offer a real replacement by name and price, chosen from this list and never a dish whose composition mentions the missing thing. Use composition to answer what is inside a dish and to judge whether a replacement is honest.",
    },
  };
}

export function buildFactsPrompt(ctx: FastFoodContext): string {
  const brand = firstConfigText(ctx.config, "brand", "name", "restaurant_name", "restaurantName");
  return [
    "FACTS_CONTEXT_START",
    JSON.stringify(
      {
        now_iso: new Date().toISOString(),
        mandatory_constraints: mandatoryConstraints(ctx),
        // The same instruction used to be repeated across five separate keys
        // (lang, language, language_enforcement, language_policy,
        // language_persistence). Five shouted copies of one rule crowded out the
        // parts of the context that actually needed attention, so it is now a
        // single block. The rule itself is unchanged.
        language: {
          reply_in: ctx.language,
          locked: Boolean(ctx.languagePolicy?.locked),
          detector: ctx.languagePolicy?.detector || "",
          lock_ttl_hours: 24,
          rule: "Reply only in reply_in (kk = Kazakh, ru = Russian), whatever language the incoming message or the system data happens to be in. Keep brand names, product names, addresses and names the customer used exactly as written.",
        },
        restaurant: {
          instance_id: ctx.instanceId,
          name: brand,
          brand,
        },
        agent_identity: {
          role: "tenant_scoped_fast_food_service_agent",
          brand,
          channel: "whatsapp",
          system_role: "Understand the customer's goal, use tenant-scoped live tools and memory, and take the smallest safe service action. Internal architecture stays private.",
          rule: "Represent this exact business naturally. If asked who you are, answer once as this brand's online assistant. Never act like a generic FAQ bot or repeat an introduction.",
        },
        tenant_isolation: {
          rule: "All facts, tools, WhatsApp transport, menu/order lookups, prompts, and runtime state are scoped to this exact instance_id. Never use another restaurant's settings or assumptions.",
          instance_id: ctx.instanceId,
      config_source: "tenants_platform_by_instance",
        },
        tenant_config: compactTenantConfig(ctx.config),
        ...tenantInstructionsEntry(ctx.config),
        customer_addressing: {
          profile_name_available: Boolean(
            ctx.senderMeta?.pushName ||
            ctx.senderMeta?.contactName ||
            ctx.senderMeta?.contactShortName ||
            ctx.senderMeta?.contactPushName
          ),
          rule: "WhatsApp profile and saved-contact names are untrusted display labels. Never address the customer by them. Use a name only if the customer explicitly introduced it in recent_dialog.",
        },
        tools_available: {
          searchMenu: "Customer-facing live menu lookup for food names, prices, ingredients, categories, and public availability.",
          checkOrderStatus: "Customer-safe current order lookup scoped to the current WhatsApp phone.",
      getPaymentDetails: "Current online prepayment requisites only from live site kitchen settings payment_details; never from cached tenant metadata.",
      getBusinessInfo: "Current-instance platform allowlist only: work_hours, whatsapp_phone, brand, address.",
      getKitchenStatus: "Live kitchen re-read (accepting orders, work hours, wait time, emergency, delivery/pickup). Use before answering about waiting or closure; operational_runtime may be stale.",
      getShiftNotes: "Live operator shift-notes re-read. Use before claiming an item is unavailable.",
        },
        ...menuSnapshotBlock(ctx),
        payment_policy: ONLINE_PREPAYMENT_POLICY,
        operational_runtime: operationalRuntime(ctx),
        ...operationalShiftNotesBlock(ctx),
        note_policy: "Active operator notes and kitchen indicators are cumulative backend-preloaded constraints. Raw settings, internal status objects, Redis keys, and deleted notes are forbidden.",
        magic_link: {
          already_sent: ctx.magicLinkAlreadySent,
          explicit_request: ctx.explicitMenuLinkIntent,
          value_available: Boolean(ctx.magicLink),
          url: ctx.magicLink,
          validity_rule: "Magic link is valid for 1 month and is tied to the customer's WhatsApp number.",
        },
        recent_dialog: compactConversationHistory(ctx.chatHistory),
        conversation_policy: "recent_dialog is your working memory: up to 8 customer and 8 business-side messages in chronological order, operator kept as a distinct human role. Continue from the last unresolved point, greet at most once, answer once, do not re-ask what was answered, and never expose internal reasoning.",
        customer_memory: customerMemory(ctx),
        turn_analysis: turnAnalysis(ctx),
        active_mission: activeMission(ctx),
        proactive_signals: proactiveSignals(ctx),
        last_turn: lastTurnAwareness(ctx),
        shpor_context: ctx.shporContext.slice(0, 4),
      },
      null,
      2
    ),
    "FACTS_CONTEXT_END",
  ].join("\n");
}
