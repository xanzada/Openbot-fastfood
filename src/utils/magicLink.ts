import crypto from "node:crypto";
import { intentMatches } from "./intentText.js";

const LINK_FORCE_RESEND_RE = /(кері\s*жібер|кери\s*жибер|keri\s*zhiber|keri\s*jiber|тағы\s*жібер|тагы\s*жибер|не\s*вижу|не\s*могу\s*найти|көрінбей|коринбей|продублир|дублир|қайта|кайта|жаңа|жана|жаңасын|жанасын|жоғалт|жогалт|жоғалды|жогалды|өшіп|ошип|өшті|ошті|жоқ бол|ашылмай|ашылмады|ашылмай жатыр|таппай|таппай қал|қайдан|жібер|скинь|скин|жұмыс істемей|работать|еще\s*раз|заново|новую|повтор|потерял|не\s+открывается|сбрось|сброс|перешли|переотправ)/iu;
// The Russian words are matched by STEM: a guest types the accusative
// ("ссылку скинь", "дайте ссылку"), and spelling only the nominative made every
// one of those messages invisible to the link path. Kazakh already worked because
// its suffixes follow the stem ("сілтемені" starts with "сілтеме"), but Russian
// changes the final vowel (found 2026-08-22).
// "мен[юяью]" also matched "меня", one of the most common Russian words, so "у меня
// аллергия на орехи" and "у меня не открывается" were read as a request for the menu
// link: the guest got a checkout link instead of an answer, sendMenuLink was pinned as
// the forced first tool, and a CRM lead was written (found 2026-08-22). "меню" is
// indeclinable - the extra letters bought nothing.
const MENU_LINK_TOPIC_RE = /(link|menu|catalog|checkout|cart|s[iy]lteme|ssylka|menyu|mazir|m[aá]zir|сілтеме|ссылк\p{L}*|мәзір|мен[юь]|каталог)/iu;
const MENU_LINK_RESEND_TEXT_RE = /(keri\s*zhiber|keri\s*jiber|send|sent|resend|again|new|lost|deleted|open|not\s+sent|didn'?t\s+send|where|give|show|jiber|jibershi|zhber|zhbershi|jibermedin|jibermeding|ber|bershi|korset|tasta|skinte|skin|esh[eё]\s*raz|zanovo|novuyu|povtor|poteryal|ne\s+otkryv|qaita|jana|zhanasin|jogalt|jogaldy|oship|oshti|zhok bol|ashylma|tappai|qaida|жібер|жібермед|жіберші|бер|беріңіз|берші|көрсет|көрсетіңіз|таста|қайта|жаңа|жоғалт|жоғалды|өшіп|өшті|жоқ бол|ашылмай|ашылмады|таппай|қайдан|дай|скин|отправ|дай(те)?|покаж|еще\s*раз|заново|новую|повтор|потерял|не\s+откр|сброс|сбрось|перешли|переотправ)/iu;
const MENU_LINK_MOJIBAKE_RE = /(мен[юь]|мәзір|сілтеме|ссылк\p{L}*|каталог|заказ|тапсырыс|корзин|себет)/iu;
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

// WHY every test here goes through intentMatches: WhatsApp Kazakh is routinely
// typed on a Russian keyboard, so "мәзір" arrives as "мазир" and "сілтеме" as
// "силтеме". These matchers compared raw text only, so that spelling matched
// nothing and preloadContext never minted the link - while toolPolicy DID fold,
// pinned sendMenuLink, and the skill then found ctx.magicLink === null and returned
// link_not_needed with a null message. The guest asked for the ordering link and
// received an answer with no link and no reason (found 2026-08-22). intentMatches
// tests the raw text first and only then the folded form, so nothing that used to
// match stops matching.
export function isMenuLinkResendRequest(text = ""): boolean {
  const value = String(text || "");
  const hasMenuTopic = intentMatches(MENU_LINK_TOPIC_RE, value) || intentMatches(MENU_LINK_MOJIBAKE_RE, value);
  if (!hasMenuTopic) return false;
  if (intentMatches(LINK_JUST_NOW_RE, value)) return false;
  return intentMatches(LINK_FORCE_RESEND_RE, value) || intentMatches(MENU_LINK_RESEND_TEXT_RE, value);
}

// «Кері жібересіз бе», «Кері жіберші», «қайта жібер», «скинь ещё раз», «не вижу ссылку»:
// right after we sent the ordering link, a SHORT re-send request with no other object
// is a request for that link, even without the word «сілтеме». Live round 2026-10-04:
// the guest asked twice and was told twice to scroll up the chat. The other-object
// guard keeps «ақшаны кері жіберіңіз» (refund), «чекті қайта жібер» (receipt) and
// «тағы бір донер жібер» (an order) off the link path, and no link in context means
// no resend - so ordinary questions never get a link.
const CONTEXT_RESEND_RE =
  /((?:кері|кери|қайта|кайта|тағы|тагы|тағыда|тагыда|keri|qaita|kaita|tagy)\s*(?:бір\s*|бир\s*)?(?:жібер|жибер|таста|сал(?:ып|ш|ыңыз)|zhiber|jiber|tasta)|(?:скин|кин|отправ|сброс|пришл|перешл|кидан)\p{L}*\s*(?:ещ[её]|снова|повторно|заново)|(?:ещ[её]|снова|повторно|заново)\s*(?:раз\s*)?(?:скин|кин|отправ|пришл|сброс)|продублир\p{L}*|дублир\p{L}*|повтор\p{L}*\s*(?:ссылк|линк|сілтеме)|не\s*(?:вижу|нашел|нашла|нахожу|могу\s*найти)|көрінбей|коринбей|көрмедім|кормедим|таба\s*алмай|таппадым|resend|send\s*(?:it\s*)?again)/iu;
const RESEND_OTHER_OBJECT_RE =
  /(ақша|акша|деньг|сумм|оплат|төлем|толем|каспи|kaspi|чек|квитанц|фото|сурет|скрин|видео|номер|адрес|мекенжай|реквизит|счет|счёт|шот|возврат|қайтар|кайтар|донер|бургер|пицц|лаваш|шаурм|сусын|напит|кол[аы])/iu;
const LINK_IN_HISTORY_RE = /(сілтеме|силтеме|ссылк|линк|link|\/auth\/whatsapp#token=|\?phone=\d{10,15}&hash=)/iu;

export function isContextualLinkResendRequest(
  text = "",
  context: { alreadySent?: boolean; recentHistory?: string[] } = {},
): boolean {
  const value = String(text || "").trim();
  if (!value || value.length > 80) return false;
  const linkInContext = Boolean(context.alreadySent)
    || (context.recentHistory || []).some((entry) => LINK_IN_HISTORY_RE.test(String(entry || "")));
  if (!linkInContext) return false;
  if (intentMatches(RESEND_OTHER_OBJECT_RE, value)) return false;
  return intentMatches(CONTEXT_RESEND_RE, value);
}

// "Сілтемені ашқым жоқ, жазып жіберіңіз мәзірді" contains the word "мәзір", so
// every link regex below read it as a request for the link and the guest got the
// same URL a second time (live round, 2026-08-12). A guest who declines the link
// and asks for the items in writing is asking for searchMenu, not for a URL.
const MENU_AS_TEXT_RE =
  /(жазып\s*(?:жібер|бер|таста)|жазып\s*қой|мәзірді\s*жаз|тізім(?:ін|мен)?\s*(?:жібер|бер|жаз)|осында\s*жаз|чат(?:қа|та|е|ом)?\s*жаз|напиш\p{L}*|перечисл\p{L}*|списк\p{L}*|текст(?:ом|е)|мәтін(?:мен|\s*түрінде)|матин(?:мен|\s*туринде)|здесь\s*(?:напиш|скинь|перечисл))/iu;
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
  if (!intentMatches(MENU_AS_TEXT_RE, value)) return false;
  return intentMatches(LINK_DECLINED_RE, value)
    || intentMatches(MENU_LINK_TOPIC_RE, value)
    || intentMatches(MENU_LINK_MOJIBAKE_RE, value);
}

const EXPLICIT_MENU_LINK_RE =
  /(сілтеме|ссылк\p{L}*|link|линк|мәзір|мен[юь]|каталог|тапсырыс\s*(бер|берейін|берем|жасай|ет|қыл|қабылда)|заказ\s*(бер|берейін|берем|жасай|ет|қыл|қабылда|хочу|сдел|оформ)|заказать|оформить|хочу\s+заказ|хочу\s+заказать|корзин|себет|меню жібер|мәзір жібер|меню бер|мәзір бер|қалай заказ|қалай тапсырыс|(?:тапсырысты\s+)?жалғастыра\s*(?:мын|йық|берейік|беремін|беремиз|беріңіз)|продолж(?:у|им|ить)(?:\s+(?:заказ|оформлени\p{L}*))?|давайте\s+продолжим|қайдан\s*(?:қарай|көр|таб)|где\s*(?:посмотреть|глянуть|увидеть))/iu;

// Finite observed request spellings, normalized as whole words. Permission and
// refusals still belong to the current clause; this is not fuzzy intent matching.
export function normalizeCheckoutRequestSpelling(text: string): string {
  return String(text || "").split(/(«[^»]*»|“[^”]*”|"[^"]*"|‘[^’]*’|'[^']*')/gu)
    .map((part, index) => index % 2 ? part : part
      .replace(/(?<!\p{L})сылтемени(?!\p{L})/giu, "сілтемені")
      .replace(/(?<!\p{L})сылку(?!\p{L})/giu, "ссылку")
      .replace(/(?<!\p{L})жиберш(?!\p{L})/giu, "жібер"))
    .join("");
}

export type MenuLinkTurnDecision = "allow" | "deny" | "text_only" | "unspecified";

/**
 * One current-turn decision shared by planning and execution. A correction later
 * in the same message supersedes an earlier instruction; quoted reports do not.
 */
export function menuLinkDecisionForTurn(text = ""): MenuLinkTurnDecision {
  const raw = String(text || "");
  const oversized = raw.length > 4096;
  // Intent is bounded before quote/spelling normalization. For oversized input,
  // keep both chronological edges so a last correction remains authoritative.
  const bounded = oversized ? raw.slice(0, 2048) + "\n" + raw.slice(-2048) : raw;
  const value = normalizeCheckoutRequestSpelling(bounded)
    .replace(/«[^»]*»|“[^”]*”|"[^"]*"|‘[^’]*’|'[^']*'/gu, "").toLowerCase();
  const textOnly = wantsMenuAsText(value);
  const topic = /(?:сілтеме\p{L}*|ссылк\p{L}*|линк|link|url|меню|мәзір\p{L}*|мазір\p{L}*|каталог\p{L}*|корзин\p{L}*|себет\p{L}*)/iu;
  if (!topic.test(value)) return oversized ? "deny" : "unspecified";
  let decision: MenuLinkTurnDecision = textOnly ? "text_only" : "unspecified";
  for (const clause of value.split(/(?<=[.!?;,\n])|[—–]|(?<!\p{L})(?:но|бірақ|хотя)(?!\p{L})/iu)) {
    const explicitUrlAction = /(?:(?:пришл(?:и|ите)|отправ(?:ь|ьте)|скинь(?:те)?|жібер(?:іңіз|іңдер|ші)?|жибер(?:иниз|іңіз|ші)?)[^.!?]{0,30}(?:сілтеме\p{L}*|ссылк\p{L}*|линк|link|url)|(?:сілтеме\p{L}*|ссылк\p{L}*|линк|link|url)[^.!?]{0,30}(?:пришл(?:и|ите)|отправ(?:ь|ьте)|скинь(?:те)?|жібер(?:іңіз|іңдер|ші)?|жибер(?:иниз|іңіз|ші)?))/iu.test(clause);
    if (wantsMenuAsText(clause) && !explicitUrlAction) { decision = "text_only"; continue; }
    const denied = /(?:(?<!\p{L})не(?!\p{L})\s+(?:присыл\p{L}*|пришл\p{L}*|отправ\p{L}*|скидыва\p{L}*|скинь\p{L}*|показыва\p{L}*|покаж\p{L}*|давай\p{L}*|дай)|(?:(?<!\p{L})не(?!\p{L})\s+(?:нуж\p{L}*|надо)|керек\s*емес|қажет\s*емес|керегі\s*жоқ)[^.!?]{0,30}(?:сілтеме\p{L}*|ссылк\p{L}*|линк|link|url|меню|мәзір\p{L}*|каталог\p{L}*)|(?:сілтеме\p{L}*|ссылк\p{L}*|линк|link|url|меню|мәзір\p{L}*|каталог\p{L}*)[^.!?]{0,30}(?:(?<!\p{L})не(?!\p{L})\s+(?:нуж\p{L}*|надо)|керек\s*емес|қажет\s*емес|керегі\s*жоқ)|(?<!\p{L})(?:жіберме\p{L}*|жиберме\p{L}*|көрсетпе\p{L}*|корсетпе\p{L}*|ашпа\p{L}*))(?!\p{L})/iu.test(clause);
    if (denied) { decision = "deny"; continue; }
    if (/(?:отправил\p{L}*|прислал\p{L}*|скинул\p{L}*|показал\p{L}*|жіберді\p{L}*|көрсетті\p{L}*)/iu.test(clause)) continue;
    const action = /(?<!\p{L})(?:пришл(?:и|ите)|присылай(?:те)?|отправ(?:ь|ьте)|скинь(?:те)?|покаж(?:и|ите)|откро(?:й|йте)|дай(?:те)?|жібер(?:іңіз|іңдер|ші)?|жибер(?:иниз|іңіз|ші)?|көрсет(?:іңіз|ші)?|корсет(?:иниз|іңіз|ші)?|аш(?:ыңыз|ып\s*беріңіз|шы)?|бер(?:іңіз|ші)?)(?!\p{L})/iu;
    const localTopic = topic.test(clause);
    const bareCorrection = /^\s*(?:(?:нет|жоқ|жок|хотя|бірақ|но)[,\s-]*)*(?:(?:пришл(?:и|ите)|отправ(?:ь|ьте)|скинь(?:те)?|покаж(?:и|ите)|откро(?:й|йте))\s*(?:е[её]|его|их)?|(?:оны|оны да)?\s*(?:жібер(?:іңіз|іңдер|ші)?|жибер(?:иниз|іңіз|ші)?)|(?:жібер(?:іңіз|іңдер|ші)?|жибер(?:иниз|іңіз|ші)?|көрсет(?:іңіз|ші)?|корсет(?:иниз|іңіз|ші)?|аш(?:ыңыз|шы)?|бер(?:іңіз|ші)?))[.!?\s]*$/iu.test(clause);
    const needed = /(?:сілтеме\p{L}*|ссылк\p{L}*|линк|link|url)[^.!?]{0,24}(?:керек|қажет|нуж\p{L}*)|(?:керек|қажет|нуж\p{L}*)[^.!?]{0,24}(?:сілтеме\p{L}*|ссылк\p{L}*|линк|link|url)/iu.test(clause);
    if (localTopic && action.test(clause) || bareCorrection || needed) decision = "allow";
  }
  // An oversized implicit browse has no trustworthy complete current-turn
  // decision. Fail closed; an explicit head/tail action above remains usable.
  return oversized && decision === "unspecified" ? "deny" : decision;
}

export function hasExplicitMenuLinkIntent(text: string): boolean {
  const value = normalizeCheckoutRequestSpelling(text).toLowerCase();
  if (wantsMenuAsText(value)) return false;
  return intentMatches(EXPLICIT_MENU_LINK_RE, value) || isMenuLinkResendRequest(value);
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
  if (!intentMatches(LINK_BROKEN_WORD_RE, value)) return false;
  if (intentMatches(LINK_OBJECT_RE, value)) return true;
  if (value.length > 120) return false;
  return recentHistory.some((entry) => intentMatches(LINK_OBJECT_RE, entry) || MAGIC_URL_RE.test(entry));
}
