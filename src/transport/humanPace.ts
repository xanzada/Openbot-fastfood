/**
 * How long a human would have taken to type this, and how they would have paced it.
 *
 * The bot answered instantly and in one push, which is the single clearest tell that
 * nobody is on the other side (owner request, 2026-08-29: "бірден жазбасын, ойланып
 * толғанып барып үзіп үзіп адам секілді жазсын, сөйлемді аяқтап").
 *
 * Everything here is arithmetic on the text itself - no model call, no extra latency
 * beyond the deliberate pause, and every number is bounded so a long reply can never
 * hold the guest for an unreasonable time.
 */

import { envNumber } from "../utils/envNumber.js";

// A fast phone typist lands around 220-260 characters per minute. Slower than that
// and a two-line reply feels sluggish; faster and the pause stops reading as typing.
const CHARS_PER_MINUTE = envNumber(process.env.OPENBOT_TYPING_CPM, 240, { min: 60, max: 1200 });
// The beat before the first character: reading the guest's message and deciding.
const READ_MIN_MS = envNumber(process.env.OPENBOT_READ_PAUSE_MIN_MS, 700, { min: 0, max: 10_000 });
const READ_MAX_MS = envNumber(process.env.OPENBOT_READ_PAUSE_MAX_MS, 2200, { min: 0, max: 15_000 });
// No single message may hold the guest longer than this, however long the text is.
const TYPING_CAP_MS = envNumber(process.env.OPENBOT_TYPING_CAP_MS, 6500, { min: 500, max: 30_000 });
const TYPING_FLOOR_MS = envNumber(process.env.OPENBOT_TYPING_FLOOR_MS, 550, { min: 0, max: 5_000 });
// The whole reply, every chunk and pause together, is bounded too: an operator
// waiting on an escalation must not sit behind a leisurely three-part answer.
const TOTAL_BUDGET_MS = envNumber(process.env.OPENBOT_HUMAN_PACE_BUDGET_MS, 14_000, { min: 1_000, max: 60_000 });

export type PaceUrgency = "urgent" | "normal" | "calm";

export interface HumanPacing {
  /** Pause before the first message, while "reading" what the guest wrote. */
  readPauseMs: number;
  /** Per-chunk typing time, in the order the chunks will be sent. */
  typingMs: number[];
  totalMs: number;
}

function jitter(min: number, max: number, random: () => number) {
  if (max <= min) return Math.max(0, Math.round(min));
  return Math.round(min + random() * (max - min));
}

/**
 * Typing time for one message.
 *
 * Length drives it, and a spread of ±18% keeps two similar replies from arriving on
 * identical beats - a fixed formula is its own kind of tell.
 */
export function typingTimeMs(text: string, random: () => number = Math.random): number {
  const length = String(text || "").trim().length;
  if (!length) return 0;
  const base = (length / CHARS_PER_MINUTE) * 60_000;
  const spread = 0.82 + random() * 0.36;
  return Math.min(TYPING_CAP_MS, Math.max(TYPING_FLOOR_MS, Math.round(base * spread)));
}

/**
 * The rhythm for a whole reply.
 *
 * `urgent` collapses the pauses to almost nothing: a guest who is angry, or one being
 * handed to an operator, must not watch a leisurely typing animation. `calm` is the
 * ordinary case. The total is clamped to TOTAL_BUDGET_MS by scaling every part down
 * proportionally, so the shape survives even when the text is very long.
 */
export function planHumanPacing(
  chunks: string[],
  urgency: PaceUrgency = "normal",
  random: () => number = Math.random
): HumanPacing {
  const texts = (Array.isArray(chunks) ? chunks : []).map((chunk) => String(chunk || "")).filter((chunk) => chunk.trim());
  if (!texts.length) return { readPauseMs: 0, typingMs: [], totalMs: 0 };

  // A guest in a hurry gets the answer, not the performance. Kept nonzero so the
  // reply still lands after the "typing…" indicator rather than before it.
  const scale = urgency === "urgent" ? 0.25 : urgency === "calm" ? 1 : 0.75;

  const readPauseMs = Math.round(jitter(READ_MIN_MS, READ_MAX_MS, random) * scale);
  const typingMs = texts.map((text) => Math.round(typingTimeMs(text, random) * scale));

  const rawTotal = readPauseMs + typingMs.reduce((sum, value) => sum + value, 0);
  if (rawTotal <= TOTAL_BUDGET_MS) {
    return { readPauseMs, typingMs, totalMs: rawTotal };
  }
  // Over budget: shrink everything by the same factor. Proportional scaling keeps the
  // longer message visibly longer, which is what makes the rhythm read as typing.
  const factor = TOTAL_BUDGET_MS / rawTotal;
  const scaledRead = Math.round(readPauseMs * factor);
  const scaledTyping = typingMs.map((value) => Math.max(120, Math.round(value * factor)));
  // Rounding each part independently can land a few milliseconds ABOVE the budget, and a
  // budget that is only nearly respected is not a budget. The remainder is taken off the
  // longest waits first, down to the per-message floor, so the shape survives the trim.
  let overshoot = scaledRead + scaledTyping.reduce((sum, value) => sum + value, 0) - TOTAL_BUDGET_MS;
  while (overshoot > 0) {
    const trimmable = scaledTyping
      .map((value, index) => ({ value, index }))
      .filter((entry) => entry.value > 120)
      .sort((a, b) => b.value - a.value);
    if (!trimmable.length) break;
    for (const entry of trimmable) {
      if (overshoot <= 0) break;
      const room = Math.min(entry.value - 120, overshoot);
      scaledTyping[entry.index] -= room;
      overshoot -= room;
    }
  }
  return {
    readPauseMs: scaledRead,
    typingMs: scaledTyping,
    totalMs: scaledRead + scaledTyping.reduce((sum, value) => sum + value, 0),
  };
}

/**
 * Never split a sentence across two WhatsApp messages.
 *
 * "сөйлемді аяқтап" - the owner's word for the thing that matters. The transport's
 * size-based chunker cuts on a character budget, so a long sentence could be torn in
 * half and the guest saw a fragment arrive on its own. This regroups already-split
 * pieces so every message ends on a sentence boundary, merging a fragment back into
 * its neighbour rather than sending it alone.
 *
 * A chunk that is one enormous sentence with no terminator is left exactly as it is:
 * there is nothing to merge it with, and truncating a fact to make the shape neat
 * would be worse than an ugly message.
 */
const SENTENCE_END_RE = /[.!?…]["»)]?$/u;

export function regroupBySentence(chunks: string[], maxChars: number): string[] {
  const source = (Array.isArray(chunks) ? chunks : []).map((chunk) => String(chunk || "").trim()).filter(Boolean);
  if (source.length < 2) return source;

  const out: string[] = [];
  for (const chunk of source) {
    const previous = out[out.length - 1];
    // A URL is always its own message (the transport guarantees it elsewhere) and must
    // never be glued to prose here.
    const isLink = /^https?:\/\/\S+$/i.test(chunk);
    const previousIsLink = previous ? /^https?:\/\/\S+$/i.test(previous) : false;
    const previousUnfinished = Boolean(previous) && !SENTENCE_END_RE.test(previous!) && !previousIsLink;
    if (previousUnfinished && !isLink && `${previous} ${chunk}`.length <= maxChars) {
      out[out.length - 1] = `${previous} ${chunk}`.replace(/\s{2,}/g, " ").trim();
      continue;
    }
    out.push(chunk);
  }
  return out;
}
