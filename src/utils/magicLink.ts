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

export function generateSecureMenuUrl(domain: string, phone: string, tenantSecret = ""): string | null {
  const secret = String(tenantSecret || "").trim();
  const cleanDomain = normalizeMenuDomain(domain);
  const cleanPhone = String(phone || "").replace(/\D/g, "");
  if (!cleanDomain || !cleanPhone || !secret) return null;
  const timestamp = Date.now();
  const hash = crypto
    .createHash("sha256")
    .update(`${cleanPhone}${secret}${timestamp}`, "utf8")
    .digest("hex");
  const cb = Math.floor(Math.random() * 9999999);
  return `${cleanDomain}/?phone=${encodeURIComponent(cleanPhone)}&hash=${hash}&t=${timestamp}&cb=${cb}`;
}

export function isMenuLinkResendRequest(text = ""): boolean {
  const value = String(text || "");
  const hasMenuTopic = MENU_LINK_TOPIC_RE.test(value) || MENU_LINK_MOJIBAKE_RE.test(value);
  if (!hasMenuTopic) return false;
  if (LINK_JUST_NOW_RE.test(value)) return false;
  return LINK_FORCE_RESEND_RE.test(value) || MENU_LINK_RESEND_TEXT_RE.test(value);
}

// "Сілтемені ашқым жоқ, жазып жіберіңіз мәзірді" contains the word "мәзір", so
// every link regex below read it as a request for the link and the guest got the
// same URL a second time (live round, 2026-08-12). A guest who declines the link
// and asks for the items in writing is asking for searchMenu, not for a URL.
const MENU_AS_TEXT_RE =
  /(жазып\s*(?:жібер|бер|таста)|жазып\s*қой|мәзірді\s*жаз|тізім(?:ін|мен)?\s*(?:жібер|бер|жаз)|осында\s*жаз|чат(?:қа|та|е|ом)?\s*жаз|напиш\p{L}*|перечисл\p{L}*|списк\p{L}*|текст(?:ом|е)|здесь\s*(?:напиш|скинь|перечисл))/iu;
const LINK_DECLINED_RE =
  /((?:сілтеме|ссылк|линк|link)\p{L}*\s*(?:ашқым\s*жоқ|ашпай|керек\s*емес|қажет\s*емес|не\s*надо|не\s*нужн|не\s*хочу|не\s*могу|не\s*открыв)|(?:ашқым|ашпай|аша\s*алмай)\p{L}*\s*жоқ|без\s*(?:ссылк|линк)\p{L}*|(?:сілтемесіз|ссылкой\s*не))/iu;

/**
 * The guest wants the assortment written out in the chat, not another URL.
 *
 * Two independent signals, both required: they ask for it in writing, and they
 * either decline the link outright or the request itself is a "write it here".
 * Requiring the writing signal keeps a plain "мәзір жібер" on the link path.
 */
export function wantsMenuAsText(text = ""): boolean {
  const value = String(text || "").toLowerCase();
  if (!MENU_AS_TEXT_RE.test(value)) return false;
  return LINK_DECLINED_RE.test(value) || MENU_LINK_TOPIC_RE.test(value) || MENU_LINK_MOJIBAKE_RE.test(value);
}

export function hasExplicitMenuLinkIntent(text: string): boolean {
  const value = String(text || "").toLowerCase();
  if (wantsMenuAsText(value)) return false;
  return (
    /(сілтеме|ссылка|link|линк|мәзір|меню|каталог|тапсырыс\s*(бер|берейін|берем|жасай|ет|қыл)|заказ\s*(бер|берейін|берем|жасай|ет|қыл|хочу|сдел|оформ)|заказать|оформить|хочу\s+заказ|хочу\s+заказать|корзин|себет|меню жібер|мәзір жібер|меню бер|мәзір бер|қалай заказ|қалай тапсырыс|(?:тапсырысты\s+)?жалғастыра\s*(?:мын|йық|берейік|беремін|беремиз|беріңіз)|продолж(?:у|им|ить)(?:\s+(?:заказ|оформлени\p{L}*))?|давайте\s+продолжим)/iu.test(value) ||
    isMenuLinkResendRequest(value)
  );
}

const LINK_BROKEN_WORD_RE =
  /(жасамай|жұмыс\s*істемей|жумыс\s*istemey|ашылмай|ашылмады|жарамсыз|жарамай|өшіп|өшті|өшкен|кіре\s*алмай|кірмей|не\s*работа|не\s*открыва|недейств|устарел|просроч|сгорел)/iu;
const LINK_OBJECT_RE = /(сілтеме|ссылк|линк|link)/iu;
// Both generations of the personal link: the legacy hub token URL and the
// current Platform SPA phone/hash URL.
const MAGIC_URL_RE = /(\/auth\/whatsapp#token=|\?phone=\d{10,15}&hash=)/i;

/**
 * "Ол жасамай қалды" carries no link keyword, yet it is the clearest possible
 * broken-link report when our recent messages carried one. A broken report must
 * always mint a fresh link: answering "use the previous link" to a guest who
 * just said it died is the one reply that can never be right (live round,
 * 2026-08-14: the guest heard exactly that, then gave up).
 *
 * Two shapes count: the message itself pairs a link word with a broken word
 * ("сілтеме ашылмайды"), or a SHORT message carries only the broken word while
 * a link sits in the last few history entries ("ол жасамай қалды").
 */
export function hasBrokenLinkReport(text = "", recentHistory: string[] = []): boolean {
  const value = String(text || "");
  if (!LINK_BROKEN_WORD_RE.test(value)) return false;
  if (LINK_OBJECT_RE.test(value)) return true;
  if (value.length > 120) return false;
  return recentHistory.some((entry) => LINK_OBJECT_RE.test(entry) || MAGIC_URL_RE.test(entry));
}
