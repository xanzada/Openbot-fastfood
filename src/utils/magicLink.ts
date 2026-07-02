import crypto from "node:crypto";

const LINK_FORCE_RESEND_RE = /(қайта|кайта|жаңа|жана|жаңасын|жанасын|жоғалт|жогалт|өшіп|ошип|ашылмай|ашылмады|таппай|қайдан|қайда|скинь|скин|еще\s*раз|заново|новую|повтор|потерял|не\s+открывается)/i;
const MENU_LINK_TOPIC_RE = /(link|menu|catalog|checkout|cart|s[iy]lteme|ssylka|menyu|mazir|m[aá]zir|сілтеме|ссылка|мәзір|меню|каталог)/iu;
const MENU_LINK_RESEND_TEXT_RE = /(send|sent|resend|again|new|lost|deleted|open|not\s+sent|didn'?t\s+send|where|give|show|jiber|jibershi|zhber|zhbershi|jibermedin|jibermeding|ber|bershi|korset|tasta|skinte|skin|esh[eё]\s*raz|zanovo|novuyu|povtor|poteryal|ne\s+otkryv|qaita|jana|zhanasin|jogalt|oship|ashylma|tappai|qaida|жібер|жібермед|бер|беріңіз|берші|көрсет|көрсетіңіз|таста|қайта|жаңа|жоғалт|өшіп|ашылма|қайда|дай|скин|отправ|дай(те)?|покаж|еще\s*раз|заново|новую|повтор|потерял|не\s+откр)/iu;
const MENU_LINK_MOJIBAKE_RE = /(РјРµРЅСЋ|РјУ™Р·|СЃС–Р»С‚РµРјРµ|СЃСЃС‹Р»Рє|РєР°С‚Р°Р»РѕРі|Р·Р°РєР°Р·|С‚Р°РїСЃС‹СЂС‹СЃ|РєРѕСЂР·РёРЅ|СЃРµР±РµС‚)/i;
const LINK_JUST_NOW_RE = /(жаңа|жана)\s+ғана|только\s+что|just\s+now/iu;

export function buildMagicLink(domain: string, phone: string): string | null {
  const secret = process.env.CRM_SECRET_TOKEN;
  if (!domain || !phone || !secret) return null;
  const cleanDomain = String(domain).replace(/\/+$/, "");
  const timestamp = Date.now();
  const hash = crypto.createHash("sha256").update(`${phone}${secret}${timestamp}`).digest("hex");
  const cb = Math.floor(Math.random() * 9999999);
  return `${cleanDomain}/?phone=${phone}&hash=${hash}&t=${timestamp}&cb=${cb}`;
}

export function isMenuLinkResendRequest(text = ""): boolean {
  const value = String(text || "");
  if (LINK_JUST_NOW_RE.test(value) && !MENU_LINK_TOPIC_RE.test(value) && !MENU_LINK_MOJIBAKE_RE.test(value)) {
    return false;
  }
  return LINK_FORCE_RESEND_RE.test(value) || MENU_LINK_RESEND_TEXT_RE.test(value);
}

export function hasExplicitMenuLinkIntent(text: string): boolean {
  const value = String(text || "").toLowerCase();
  return (
    /(сілтеме|ссылка|link|линк|мәзір|меню|каталог|тапсырыс\s*бер|заказ\s*бер|заказать|оформить|корзин|себет|меню жібер|мәзір жібер|меню бер|мәзір бер|қалай заказ|қалай тапсырыс|СЃС–Р»С‚РµРјРµ|СЃСЃС‹Р»РєР°|Р»РёРЅРє|РјРµРЅСЋ Р¶С–Р±РµСЂ|РјУ™Р·С–СЂ Р¶С–Р±РµСЂ|РјРµРЅСЋ Р±РµСЂ|РјУ™Р·С–СЂ Р±РµСЂ|Т›Р°Р»Р°Р№ Р·Р°РєР°Р·|Т›Р°Р»Р°Р№ С‚Р°РїСЃС‹СЂС‹СЃ|Р·Р°РєР°Р· Р±РµСЂ|С‚Р°РїСЃС‹СЂС‹СЃ Р±РµСЂ)/iu.test(value) ||
    isMenuLinkResendRequest(value)
  );
}
