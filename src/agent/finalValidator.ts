import type { FastFoodContext } from "../context/types.js";

const WAIT_SENTENCE_RE =
  /[^.!?\n]*(?:\b(?:30|40|50|60|90|120)\s*(?:мин|минут|minute|min)\b|күту|кідіріс|күт|ожидан|задерж)[^.!?\n]*[.!?]?/giu;
const ORDER_STATUS_RE =
  /(тапсырысыңыз|заказыңыз|заказ|order).*(дайындалып|әзірленіп|курьер|жолда|жеткіз|аяқтал|готов|едет|достав|дайын|әзір|даяр)/iu;
const KITCHEN_STATUS_RE =
  /(асүй|ас үй|кухн|kitchen|повар|cook|дайындал|готов|жұмыс істеп|жабық|closed|работает)/iu;
const KAZAKH_SPECIFIC_RE = /[әғқңөұүһіӘҒҚҢӨҰҮҺІ]/u;
const RUSSIAN_SERVICE_WORD_RE =
  /\b(вы|ваш|ваша|можете|пожалуйста|заказ|меню|ссылка|оплата|доставка|сейчас|если|для|через|оператор|админ)\b/iu;
const FORBIDDEN_FOREIGN_SCRIPT_RE = /[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Hangul}\p{Script=Bengali}\p{Script=Devanagari}\p{Script=Thai}]/u;
const MENU_LINK_SENT_RE =
  /(алдыңғы сілтеме|предыдущ ссылк|ескі сілтеме|стара ссылка)/iu;
const URL_RE = /https?:\/\/[^\s<>"')\]]+/gi;

function trimUrlPunctuation(url: string) {
  return String(url || "").trim().replace(/[.,!?;:]+$/g, "");
}

function uniqueUrls(text: string): string[] {
  return Array.from(new Set((String(text || "").match(URL_RE) || []).map(trimUrlPunctuation).filter(Boolean)));
}

function textWithoutUrls(text: string): string {
  return String(text || "").replace(URL_RE, " ").replace(/\s{2,}/g, " ").trim();
}

function sentenceCount(text: string): number {
  const trimmed = textWithoutUrls(text);
  if (!trimmed) return 0;
  const sentences = trimmed.match(/[^.!?]*[.!?]+/g);
  return sentences ? sentences.length : 1;
}

function enforceMaxSentences(text: string, max = 3): string {
  const urls = uniqueUrls(text);
  const trimmed = textWithoutUrls(text);
  if (!trimmed) return text;
  const sentences = trimmed.match(/[^.!?]*[.!?]+/g);
  const body = !sentences || sentences.length <= max ? trimmed : sentences.slice(0, max).map((sentence) => sentence.trim()).join(" ");
  return [body, ...urls].filter(Boolean).join("\n");
}

function stripBotTags(text: string) {
  return String(text || "")
    .replace(/\[([^\]]*)\]\((https?:\/\/[^)\s]+)\)/gi, (_match, label, url) =>
      [String(label || "").trim(), String(url || "").trim()].filter(Boolean).join("\n")
    )
    .replace(/\[(?:Системный Анализ|System Analysis):[\s\S]*?\]/gi, "")
    .replace(/\[ESCALATE_ADMIN\]/gi, "")
    .replace(/\[ESCALATE_DEVELOPER\]/gi, "")
    .replace(/\[IGNORE_MESSAGE\]/gi, "")
    .replace(/\*\*/g, "")
    .replace(/\*/g, "")
    .trim();
}

function fallback(ctx: FastFoodContext) {
  return ctx.language === "kk"
    ? "Қалай көмектесе аламын? 😊"
    : "Как могу помочь? 😊";
}

function noActiveOrderText(ctx: FastFoodContext) {
  return ctx.language === "kk"
    ? "Қазір белсенді тапсырысыңыз жоқ."
    : "Сейчас нет активного заказа.";
}

function runtimeUnavailableText(ctx: FastFoodContext) {
  return ctx.language === "kk"
    ? "Қазір асүй статусын тексере алмаймын. Кейін қайталап жазыңыз."
    : "Не могу проверить статус кухни. Напишите позже.";
}

function hasLinkInResponse(text: string): boolean {
  return uniqueUrls(text).length > 0;
}

function isLikelyMagicLinkUrl(url: string, magicLink: string): boolean {
  try {
    const magicHost = new URL(magicLink).hostname.replace(/\.+$/g, "").toLowerCase();
    const host = new URL(url).hostname.replace(/\.+$/g, "").toLowerCase();
    return host === magicHost || magicHost.startsWith(`${host}.`) || host === magicHost.split(".")[0];
  } catch {
    try {
      const magicHost = new URL(magicLink).hostname.replace(/\.+$/g, "").toLowerCase();
      const firstLabel = magicHost.split(".")[0];
      const lowerUrl = url.toLowerCase();
      return lowerUrl.startsWith(`http://${firstLabel}`) || lowerUrl.startsWith(`https://${firstLabel}`);
    } catch {
      return false;
    }
  }
}

function enforceExactMagicLink(text: string, ctx: FastFoodContext): string {
  if (!ctx.magicLink || !hasLinkInResponse(text)) return text;
  return String(text || "").replace(URL_RE, (url) => {
    const cleanUrl = trimUrlPunctuation(url);
    return isLikelyMagicLinkUrl(cleanUrl, ctx.magicLink || "") ? ctx.magicLink || cleanUrl : cleanUrl;
  });
}

export function validateFinalText(rawText: string, ctx: FastFoodContext): {
  text: string;
  hasLink: boolean;
  warnings: string[];
} {
  let text = stripBotTags(String(rawText || "").trim());
  const warnings: string[] = [];

  if (!text) return { text: fallback(ctx), hasLink: false, warnings: ["empty_model_output"] };

  // Foreign-script corruption is a transport/model failure, not a style issue.
  if (FORBIDDEN_FOREIGN_SCRIPT_RE.test(text)) {
    return { text: fallback(ctx), hasLink: false, warnings: ["foreign_script_output"] };
  }
  // Mixed-language heuristics are diagnostic only. Product and brand names often
  // legitimately cross the language boundary, so replacing the whole answer with
  // a generic phrase destroyed otherwise useful replies.
  if (ctx.language === "ru" && KAZAKH_SPECIFIC_RE.test(text)) {
    warnings.push("possible_kazakh_in_russian_reply");
  }
  if (ctx.language === "kk" && RUSSIAN_SERVICE_WORD_RE.test(text)) {
    warnings.push("possible_russian_in_kazakh_reply");
  }

  // Safety-critical factual guards remain deterministic.
  if (!ctx.runtimeStatus || ctx.hardRealtimeContext?.stale) {
    if (KITCHEN_STATUS_RE.test(text)) {
      return { text: runtimeUnavailableText(ctx), hasLink: false, warnings: [...warnings, "unsupported_kitchen_claim"] };
    }
  }

  const liveWaitTime = Number(ctx.fetchedSettings?.wait_time || 0);
  if (!liveWaitTime) {
    if (WAIT_SENTENCE_RE.test(text)) warnings.push("unsupported_wait_claim_removed");
    WAIT_SENTENCE_RE.lastIndex = 0;
    text = text.replace(WAIT_SENTENCE_RE, "").replace(/\s{2,}/g, " ").trim();
  }

  if (!ctx.activeOrder && ORDER_STATUS_RE.test(text)) {
    return { text: noActiveOrderText(ctx), hasLink: false, warnings: [...warnings, "unsupported_order_claim"] };
  }

  // Link integrity and duplicate suppression are transport contracts.
  const hasLinkInText = hasLinkInResponse(text);
  if (ctx.magicLinkAlreadySent && !ctx.explicitMenuLinkIntent && hasLinkInText) {
    text = text.replace(URL_RE, "").replace(/\s{2,}/g, " ").trim();
    warnings.push("duplicate_menu_link_removed");
    if (MENU_LINK_SENT_RE.test(text)) return { text: text || fallback(ctx), hasLink: false, warnings };
    return { text: text || fallback(ctx), hasLink: false, warnings };
  }

  text = enforceExactMagicLink(text, ctx);

  if (sentenceCount(text) > 3) {
    text = enforceMaxSentences(text, 3);
    warnings.push("reply_truncated_to_three_sentences");
  }

  return { text: text || fallback(ctx), hasLink: hasLinkInResponse(text), warnings };
}
