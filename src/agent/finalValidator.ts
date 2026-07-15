import type { FastFoodContext } from "../context/types.js";

const WAIT_SENTENCE_RE =
  /[^.!?\n]*(?:\b(?:30|40|50|60|90|120)\s*(?:мин|минут|minute|min)\b|күту|кідіріс|күт|ожидан|задерж)[^.!?\n]*[.!?]?/giu;
const ORDER_STATUS_RE =
  /(тапсырысыңыз|заказыңыз|заказ|order).*(дайындалып|әзірленіп|курьер|жолда|жеткіз|аяқтал|готов|едет|достав|дайын|әзір|даяр)/iu;
const KITCHEN_STATUS_RE =
  /(асүй|ас үй|кухн|kitchen|повар|cook|дайындал|готов|жұмыс істеп|жабық|closed|работает)/iu;
const KAZAKH_SPECIFIC_RE = /[әғқңөұүһіӘҒҚҢӨҰҮҺІУ™Т“Т›ТЈУ©Т±ТЇС–УТ’ТљТўУЁТ°Т®]/u;
const RUSSIAN_SERVICE_WORD_RE =
  /\b(вы|ваш|ваша|можете|пожалуйста|заказ|меню|ссылка|оплата|доставка|сейчас|если|для|через|оператор|админ)\b/iu;
const OTHER_CITY_DELIVERY_RE =
  /(зачаганск|зашаған|зачаган|zachagansk|zachagan|zashaған|басқа\s+қала|баска\s+кала|другой\s+город|в\s+другой\s+город)/iu;
const MENU_TOPIC_RE =
  /(мәзір|меню|menu|бар ма|барма|каталог|catalog|пицц|бургер|донер|шаурм|салат|суп|напит|десерт|комбо|сеты|ассортимент|не бар|что есть|прайс|баға|цена|сколько стоит|қанша тұра|қанша тура|прейскурант)/iu;
const PAYMENT_TOPIC_RE =
  /(төлем|оплат|kaspi|halyk|карт|реквизит|перевод|аудар|чек|receipt|қолма-қол|налич)/iu;
const DELIVERY_TOPIC_RE =
  /(жеткіз|достав|курьер|courier|jetkiz|aparyp|алып кел)/iu;
const ORDER_TOPIC_RE =
  /(тапсырыс|заказ|order|статус|status|қашан бола|когда будет|дайын ба|готов ли)/iu;
const BONUS_TOPIC_RE =
  /(бонус|скидк|жеңілд|акци|promo|промо|жарна|купон)/iu;
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

function enforceMaxSentences(text: string, max = 2): string {
  const urls = uniqueUrls(text);
  const trimmed = textWithoutUrls(text);
  if (!trimmed) return text;
  const sentences = trimmed.match(/[^.!?]*[.!?]+/g);
  const body = !sentences || sentences.length <= max ? trimmed : sentences.slice(0, max).join(" ").trim();
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

function deliveryAreaText(ctx: FastFoodContext, areas: string[]) {
  if (ctx.language === "ru") {
    return areas.length
      ? `Да, доставка есть. Зоны: ${areas.join(", ")}.`
      : "Да, доставка есть.";
  }
  return areas.length
    ? `Иә, жеткізу бар. Аймақтар: ${areas.join(", ")}.`
    : "Иә, жеткізу бар.";
}

function asksDelivery(text = "") {
  const ascii = String(text || "").toLowerCase();
  if (/(delivery|dostavka|kurier|courier|jetkizu|zhetkizu|alyp\s+kel|aparyp|aparyp\s+ber)/i.test(ascii)) return true;
  return /(доставка|курьер|жеткізу|жетк[іi]з|апарып|алып кел)/iu.test(String(text || ""));
}

function normalizeAreaList(value: unknown): string[] {
  if (Array.isArray(value)) return value.map((item) => String(item || "").trim()).filter(Boolean);
  if (value && typeof value === "object") return Object.values(value).map((item) => String(item || "").trim()).filter(Boolean);
  return String(value || "")
    .split(/[,;\n]+/)
    .map((item) => item.trim())
    .filter(Boolean);
}

function getConfiguredDeliveryAreas(config: Record<string, any> = {}) {
  return normalizeAreaList(
    config.delivery_areas ||
      config.delivery_area ||
      config.delivery_zones ||
      config.delivery_zone ||
      config.delivery_districts ||
      config.delivery_locations
  ).slice(0, 12);
}

function buildDeliveryAreaReply(ctx: FastFoodContext) {
  if (!asksDelivery(ctx.text)) return "";

  if (OTHER_CITY_DELIVERY_RE.test(String(ctx.text || ""))) {
    return ctx.language === "ru"
      ? "Извините, в другой город доставку не обещаем."
      : "Кешіріңіз, басқа қалаға жеткізе алмаймыз.";
  }

  const areas = getConfiguredDeliveryAreas(ctx.config);
  if (areas.length) return deliveryAreaText(ctx, areas);

  const deliveryInfo = String(ctx.config.delivery_info || ctx.config.delivery_terms || "").trim();
  if (deliveryInfo && ctx.runtimeStatus?.is_accepting_orders !== false && ctx.runtimeStatus?.delivery === true) {
    return deliveryInfo;
  }

  if (ctx.runtimeStatus && ctx.runtimeStatus.is_accepting_orders !== false && ctx.runtimeStatus.delivery === true) {
    return deliveryAreaText(ctx, []);
  }

  return "";
}

function isOnlyMenuQuestion(text: string): boolean {
  const t = String(text || "").toLowerCase();
  const hasMenu = MENU_TOPIC_RE.test(t);
  const hasPayment = PAYMENT_TOPIC_RE.test(t);
  const hasDelivery = DELIVERY_TOPIC_RE.test(t);
  const hasOrder = ORDER_TOPIC_RE.test(t);
  const hasBonus = BONUS_TOPIC_RE.test(t);
  return hasMenu && !hasPayment && !hasDelivery && !hasOrder && !hasBonus;
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

function removeUnrelatedSentences(text: string, keepPattern: RegExp): string {
  const sentences = text.match(/[^.!?]*[.!?]+/g) || [text];
  const kept = sentences.filter((s) => keepPattern.test(s));
  return kept.length > 0 ? kept.join(" ").trim() : text;
}

export function validateFinalText(rawText: string, ctx: FastFoodContext): {
  text: string;
  hasLink: boolean;
} {
  let text = stripBotTags(String(rawText || "").trim());

  if (!text) return { text: fallback(ctx), hasLink: false };

  // 1. Delivery area check — must run before any other processing
  const deliveryAreaReply = buildDeliveryAreaReply(ctx);
  if (deliveryAreaReply) return { text: deliveryAreaReply, hasLink: false };

  // 2. Language purity check
  if (ctx.language === "ru" && KAZAKH_SPECIFIC_RE.test(text)) {
    return { text: fallback(ctx), hasLink: false };
  }
  if (ctx.language === "kk" && RUSSIAN_SERVICE_WORD_RE.test(text)) {
    return { text: fallback(ctx), hasLink: false };
  }

  // 3. Runtime unavailable → block kitchen mentions
  if (!ctx.runtimeStatus || ctx.hardRealtimeContext?.stale) {
    if (KITCHEN_STATUS_RE.test(text)) {
      return { text: runtimeUnavailableText(ctx), hasLink: false };
    }
  }

  // 4. Wait time = 0 → strip wait sentences
  const liveWaitTime = Number(ctx.fetchedSettings?.wait_time || 0);
  if (!liveWaitTime) {
    text = text.replace(WAIT_SENTENCE_RE, "").replace(/\s{2,}/g, " ").trim();
  }

  // 5. No active order → strip order status mentions
  if (!ctx.activeOrder && ORDER_STATUS_RE.test(text)) {
    return { text: noActiveOrderText(ctx), hasLink: false };
  }

  // 6. Menu-only question → strip unrelated topics
  if (isOnlyMenuQuestion(ctx.text)) {
    if (PAYMENT_TOPIC_RE.test(text) || DELIVERY_TOPIC_RE.test(text) || BONUS_TOPIC_RE.test(text)) {
      text = removeUnrelatedSentences(text, MENU_TOPIC_RE);
      if (!text) return { text: fallback(ctx), hasLink: false };
    }
  }

  // 7. Magic link dedup — if already sent and no explicit intent, strip link
  const hasLinkInText = hasLinkInResponse(text);
  if (ctx.magicLinkAlreadySent && !ctx.explicitMenuLinkIntent && hasLinkInText) {
    text = text.replace(URL_RE, "").replace(/\s{2,}/g, " ").trim();
    if (MENU_LINK_SENT_RE.test(text)) return { text: text || fallback(ctx), hasLink: false };
    return { text: text || fallback(ctx), hasLink: false };
  }

  text = enforceExactMagicLink(text, ctx);

  // 8. Enforce max 2 sentences
  if (sentenceCount(text) > 2) {
    text = enforceMaxSentences(text, 2);
  }

  return { text: text || fallback(ctx), hasLink: hasLinkInResponse(text) };
}
