import type { FastFoodContext } from "../context/types.js";

/**
 * What this bot has ALREADY said to this guest, so it stops saying it again.
 *
 * "Сөйлем қорын кеңейту керек" (owner, 2026-08-29). The instructions have always
 * asked for fresh wording, but asking is not an input: the model could not see that
 * it had opened the last four replies with "Сәлеметсіз бе!" and closed each one with
 * the same invitation, because recent_dialog is a wall of text it skims for facts,
 * not a list of its own habits. Repetition is what makes a bot sound like a bot even
 * when every fact is right.
 *
 * This extracts the openings and the closing lines actually used recently and hands
 * them over as things to avoid. Deterministic, free, no model call - and wording-only:
 * it can never suppress a required warning, a price, or a mandatory question.
 */

const CLOSING_HINT_RE =
  /(сұрағыңыз болса|қысылмай|хабарласыңыз|жазыңыз|күтеміз|рақмет|спрашивайте|на связи|обращайтесь|напишите|ждём|ждем|спасибо)/iu;

function assistantMessages(ctx: FastFoodContext, lookback = 10): string[] {
  const history = Array.isArray(ctx.chatHistory) ? ctx.chatHistory : [];
  return history
    .filter((entry: any) => {
      const role = String(entry?.role || "").toLowerCase();
      // The operator is a different human writing in their own voice; their phrasing
      // is not the bot's habit and must not be treated as one.
      const source = String(entry?.source || "").toLowerCase();
      if (source === "operator_panel" || source === "whatsapp_app" || role === "operator") return false;
      return ["assistant", "model", "bot", "ai"].includes(role) || entry?.direction === "outgoing" || entry?.fromMe === true;
    })
    .map((entry: any) => String(entry?.text || entry?.content || "").replace(/\s+/g, " ").trim())
    .filter(Boolean)
    .slice(-lookback);
}

function sentencesOf(text: string): string[] {
  return (text.match(/[^.!?…]+[.!?…]*/gu) || [])
    .map((part) => part.trim())
    .filter((part) => part.length >= 3);
}

/** The first few words of a message - the part a guest notices repeating. */
function openingOf(text: string): string {
  const words = text.split(" ").filter(Boolean).slice(0, 4).join(" ");
  return words.replace(/[.,!?…:;]+$/u, "").trim();
}

export interface PhrasingMemory {
  openings: string[];
  closings: string[];
  repeatedOpening: string | null;
}

export function readPhrasingMemory(ctx: FastFoodContext): PhrasingMemory {
  const messages = assistantMessages(ctx);
  if (!messages.length) return { openings: [], closings: [], repeatedOpening: null };

  const openings: string[] = [];
  const closings: string[] = [];
  for (const message of messages) {
    const sentences = sentencesOf(message);
    if (!sentences.length) continue;
    const opening = openingOf(sentences[0]);
    if (opening) openings.push(opening);
    // Only the last sentence, and only when it reads like a sign-off rather than a
    // fact: cutting a price line as a "closing" would be a real loss.
    const last = sentences[sentences.length - 1];
    if (sentences.length > 1 && CLOSING_HINT_RE.test(last) && last.length <= 140) closings.push(last.trim());
  }

  // A phrase repeated twice or more is a habit, and the newest one is the one the
  // guest just read - that is the one worth naming explicitly.
  const counts = new Map<string, number>();
  for (const opening of openings) {
    const key = opening.toLowerCase();
    counts.set(key, (counts.get(key) || 0) + 1);
  }
  const lastOpening = openings[openings.length - 1] || "";
  const repeatedOpening = lastOpening && (counts.get(lastOpening.toLowerCase()) || 0) >= 2 ? lastOpening : null;

  const unique = (values: string[]) => Array.from(new Set(values.map((value) => value.trim()).filter(Boolean)));
  return {
    openings: unique(openings).slice(-6),
    closings: unique(closings).slice(-4),
    repeatedOpening,
  };
}

/**
 * The FACTS_CONTEXT block. Null when there is nothing to avoid yet, so a first
 * conversation carries no extra weight.
 */
export function phrasingMemoryBlock(ctx: FastFoodContext) {
  const memory = readPhrasingMemory(ctx);
  if (!memory.openings.length && !memory.closings.length) return null;
  return {
    openings_you_already_used: memory.openings,
    ...(memory.closings.length ? { closing_lines_you_already_used: memory.closings } : {}),
    ...(memory.repeatedOpening ? { opening_you_are_overusing: memory.repeatedOpening } : {}),
    rule: [
      "These are YOUR OWN recent wordings with this guest. Open this reply differently and close it differently - a person never starts four messages the same way.",
      "Reach for a different verb, a different sentence shape, a different way into the same idea. Greet again only if real time has passed or they greeted you first.",
      "A closing invitation belongs where a person would really say it, not on every message; if you used one recently, simply end on the answer.",
      "This shapes WORDING only. Never drop or soften a verified fact, a price, a warning or a required question to make the sentence fresh, and never mention this list.",
    ].join(" "),
  };
}
