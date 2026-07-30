import type { FastFoodContext } from "../context/types.js";

// Only an unverified CONCRETE duration is a factual violation. The old pattern
// also matched the bare stem "күт", so every polite "күте тұрыңыз" / "бір минут"
// sentence was deleted whenever wait_time was 0 - which is most of the time.
// That single regex is what made replies read like a stripped-down machine.
const WAIT_TIME_CLAIM_RE =
  /[^.!?\n]*\d{1,3}\s*(?:мин|минут|minute|min|сағат|саг\.|час|часа|часов)[^.!?\n]*[.!?]?/giu;
// Soft signal only: polite waiting language stays in the reply, it is just
// reported in warnings so the audit log still shows it.
const SOFT_WAIT_HINT_RE = /(күте тұр|күтіп тұр|күтіңіз|подожд|ожидай)/iu;
const ORDER_STATUS_RE =
  /(тапсырысыңыз|заказыңыз|заказ|order).*(дайындалып|әзірленіп|курьер|жолда|жеткіз|аяқтал|готов|едет|достав|дайын|әзір|даяр)/iu;
// Bare "дайын"/"готов"/"работает" appear in ordinary menu and order replies too,
// so the kitchen guard now demands an explicit kitchen subject next to the
// claim. Otherwise a correct answer got replaced by the canned kitchen line.
const KITCHEN_STATUS_RE =
  /(асүй|ас\s?үй|кухн|kitchen)[^.!?\n]{0,40}?(дайын|әзір|жұмыс|ашық|жабық|бос|істе|готов|работа|открыт|закрыт|загружен|busy|closed|open)/iu;
const KAZAKH_SPECIFIC_RE = /[әғқңөұүһіӘҒҚҢӨҰҮҺІ]/u;
// JavaScript's \\b is ASCII-based and misses Cyrillic boundaries, so the old
// detector silently accepted a fully Russian answer in a Kazakh conversation.
const RUSSIAN_SERVICE_WORD_RE =
  /(?:^|[^\p{L}])(вы|ваш|ваша|можете|пожалуйста|заказ|меню|ссылка|оплата|доставка|сейчас|если|для|через|оператор|админ|к сожалению|хотите)(?=$|[^\p{L}])/iu;
const FORBIDDEN_FOREIGN_SCRIPT_RE = /[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Hangul}\p{Script=Bengali}\p{Script=Devanagari}\p{Script=Thai}]/u;
const MENU_LINK_SENT_RE =
  /(алдыңғы сілтеме|предыдущ ссылк|ескі сілтеме|стара ссылка)/iu;
// Hallucination guards. A price or promo the model "remembers" is the single
// most damaging lie a food bot can tell, so such claims may only survive when
// a live tool grounded them this turn. Clause-cut, never reply-replace.
const PRICE_CLAIM_RE =
  /[^.!?\n]*\d[\d\s]*(?:тенге|теңге|тг|₸)[^.!?\n]*[.!?]?/iu;
const PROMO_CLAIM_RE =
  /[^.!?\n]*(?:скидк|жеңілді|акци|бонус|промо|подарок|сыйлық|тегін|бесплатн)[^.!?\n]*(?:\d|%|бар|есть|жүріп|идет|действу|береміз|даём)[^.!?\n]*[.!?]?/iu;
const PRICE_GROUNDING_TOOLS = ["searchMenu", "checkOrderStatus", "getPaymentDetails"];
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

/**
 * Removes only the sentences that make an unverifiable claim and keeps the rest
 * of the reply intact. URLs are preserved, because a stripped clause must never
 * cost the customer the link they asked for.
 */
function dropSentencesMatching(text: string, pattern: RegExp): string {
  const urls = uniqueUrls(text);
  const body = textWithoutUrls(text);
  const sentences = body.match(/[^.!?\n]+[.!?]*/g) || [body];
  const kept = sentences
    .map((sentence) => sentence.trim())
    .filter((sentence) => sentence && !new RegExp(pattern.source, pattern.flags.replace(/[gy]/g, "")).test(sentence));
  const rebuilt = kept.join(" ").replace(/\s{2,}/g, " ").trim();
  if (!rebuilt) return "";
  return urls.length ? `${rebuilt}\n${urls.join("\n")}` : rebuilt;
}

function enforceMaxSentences(text: string, max = 5): string {
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

// The prompt forbids emoji by default, yet the deterministic fallback shipped
// one - so the single most frequently sent sentence contradicted the persona.
function fallback(ctx: FastFoodContext) {
  return ctx.language === "kk"
    ? "Тыңдап тұрмын, не қажет екенін жазыңыз."
    : "Слушаю, напишите, что нужно.";
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

export function validateFinalText(
  rawText: string,
  ctx: FastFoodContext,
  grounding?: { toolsCalled?: string[] }
): {
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

  // Safety-critical factual guards remain deterministic, but they now cut the
  // offending clause instead of throwing away a whole useful answer. Replacing
  // the entire reply with a canned line is what made the bot feel dead: one
  // stale runtime read turned a good menu answer into "I cannot check that".
  if (!ctx.runtimeStatus || ctx.hardRealtimeContext?.stale) {
    if (KITCHEN_STATUS_RE.test(text)) {
      const withoutKitchenClaims = dropSentencesMatching(text, KITCHEN_STATUS_RE);
      if (withoutKitchenClaims) {
        text = withoutKitchenClaims;
        warnings.push("unsupported_kitchen_claim_clause_removed");
      } else {
        return { text: runtimeUnavailableText(ctx), hasLink: false, warnings: [...warnings, "unsupported_kitchen_claim"] };
      }
    }
  }

  const liveWaitTime = Number(ctx.fetchedSettings?.wait_time || 0);
  if (!liveWaitTime) {
    WAIT_TIME_CLAIM_RE.lastIndex = 0;
    const hasUnsupportedWaitClaim = WAIT_TIME_CLAIM_RE.test(text);
    WAIT_TIME_CLAIM_RE.lastIndex = 0;
    if (hasUnsupportedWaitClaim) {
      const strippedTimeClaims = text.replace(WAIT_TIME_CLAIM_RE, "").replace(/\s{2,}/g, " ").trim();
      // Never let the guard empty the whole reply. Before, a one-sentence answer
      // that mentioned a duration was deleted down to nothing and the customer
      // received the generic fallback instead of an answer.
      if (strippedTimeClaims) {
        text = strippedTimeClaims;
        warnings.push("unsupported_wait_claim_removed");
      } else {
        warnings.push("unsupported_wait_claim_only_sentence");
      }
    }
    if (SOFT_WAIT_HINT_RE.test(text)) warnings.push("polite_wait_phrase_kept");
  }

  if (!ctx.activeOrder && ORDER_STATUS_RE.test(text)) {
    // Same principle as the kitchen guard: cut the false order claim, keep the
    // rest of the answer. Only when nothing survives do we fall back to the
    // deterministic "no active order" line.
    const withoutOrderClaims = dropSentencesMatching(text, ORDER_STATUS_RE);
    if (withoutOrderClaims) {
      text = withoutOrderClaims;
      warnings.push("unsupported_order_claim_clause_removed");
    } else {
      return { text: noActiveOrderText(ctx), hasLink: false, warnings: [...warnings, "unsupported_order_claim"] };
    }
  }

  // Link integrity and duplicate suppression are transport contracts.
  const hasUnrequestedMenuLink = Boolean(
    ctx.magicLink
    && !ctx.explicitMenuLinkIntent
    && uniqueUrls(text).some((url) => isLikelyMagicLinkUrl(url, ctx.magicLink || ""))
  );
  if (hasUnrequestedMenuLink) {
    text = text.replace(URL_RE, (url) =>
      isLikelyMagicLinkUrl(trimUrlPunctuation(url), ctx.magicLink || "") ? "" : url
    ).replace(/\s{2,}/g, " ").trim();
    warnings.push(ctx.magicLinkAlreadySent ? "duplicate_menu_link_removed" : "unrequested_menu_link_removed");
    if (MENU_LINK_SENT_RE.test(text)) return { text: text || fallback(ctx), hasLink: false, warnings };
    return { text: text || fallback(ctx), hasLink: false, warnings };
  }

  text = enforceExactMagicLink(text, ctx);

  // Ungrounded factual claims: only enforced when the caller reports which
  // tools actually ran this turn. When the report is absent (older callers,
  // unit tests), behavior is byte-identical to before.
  if (grounding && Array.isArray(grounding.toolsCalled)) {
    const grounded = grounding.toolsCalled.some((tool) => PRICE_GROUNDING_TOOLS.includes(tool));
    if (!grounded) {
      if (PRICE_CLAIM_RE.test(text)) {
        const withoutPrices = dropSentencesMatching(text, PRICE_CLAIM_RE);
        if (withoutPrices && withoutPrices !== text) {
          text = withoutPrices;
          warnings.push("ungrounded_price_claim_removed");
        } else {
          warnings.push("ungrounded_price_claim_kept_no_survivor");
        }
      }
      if (PROMO_CLAIM_RE.test(text)) {
        const withoutPromos = dropSentencesMatching(text, PROMO_CLAIM_RE);
        if (withoutPromos && withoutPromos !== text) {
          text = withoutPromos;
          warnings.push("unverified_promo_claim_removed");
        } else {
          warnings.push("unverified_promo_claim_kept_no_survivor");
        }
      }
    }
  }

  // A hard three-sentence cut amputated real answers mid-thought ("here are the
  // options, the price is X" lost the closing question). Brevity now belongs to
  // the prompt; the validator only stops genuine runaway output.
  const REPLY_MAX_SENTENCES = 5;
  const REPLY_MAX_CHARS = 600;
  if (sentenceCount(text) > REPLY_MAX_SENTENCES || textWithoutUrls(text).length > REPLY_MAX_CHARS) {
    text = enforceMaxSentences(text, REPLY_MAX_SENTENCES);
    warnings.push("reply_length_capped");
  }

  return { text: text || fallback(ctx), hasLink: hasLinkInResponse(text), warnings };
}
