import type { FastFoodContext } from "../context/types.js";

const WAIT_SENTENCE_RE =
  /[^.!?\n]*(?:\b(?:30|40|50|60|90|120)\s*(?:мин|минут|minute|min|РјРёРЅ|РјРёРЅСѓС‚)\b|күту|кідіріс|күт|ожидан|задерж|РєТЇС‚Сѓ|РєС–РґС–СЂС–СЃ|РєТЇС‚|РѕР¶РёРґР°РЅ|Р·Р°РґРµСЂР¶)[^.!?\n]*[.!?]?/giu;
const ORDER_STATUS_RE =
  /(тапсырысыңыз|заказыңыз|заказ|order|С‚Р°РїСЃС‹СЂС‹СЃС‹ТЈС‹Р·|Р·Р°РєР°Р·С‹ТЈС‹Р·).*(дайындалып|әзірленіп|курьер|жолда|жеткіз|аяқтал|готов|едет|достав|РґР°Р№С‹РЅРґР°Р»С‹Рї|У™Р·С–СЂР»РµРЅС–Рї|РєСѓСЂСЊРµСЂ|Р¶РѕР»РґР°|Р¶РµС‚РєС–Р·|Р°СЏТ›С‚Р°Р»|РіРѕС‚РѕРІ|РµРґРµС‚|РґРѕСЃС‚Р°РІ)/iu;
const KAZAKH_SPECIFIC_RE = /[әғқңөұүһіӘҒҚҢӨҰҮҺІУ™Т“Т›ТЈУ©Т±ТЇС–УТ’ТљТўУЁТ°Т®Р†]/u;
const RUSSIAN_SERVICE_WORD_RE =
  /\b(вы|ваш|ваша|можете|пожалуйста|заказ|меню|ссылка|оплата|доставка|сейчас|если|для|через|оператор|админ|РІС‹|РІР°С€|РІР°С€Р°|РјРѕР¶РµС‚Рµ|РїРѕР¶Р°Р»СѓР№СЃС‚Р°|Р·Р°РєР°Р·|РјРµРЅСЋ|СЃСЃС‹Р»РєР°|РѕРїР»Р°С‚Р°|РґРѕСЃС‚Р°РІРєР°|СЃРµР№С‡Р°СЃ|РµСЃР»Рё|РґР»СЏ|С‡РµСЂРµР·|РѕРїРµСЂР°С‚РѕСЂ|Р°РґРјРёРЅ)\b/iu;
const OTHER_CITY_DELIVERY_RE =
  /(зачаганск|зашаған|зачаган|зачаганскқа|зачаганскка|зачаған|zachagansk|zachagan|zashaған|басқа\s+қала|баска\s+кала|другой\s+город|другую\s+город|в\s+другой\s+город|Р·Р°С‡Р°РіР°РЅСЃРє|Р·Р°С€Р°Т“Р°РЅ|Р·Р°С‡Р°РіР°РЅ|Р±Р°СЃТ›Р°\s+Т›Р°Р»Р°|Р±Р°СЃРєР°\s+РєР°Р»Р°|РґСЂСѓРіРѕР№\s+РіРѕСЂРѕРґ)/iu;

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

function stripBotTags(text: string) {
  return String(text || "")
    .replace(/\[(?:Системный Анализ|РЎРёСЃС‚РµРјРЅС‹Р№ РђРЅР°Р»РёР·|System Analysis):[\s\S]*?\]/gi, "")
    .replace(/\[ESCALATE_ADMIN\]/gi, "")
    .replace(/\[ESCALATE_DEVELOPER\]/gi, "")
    .replace(/\[IGNORE_MESSAGE\]/gi, "")
    .replace(/\*\*/g, "")
    .replace(/\*/g, "")
    .trim();
}

function asksDelivery(text = "") {
  const ascii = String(text || "").toLowerCase();
  if (/(delivery|dostavka|kurier|courier|jetkizu|zhetkizu|alyp\s+kel|aparyp|aparyp\s+ber)/i.test(ascii)) return true;
  return /(доставка|курьер|жеткізу|жетк[іi]з|апарып|алып кел|РґРѕСЃС‚Р°РІРєР°|РєСѓСЂСЊРµСЂ|Р¶РµС‚РєС–Р·Сѓ|Р¶РµС‚Рє[С–i]Р·|Р°РїР°СЂС‹Рї|Р°Р»С‹Рї РєРµР»)/iu.test(
    String(text || "")
  );
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
      ? "Извините, в другой город доставку не обещаем. Доставка работает только по зоне ресторана; точный адрес проверяется при оформлении заказа."
      : "Кешіріңіз, басқа қалаға жеткіземіз деп айта алмаймыз. Жеткізу тек ресторанның қызмет аймағында, нақты мекенжай тапсырыс рәсімдегенде тексеріледі.";
  }

  const areas = getConfiguredDeliveryAreas(ctx.config);
  const deliveryInfo = String(ctx.config.delivery_info || ctx.config.delivery_terms || "").trim();
  if (areas.length) {
    return ctx.language === "ru"
      ? `Да, доставка есть. Зоны доставки: ${areas.join(", ")}. Точный адрес система проверит при оформлении заказа.`
      : `Иә, жеткізу бар. Жеткізу аймақтары: ${areas.join(", ")}. Нақты мекенжай тапсырыс рәсімдеген кезде тексеріледі.`;
  }

  if (deliveryInfo && ctx.runtimeStatus?.is_accepting_orders !== false && ctx.runtimeStatus?.delivery === true) {
    return deliveryInfo;
  }

  if (ctx.runtimeStatus && ctx.runtimeStatus.is_accepting_orders !== false && ctx.runtimeStatus.delivery === true) {
    return ctx.language === "ru"
      ? "Да, доставка есть. Точный адрес и зону доставки система проверит при оформлении заказа."
      : "Иә, жеткізу бар. Нақты мекенжай мен жеткізу аймағы тапсырыс рәсімдеген кезде тексеріледі.";
  }

  return "";
}

export function validateFinalText(rawText: string, ctx: FastFoodContext): string {
  let text = stripBotTags(String(rawText || "").trim());

  if (!text) return fallback(ctx);

  const deliveryAreaReply = buildDeliveryAreaReply(ctx);
  if (deliveryAreaReply) return deliveryAreaReply;

  if (ctx.language === "ru" && KAZAKH_SPECIFIC_RE.test(text)) {
    return fallback(ctx);
  }
  if (ctx.language === "kk" && RUSSIAN_SERVICE_WORD_RE.test(text)) {
    return fallback(ctx);
  }

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
