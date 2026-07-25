const WAIT_SENTENCE_RE = /[^.!?\n]*(?:\b(?:30|40|50|60|90|120)\s*(?:мин|минут|minute|min)\b|күту|кідіріс|күт|ожидан|задерж)[^.!?\n]*[.!?]?/giu;
const ORDER_STATUS_RE = /(тапсырысыңыз|заказыңыз|заказ|order).*(дайындалып|әзірленіп|курьер|жолда|жеткіз|аяқтал|готов|едет|достав|дайын|әзір|даяр)/iu;
const KITCHEN_STATUS_RE = /(асүй|ас үй|кухн|kitchen|повар|cook|дайындал|готов|жұмыс істеп|жабық|closed|работает)/iu;
const KAZAKH_SPECIFIC_RE = /[әғқңөұүһіӘҒҚҢӨҰҮҺІ]/u;
const RUSSIAN_SERVICE_WORD_RE = /\b(вы|ваш|ваша|можете|пожалуйста|заказ|меню|ссылка|оплата|доставка|сейчас|если|для|через|оператор|админ)\b/iu;
const FORBIDDEN_FOREIGN_SCRIPT_RE = /[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Hangul}\p{Script=Bengali}\p{Script=Devanagari}\p{Script=Thai}]/u;
const OTHER_CITY_DELIVERY_RE = /(зачаганск|зашаған|зачаган|zachagansk|zachagan|zashaған|басқа\s+қала|баска\s+кала|другой\s+город|в\s+другой\s+город)/iu;
const MENU_TOPIC_RE = /(мәзір|меню|menu|бар ма|барма|каталог|catalog|пицц|бургер|донер|шаурм|салат|суп|напит|десерт|комбо|сеты|ассортимент|не бар|что есть|прайс|баға|цена|сколько стоит|қанша тұра|қанша тура|прейскурант)/iu;
const PAYMENT_TOPIC_RE = /(төлем|оплат|kaspi|halyk|карт|реквизит|перевод|аудар|чек|receipt|қолма-қол|налич)/iu;
const DELIVERY_TOPIC_RE = /(жеткіз|достав|курьер|courier|jetkiz|aparyp|алып кел)/iu;
const ORDER_TOPIC_RE = /(тапсырыс|заказ|order|статус|status|қашан бола|когда будет|дайын ба|готов ли)/iu;
const BONUS_TOPIC_RE = /(бонус|скидк|жеңілд|акци|promo|промо|жарна|купон)/iu;
const MENU_LINK_SENT_RE = /(алдыңғы сілтеме|предыдущ ссылк|ескі сілтеме|стара ссылка)/iu;
const URL_RE = /https?:\/\/[^\s<>"')\]]+/gi;
function trimUrlPunctuation(url) {
  return String(url || "").trim().replace(/[.,!?;:]+$/g, "");
}
function uniqueUrls(text) {
  return Array.from(new Set((String(text || "").match(URL_RE) || []).map(trimUrlPunctuation).filter(Boolean)));
}
function textWithoutUrls(text) {
  return String(text || "").replace(URL_RE, " ").replace(/\s{2,}/g, " ").trim();
}
function sentenceCount(text) {
  const trimmed = textWithoutUrls(text);
  if (!trimmed) return 0;
  const sentences = trimmed.match(/[^.!?]*[.!?]+/g);
  return sentences ? sentences.length : 1;
}
function enforceMaxSentences(text, max = 3) {
  const urls = uniqueUrls(text);
  const trimmed = textWithoutUrls(text);
  if (!trimmed) return text;
  const sentences = trimmed.match(/[^.!?]*[.!?]+/g);
  const body = !sentences || sentences.length <= max ? trimmed : sentences.slice(0, max).map((sentence) => sentence.trim()).join(" ");
  return [body, ...urls].filter(Boolean).join("\n");
}
function stripBotTags(text) {
  return String(text || "").replace(
    /\[([^\]]*)\]\((https?:\/\/[^)\s]+)\)/gi,
    (_match, label, url) => [String(label || "").trim(), String(url || "").trim()].filter(Boolean).join("\n")
  ).replace(/\[(?:Системный Анализ|System Analysis):[\s\S]*?\]/gi, "").replace(/\[ESCALATE_ADMIN\]/gi, "").replace(/\[ESCALATE_DEVELOPER\]/gi, "").replace(/\[IGNORE_MESSAGE\]/gi, "").replace(/\*\*/g, "").replace(/\*/g, "").trim();
}
function fallback(ctx) {
  return ctx.language === "kk" ? "\u049A\u0430\u043B\u0430\u0439 \u043A\u04E9\u043C\u0435\u043A\u0442\u0435\u0441\u0435 \u0430\u043B\u0430\u043C\u044B\u043D? \u{1F60A}" : "\u041A\u0430\u043A \u043C\u043E\u0433\u0443 \u043F\u043E\u043C\u043E\u0447\u044C? \u{1F60A}";
}
function noActiveOrderText(ctx) {
  return ctx.language === "kk" ? "\u049A\u0430\u0437\u0456\u0440 \u0431\u0435\u043B\u0441\u0435\u043D\u0434\u0456 \u0442\u0430\u043F\u0441\u044B\u0440\u044B\u0441\u044B\u04A3\u044B\u0437 \u0436\u043E\u049B." : "\u0421\u0435\u0439\u0447\u0430\u0441 \u043D\u0435\u0442 \u0430\u043A\u0442\u0438\u0432\u043D\u043E\u0433\u043E \u0437\u0430\u043A\u0430\u0437\u0430.";
}
function runtimeUnavailableText(ctx) {
  return ctx.language === "kk" ? "\u049A\u0430\u0437\u0456\u0440 \u0430\u0441\u04AF\u0439 \u0441\u0442\u0430\u0442\u0443\u0441\u044B\u043D \u0442\u0435\u043A\u0441\u0435\u0440\u0435 \u0430\u043B\u043C\u0430\u0439\u043C\u044B\u043D. \u041A\u0435\u0439\u0456\u043D \u049B\u0430\u0439\u0442\u0430\u043B\u0430\u043F \u0436\u0430\u0437\u044B\u04A3\u044B\u0437." : "\u041D\u0435 \u043C\u043E\u0433\u0443 \u043F\u0440\u043E\u0432\u0435\u0440\u0438\u0442\u044C \u0441\u0442\u0430\u0442\u0443\u0441 \u043A\u0443\u0445\u043D\u0438. \u041D\u0430\u043F\u0438\u0448\u0438\u0442\u0435 \u043F\u043E\u0437\u0436\u0435.";
}
function deliveryAreaText(ctx, areas) {
  if (ctx.language === "ru") {
    return areas.length ? `\u0414\u0430, \u0434\u043E\u0441\u0442\u0430\u0432\u043A\u0430 \u0435\u0441\u0442\u044C. \u0417\u043E\u043D\u044B: ${areas.join(", ")}.` : "\u0414\u0430, \u0434\u043E\u0441\u0442\u0430\u0432\u043A\u0430 \u0435\u0441\u0442\u044C.";
  }
  return areas.length ? `\u0418\u04D9, \u0436\u0435\u0442\u043A\u0456\u0437\u0443 \u0431\u0430\u0440. \u0410\u0439\u043C\u0430\u049B\u0442\u0430\u0440: ${areas.join(", ")}.` : "\u0418\u04D9, \u0436\u0435\u0442\u043A\u0456\u0437\u0443 \u0431\u0430\u0440.";
}
function asksDelivery(text = "") {
  const ascii = String(text || "").toLowerCase();
  if (/(delivery|dostavka|kurier|courier|jetkizu|zhetkizu|alyp\s+kel|aparyp|aparyp\s+ber)/i.test(ascii)) return true;
  return /(доставка|курьер|жеткізу|жетк[іi]з|апарып|алып кел)/iu.test(String(text || ""));
}
function normalizeAreaList(value) {
  if (Array.isArray(value)) return value.map((item) => String(item || "").trim()).filter(Boolean);
  if (value && typeof value === "object") return Object.values(value).map((item) => String(item || "").trim()).filter(Boolean);
  return String(value || "").split(/[,;\n]+/).map((item) => item.trim()).filter(Boolean);
}
function getConfiguredDeliveryAreas(config = {}) {
  return normalizeAreaList(
    config.delivery_areas || config.delivery_area || config.delivery_zones || config.delivery_zone || config.delivery_districts || config.delivery_locations
  ).slice(0, 12);
}
function buildDeliveryAreaReply(ctx) {
  if (!asksDelivery(ctx.text)) return "";
  if (OTHER_CITY_DELIVERY_RE.test(String(ctx.text || ""))) {
    return ctx.language === "ru" ? "\u0418\u0437\u0432\u0438\u043D\u0438\u0442\u0435, \u0432 \u0434\u0440\u0443\u0433\u043E\u0439 \u0433\u043E\u0440\u043E\u0434 \u0434\u043E\u0441\u0442\u0430\u0432\u043A\u0443 \u043D\u0435 \u043E\u0431\u0435\u0449\u0430\u0435\u043C." : "\u041A\u0435\u0448\u0456\u0440\u0456\u04A3\u0456\u0437, \u0431\u0430\u0441\u049B\u0430 \u049B\u0430\u043B\u0430\u0493\u0430 \u0436\u0435\u0442\u043A\u0456\u0437\u0435 \u0430\u043B\u043C\u0430\u0439\u043C\u044B\u0437.";
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
function isOnlyMenuQuestion(text) {
  const t = String(text || "").toLowerCase();
  const hasMenu = MENU_TOPIC_RE.test(t);
  const hasPayment = PAYMENT_TOPIC_RE.test(t);
  const hasDelivery = DELIVERY_TOPIC_RE.test(t);
  const hasOrder = ORDER_TOPIC_RE.test(t);
  const hasBonus = BONUS_TOPIC_RE.test(t);
  return hasMenu && !hasPayment && !hasDelivery && !hasOrder && !hasBonus;
}
function hasLinkInResponse(text) {
  return uniqueUrls(text).length > 0;
}
function isLikelyMagicLinkUrl(url, magicLink) {
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
function enforceExactMagicLink(text, ctx) {
  if (!ctx.magicLink || !hasLinkInResponse(text)) return text;
  return String(text || "").replace(URL_RE, (url) => {
    const cleanUrl = trimUrlPunctuation(url);
    return isLikelyMagicLinkUrl(cleanUrl, ctx.magicLink || "") ? ctx.magicLink || cleanUrl : cleanUrl;
  });
}
function removeUnrelatedSentences(text, keepPattern) {
  const sentences = text.match(/[^.!?]*[.!?]+/g) || [text];
  const kept = sentences.filter((s) => keepPattern.test(s));
  return kept.length > 0 ? kept.join(" ").trim() : text;
}
function validateFinalText(rawText, ctx) {
  let text = stripBotTags(String(rawText || "").trim());
  if (!text) return { text: fallback(ctx), hasLink: false };
  const deliveryAreaReply = buildDeliveryAreaReply(ctx);
  if (deliveryAreaReply) return { text: deliveryAreaReply, hasLink: false };
  if (FORBIDDEN_FOREIGN_SCRIPT_RE.test(text)) {
    return { text: fallback(ctx), hasLink: false };
  }
  if (ctx.language === "ru" && KAZAKH_SPECIFIC_RE.test(text)) {
    return { text: fallback(ctx), hasLink: false };
  }
  if (ctx.language === "kk" && RUSSIAN_SERVICE_WORD_RE.test(text)) {
    return { text: fallback(ctx), hasLink: false };
  }
  if (!ctx.runtimeStatus || ctx.hardRealtimeContext?.stale) {
    if (KITCHEN_STATUS_RE.test(text)) {
      return { text: runtimeUnavailableText(ctx), hasLink: false };
    }
  }
  const liveWaitTime = Number(ctx.fetchedSettings?.wait_time || 0);
  if (!liveWaitTime) {
    text = text.replace(WAIT_SENTENCE_RE, "").replace(/\s{2,}/g, " ").trim();
  }
  if (!ctx.activeOrder && ORDER_STATUS_RE.test(text)) {
    return { text: noActiveOrderText(ctx), hasLink: false };
  }
  if (isOnlyMenuQuestion(ctx.text)) {
    if (PAYMENT_TOPIC_RE.test(text) || DELIVERY_TOPIC_RE.test(text) || BONUS_TOPIC_RE.test(text)) {
      text = removeUnrelatedSentences(text, MENU_TOPIC_RE);
      if (!text) return { text: fallback(ctx), hasLink: false };
    }
  }
  const hasLinkInText = hasLinkInResponse(text);
  if (ctx.magicLinkAlreadySent && !ctx.explicitMenuLinkIntent && hasLinkInText) {
    text = text.replace(URL_RE, "").replace(/\s{2,}/g, " ").trim();
    if (MENU_LINK_SENT_RE.test(text)) return { text: text || fallback(ctx), hasLink: false };
    return { text: text || fallback(ctx), hasLink: false };
  }
  text = enforceExactMagicLink(text, ctx);
  if (sentenceCount(text) > 3) {
    text = enforceMaxSentences(text, 3);
  }
  return { text: text || fallback(ctx), hasLink: hasLinkInResponse(text) };
}
export {
  validateFinalText
};
