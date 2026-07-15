import crypto from "node:crypto";

const LINK_FORCE_RESEND_RE = /(қайта|кайта|жаңа|жана|жаңасын|жанасын|жоғалт|жогалт|жоғалды|жогалды|өшіп|ошип|өшті|ошті|жоқ бол|ашылмай|ашылмады|ашылмай жатыр|таппай|таппай қал|қайдан|жібер|скинь|скин|жұмыс істемей|работать|еще\s*раз|заново|новую|повтор|потерял|не\s+открывается|сбрось|сброс|перешли|переотправ)/iu;
const MENU_LINK_TOPIC_RE = /(link|menu|catalog|checkout|cart|s[iy]lteme|ssylka|menyu|mazir|m[aá]zir|сілтеме|ссылка|мәзір|меню|каталог)/iu;
const MENU_LINK_RESEND_TEXT_RE = /(send|sent|resend|again|new|lost|deleted|open|not\s+sent|didn'?t\s+send|where|give|show|jiber|jibershi|zhber|zhbershi|jibermedin|jibermeding|ber|bershi|korset|tasta|skinte|skin|esh[eё]\s*raz|zanovo|novuyu|povtor|poteryal|ne\s+otkryv|qaita|jana|zhanasin|jogalt|jogaldy|oship|oshti|zhok bol|ashylma|tappai|qaida|жібер|жібермед|жіберші|бер|беріңіз|берші|көрсет|көрсетіңіз|таста|қайта|жаңа|жоғалт|жоғалды|өшіп|өшті|жоқ бол|ашылмай|ашылмады|таппай|қайдан|дай|скин|отправ|дай(те)?|покаж|еще\s*раз|заново|новую|повтор|потерял|не\s+откр|сброс|сбрось|перешли|переотправ)/iu;
const MENU_LINK_MOJIBAKE_RE = /(меню|мәзір|сілтеме|ссылка|каталог|заказ|тапсырыс|корзин|себет)/iu;
const LINK_JUST_NOW_RE = /(жаңа|жана)\s+ғана|только\s+что|just\s+now/iu;

export function normalizeMenuDomain(domain: string): string | null {
  let input = String(domain || "").trim();
  if (!input) return null;

  const urlMatch = input.match(/https?:\/\/[^\s<>"')\]]+/i);
  if (urlMatch) input = urlMatch[0];

  input = input
    .replace(/^["'`<([{]+/g, "")
    .replace(/["'`>)}\],;.\s]+$/g, "")
    .trim();

  try {
    const parsed = new URL(/^https?:\/\//i.test(input) ? input : `https://${input}`);
    if (!["http:", "https:"].includes(parsed.protocol)) return null;

    const hostname = parsed.hostname.replace(/\.+$/g, "").toLowerCase();
    if (!hostname || hostname === "localhost" || hostname.endsWith(".localhost") || hostname.endsWith(".local")) {
      return null;
    }
    if (!hostname.includes(".") && !/^\d{1,3}(?:\.\d{1,3}){3}$/.test(hostname)) return null;

    const port = parsed.port ? `:${parsed.port}` : "";
    const path = parsed.pathname && parsed.pathname !== "/" ? parsed.pathname.replace(/\/+$/, "") : "";
    return `${parsed.protocol}//${hostname}${port}${path}`;
  } catch {
    return null;
  }
}

export function generateSecureMenuUrl(domain: string, phone: string): string | null {
  const secret = process.env.NOCODB_TOKEN || "secret";
  const cleanDomain = normalizeMenuDomain(domain);
  const cleanPhone = String(phone || "").replace(/\D/g, "");
  if (!cleanDomain || !cleanPhone) return null;
  const timestamp = Date.now();
  const hash = crypto.createHmac("sha256", secret).update(cleanPhone).digest("hex");
  const cb = Math.floor(Math.random() * 9999999);
  return `${cleanDomain}/?phone=${encodeURIComponent(cleanPhone)}&hash=${hash}&t=${timestamp}&cb=${cb}`;
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
    /(сілтеме|ссылка|link|линк|мәзір|меню|каталог|тапсырыс\s*(бер|берейін|берем|жасай|ет|қыл)|заказ\s*(бер|берейін|берем|жасай|ет|қыл|хочу|сдел|оформ)|заказать|оформить|хочу\s+заказ|хочу\s+заказать|корзин|себет|меню жібер|мәзір жібер|меню бер|мәзір бер|қалай заказ|қалай тапсырыс)/iu.test(value) ||
    isMenuLinkResendRequest(value)
  );
}
