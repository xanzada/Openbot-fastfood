import type { FastFoodContext } from "../context/types.js";

/**
 * How to SPEAK on this turn, computed in code from what the guest actually does.
 *
 * Tone used to live only inside a paragraph of prompt text, so "adapt to the
 * customer" was a hope rather than an input: the model never saw whether this
 * person writes two words or five lines, whether they use emoji at all, or
 * whether they address us formally. It answered every guest in the same register
 * and at the same length (owner report, 2026-08-24).
 *
 * Everything here is deterministic and free - no extra model call, no latency.
 * It is guidance for wording only: it can never change a fact, a business rule,
 * or whether a tool must run.
 */

export type CustomerRegister = "casual" | "neutral" | "formal";
export type ReplyLength = "tight" | "short" | "roomy";
export type EmojiPolicy = "none" | "sparing" | "mirror";

export interface CustomerStyle {
  register: CustomerRegister;
  usesEmoji: boolean;
  writesShort: boolean;
  writesLong: boolean;
  shouting: boolean;
  sampleSize: number;
}

export interface ResponsePlan {
  length: ReplyLength;
  maxSentences: number;
  emoji: EmojiPolicy;
  segments: "single" | "split";
  register: CustomerRegister;
  rule: string;
}

const EMOJI_RE = /[\u{1F300}-\u{1FAFF}\u{2600}-\u{27BF}\u{FE0F}\u{1F900}-\u{1F9FF}]/u;
// Formal address in both languages: the polite second person, honorifics, and the
// full greetings people use when they want to keep a distance.
const FORMAL_RE =
  /(сіздің|сізге|сізде|сіз\b|өтінемін|рақмет сізге|құрметті|здравствуйте|пожалуйста|будьте добры|подскажите пожалуйста|вы могли бы|уважаем)/iu;
const CASUAL_RE =
  /(сен\b|сенде|сенің|қанша\?|ей\b|ау\b|бро|дос|привет|прив|слушай|дай|скинь|давай|ну\b)/iu;

function customerMessages(ctx: FastFoodContext, lookback = 8): string[] {
  const history = Array.isArray(ctx.chatHistory) ? ctx.chatHistory : [];
  const fromHistory = history
    .filter((entry: any) => {
      const role = String(entry?.role || "").toLowerCase();
      return role === "user" || entry?.direction === "incoming" || entry?.fromMe === false;
    })
    .map((entry: any) => String(entry?.text || entry?.content || "").trim())
    .filter(Boolean);
  const current = String(ctx.text || "").trim();
  const all = current ? [...fromHistory, current] : fromHistory;
  return all.slice(-lookback);
}

export function readCustomerStyle(ctx: FastFoodContext): CustomerStyle {
  const messages = customerMessages(ctx);
  const current = String(ctx.text || "").trim();
  if (!messages.length) {
    return { register: "neutral", usesEmoji: false, writesShort: false, writesLong: false, shouting: false, sampleSize: 0 };
  }
  const lengths = messages.map((value) => value.length);
  const average = lengths.reduce((sum, value) => sum + value, 0) / lengths.length;
  const joined = messages.join(" ");
  // The register is judged on the WHOLE conversation, because a guest who opened
  // formally stays formal even in a two-word follow-up.
  const formal = FORMAL_RE.test(joined);
  const casual = CASUAL_RE.test(joined);
  return {
    register: formal && !casual ? "formal" : casual && !formal ? "casual" : "neutral",
    // Emoji is mirrored only when the guest uses it themselves - forcing one on
    // someone who never does reads like a machine trying to be friendly.
    usesEmoji: messages.some((value) => EMOJI_RE.test(value)),
    writesShort: average <= 24,
    writesLong: average >= 90 || current.length >= 140,
    // Real shouting, not one excited "!": all-caps words or repeated marks.
    shouting: /[A-ZА-ЯЁӘҒҚҢӨҰҮҺІ]{4,}/u.test(current) || /(!{2,}|\?{2,})/.test(current),
    sampleSize: messages.length,
  };
}

/**
 * The wording plan for this turn: how long the answer may be, whether it should
 * arrive as one message or a couple of short ones, and whether an emoji fits.
 *
 * Business content is decided elsewhere and always wins - a mandatory wait
 * question or a blocked-dish warning is said in full even under a "tight" plan.
 */
export function planResponse(ctx: FastFoodContext, style: CustomerStyle = readCustomerStyle(ctx)): ResponsePlan {
  const analysis: any = ctx.thinking || null;
  const mood = String(analysis?.mood || "neutral");
  const complexity = String(analysis?.complexity || "moderate");
  const urgency = String(analysis?.urgency || "normal");
  const risk = String(analysis?.risk || "low");

  // Rushed or shouting guests get the answer, not the paragraph. Confused ones
  // get room to be walked through it. Everything else follows the guest's own
  // message length.
  const length: ReplyLength =
    urgency === "high" || mood === "rushed" || style.shouting
      ? "tight"
      : mood === "confused" || mood === "unsure" || complexity === "complex" || style.writesLong
        ? "roomy"
        : style.writesShort
          ? "tight"
          : "short";

  const maxSentences = length === "tight" ? 2 : length === "short" ? 3 : 4;

  // Never decorate an apology, a payment or a delay. Otherwise mirror the guest.
  const emojiForbidden = mood === "upset" || mood === "angry" || risk === "high";
  const emoji: EmojiPolicy = emojiForbidden ? "none" : style.usesEmoji ? "mirror" : "sparing";

  // Several ideas, or room to breathe, arrive as a person types them: a couple of
  // short messages instead of one block.
  const segments: ResponsePlan["segments"] = length === "roomy" || complexity === "complex" ? "split" : "single";

  const rule = [
    `Answer in at most ${maxSentences} short sentences.`,
    segments === "split"
      ? "When it carries more than one idea, break it into two or three short messages separated by a blank line, the way a person types."
      : "Keep it to one short message.",
    emoji === "none"
      ? "No emoji on this turn."
      : emoji === "mirror"
        ? "This guest uses emoji, so at most one that genuinely fits is welcome."
        : "This guest writes without emoji - do not add one unless it is a warm greeting or thank-you.",
    style.register === "formal"
      ? "They address us politely: keep the polite register, no slang."
      : style.register === "casual"
        ? "They write casually: relaxed and friendly, still respectful."
        : "Ordinary friendly register.",
    "This shapes WORDING only - never drop a required warning, a wait question, or a verified fact to make the reply shorter.",
  ].join(" ");

  return { length, maxSentences, emoji, segments, register: style.register, rule };
}

/**
 * How fast the reply should be paced on the wire.
 *
 * The typing rhythm is there to make the bot feel human, but a guest who is angry,
 * in a hurry, or being handed to an operator must not watch a performance - for them
 * speed IS the courtesy. Read from the same silent analysis the wording plan uses, so
 * the two never disagree about the mood of the turn.
 */
export function resolvePaceUrgency(ctx: FastFoodContext): "urgent" | "normal" | "calm" {
  const analysis: any = ctx.thinking || null;
  const mood = String(analysis?.mood || "");
  const urgency = String(analysis?.urgency || "");
  const risk = String(analysis?.risk || "");
  if (urgency === "high" || risk === "high" || ["rushed", "upset", "angry"].includes(mood)) return "urgent";
  // A confused guest benefits from the slower, more deliberate rhythm - it reads as
  // someone taking care rather than firing back.
  if (["confused", "unsure"].includes(mood)) return "calm";
  return "normal";
}
