import type { FastFoodContext } from "../context/types.js";

const WAIT_SENTENCE_RE =
  /[^.!?\n]*(?:\b(?:30|40|50|60|90|120)\s*(?:мин|минут|minute|min)\b|күту|кідіріс|күт|ожидан|задерж)[^.!?\n]*[.!?]?/giu;
const ORDER_STATUS_RE =
  /(тапсырысыңыз|заказыңыз|заказ|order).*(дайындалып|әзірленіп|курьер|жолда|жеткіз|аяқтал|готов|едет|достав)/iu;

function fallback(ctx: FastFoodContext) {
  return ctx.language === "kk"
    ? "Қалай көмектесе аламын? Мәзір, тапсырыс немесе төлем бойынша сұрай беріңіз."
    : "Как могу помочь? Можете спросить про меню, заказ или оплату.";
}

function noActiveOrderText(ctx: FastFoodContext) {
  return ctx.language === "kk"
    ? "Қазір сіздің белсенді тапсырысыңыз көрінбей тұр. Тапсырыс беру үшін мәзір сілтемесін қолдана аласыз."
    : "Сейчас активный заказ не отображается. Для оформления можно воспользоваться ссылкой меню.";
}

export function validateFinalText(rawText: string, ctx: FastFoodContext): string {
  let text = String(rawText || "").trim();

  if (!text) return fallback(ctx);

  const liveWaitTime = Number(ctx.fetchedSettings?.wait_time || 0);
  if (!liveWaitTime) {
    text = text.replace(WAIT_SENTENCE_RE, "").replace(/\s{2,}/g, " ").trim();
  }

  if (!ctx.activeOrder && ORDER_STATUS_RE.test(text)) {
    return noActiveOrderText(ctx);
  }

  if (ctx.magicLinkAlreadySent && !ctx.explicitMenuLinkIntent && ctx.magicLink) {
    text = text.replace(ctx.magicLink, "").trim();
  }

  return text || fallback(ctx);
}
