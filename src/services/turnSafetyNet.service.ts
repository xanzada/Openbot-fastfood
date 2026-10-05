import type { FastFoodContext } from "../context/types.js";
import { isLikelyComplaintText, isLikelyOperatorRequestText, routeComplaintToAdmin } from "./complaintRouting.service.js";
import { honorMenuLinkPromise } from "../agent/linkPromise.js";
import { foldIntentText, intentMatches } from "../utils/intentText.js";
import { findBlockedMenuItemMention } from "./operationalPreemption.service.js";
import { menuItemBlockedByNotes, menuVocabulary } from "./noteProvenance.service.js";

/**
 * Two answers that must not depend on a model (owner rules, 2026-10-04).
 *
 * 1. No model answered. The A6API proxy rejects angry guests («где мой заказ?? 55 минут»)
 *    with a security-check 400 on every lane, and a lane can time out; the webhook then
 *    threw and the guest got silence on exactly the turn that mattered most. Now the
 *    guest gets a deterministic fallback. SOS is reserved for text that independently
 *    proves a complaint, missing order, money issue, cancellation or human request;
 *    calm catalog turns are answered from the menu and ordering link instead.
 * 2. A composition / allergen question about dishes whose catalog entry has no
 *    ingredients. Any answer would be a guess about a child's allergy, so the bot only
 *    says it is checking with the kitchen - and an SOS makes that sentence true.
 */

type Route = typeof routeComplaintToAdmin;

const say = (ctx: FastFoodContext, kk: string, ru: string) => (ctx.language === "kk" ? kk : ru);

/**
 * A calm catalog turn - a price, a dish, «мәзір», «заказ берейін» - needs the menu,
 * not a person. «Пицца қаншадан?» hit a model timeout and became a red high-urgency
 * SOS in the operator panel about nothing (owner report, 2026-10-04). Such a turn is
 * answered from facts the bot already holds - catalog prices and the ordering link -
 * and the SOS stays for what really needs a human: a complaint, a request for a
 * person, an order that is late, missing or wrong, money.
 */
const CATALOG_TURN_RE =
  /(қанша|сколько|цен[аы]|поч[её]м|баға|прайс|мәзір|меню|menu|каталог|ассортимент|бар\s*ма|барма|есть\s*ли|заказ|тапсырыс|керек|хочу|алайын|аламын|берейін|жасап|оформ|комбо)/iu;
const NEEDS_PERSON_RE =
  /(қайда|где|келмеді|келмей|не\s*привез|не\s*пришл|не\s*приш[её]л|кешік|опазд|долго|ұзақ|күттім|күтіп\s*отыр|жду|жд[её]м|отмен|болдырма|возврат|верн|ақшам|деньг|суық|холодн|жалоб|шағым|оператор|менеджер|админ|адаммен|человек|қате|ошиб|неправильн)/iu;
const ORDER_WORD_RE = /(заказ|тапсырыс)/iu;
const NON_TEXT_MEDIA_RE = /(image|photo|document|video|sticker|file)/i;

export function needsHumanRecovery(ctx: FastFoodContext) {
  const text = String(ctx.text || "").trim();
  if (!text) return false;
  if (isLikelyComplaintText(text) || isLikelyOperatorRequestText(text)) return true;
  if (intentMatches(NEEDS_PERSON_RE, text)) return true;
  return Boolean(ctx.activeOrder && intentMatches(ORDER_WORD_RE, text));
}

export function isCalmCatalogTurn(ctx: FastFoodContext) {
  const text = String(ctx.text || "").trim();
  if (!text || !intentMatches(CATALOG_TURN_RE, text)) return false;
  if (intentMatches(NEEDS_PERSON_RE, text)) return false;
  if (isLikelyComplaintText(text) || isLikelyOperatorRequestText(text)) return false;
  // «Тапсырысым қанша?» with a live order is about that order, not the menu.
  if (ctx.activeOrder && intentMatches(ORDER_WORD_RE, text)) return false;
  // A photo / document (receipt, screenshot of a problem) is never catalog talk.
  const media: any = ctx.mediaContext || null;
  if (media && NON_TEXT_MEDIA_RE.test(String(media.kind || media.type || media.mimeType || ""))) return false;
  return true;
}

const STOP_WORDS = new Set([
  "қанша", "қаншадан", "қаншаға", "сколько", "стоит", "стоят", "керек", "керегі", "есть", "бауырым", "брат", "братан",
  "заказ", "заказать", "тапсырыс", "хочу", "маған", "беріңіз", "дайте", "пожалуйста", "сәлем", "салем", "здравствуйте",
  "привет", "ассалаумағалейкум", "ассалаумалейкум", "срочно", "бірден", "сразу", "можно", "болады", "бересіз", "берейін",
].map((word) => foldIntentText(word)));

/** Catalog dishes the guest named, with the menu price - facts, not a model's guess. */
export function catalogPriceLines(ctx: FastFoodContext, max = 6) {
  const items: any[] = Array.isArray(ctx.menuSnapshot?.items) ? ctx.menuSnapshot!.items : [];
  if (!items.length) return [] as string[];
  const words = foldIntentText(ctx.text).split(/[^\p{L}\p{N}]+/u).filter((word) => word.length >= 4 && !STOP_WORDS.has(word));
  if (!words.length) return [] as string[];
  const stems = [...new Set(words.map((word) => word.slice(0, Math.max(4, word.length - 3))))];
  const notes: any[] = Array.isArray(ctx.activeShiftNotes) ? ctx.activeShiftNotes : [];
  const vocabulary = notes.length ? menuVocabulary(items) : [];
  return items
    .filter((item) => item?.available !== false && Number(item?.price) > 0)
    .filter((item) => !notes.length || !menuItemBlockedByNotes(notes, item, vocabulary).blocked)
    .filter((item) => {
      const haystack = foldIntentText(`${item.name || ""} ${item.category || ""}`);
      return stems.some((stem) => haystack.includes(stem));
    })
    .slice(0, max)
    .map((item) => `▪️ ${String(item.name).trim()} — ${Math.round(Number(item.price))} ₸`);
}

type GrantLink = (ctx: FastFoodContext) => Promise<boolean>;

/** Same gates as a promised link: closed kitchen / unconfirmed wait / mint failure => false. */
export const grantMenuLinkForFallback: GrantLink = async (ctx) => {
  if (ctx.magicLinkGranted && ctx.magicLink) return true;
  const outcome = await honorMenuLinkPromise(ctx, ctx.language === "kk" ? "Мәзірді жіберемін." : "Отправлю меню.").catch(() => null);
  return outcome?.action === "granted" || Boolean(ctx.magicLinkGranted && ctx.magicLink);
};

export async function answerAgentFailure(
  ctx: FastFoodContext,
  error: unknown,
  route: Route = routeComplaintToAdmin,
  grantLink: GrantLink = grantMenuLinkForFallback,
) {
  const reason = String((error as any)?.message || error || "unknown").slice(0, 80);
  if (isCalmCatalogTurn(ctx)) {
    const items: Record<string, any>[] = Array.isArray(ctx.menuSnapshot?.items) ? ctx.menuSnapshot.items : [];
    const blockedMention = findBlockedMenuItemMention(ctx.activeShiftNotes || [], items, ctx.text);
    if (blockedMention) {
      return say(ctx,
        "Бұл тағам қазірше қолжетімсіз, басқа тағамдарды таңдап көріңіз.",
        "Это блюдо сейчас временно недоступно, выберите, пожалуйста, другое.");
    }
    const lines = catalogPriceLines(ctx);
    const linked = await grantLink(ctx).catch(() => false);
    if (lines.length || linked) {
      console.warn(`[OPENBOT:SAFETY] model unavailable on a catalog turn - answered from menu (prices=${lines.length} link=${linked}), no SOS reason=${reason}`);
      const kk = ctx.language === "kk";
      if (lines.length) {
        const head = kk ? "Кешіріңіз, жауап сәл кешікті. Бағалары:" : "Извините за задержку. Цены:";
        const tail = linked
          ? (kk ? "Толық мәзір және тапсырыс беру — төмендегі сілтемеде." : "Полное меню и оформление заказа — по ссылке ниже.")
          : (kk ? "Тапсырыс бергіңіз келсе, жазыңыз — сілтемені жіберемін." : "Если хотите заказать, напишите — пришлю ссылку.");
        return [head, ...lines, tail].join("\n");
      }
      return say(ctx,
        "Кешіріңіз, жауап сәл кешікті. Мәзір мен бағалар төмендегі сілтемеде — сол арқылы бірден тапсырыс бере аласыз.",
        "Извините за задержку. Меню с ценами — по ссылке ниже, там же можно сразу оформить заказ.");
    }
  }
  if (!needsHumanRecovery(ctx)) {
    console.warn(`[OPENBOT:SAFETY] transient model failure on a non-critical turn - no SOS reason=${reason}`);
    return say(ctx,
      "Кешіріңіз, жауап сәл кешікті. Сұрағыңызды тағы бір рет жаза аласыз ба?",
      "Извините, ответ задержался. Напишите, пожалуйста, ваш вопрос ещё раз.");
  }
  const routing = await route(ctx, {
    summary: `ИИ жауап бере алмады (${reason}). Клиент жазды: ${String(ctx.text || "").slice(0, 300)}`,
    customerText: ctx.text,
    urgency: "high",
    source: "ai_unavailable",
  }).catch(() => null);
  return routing?.action === "operator_case_created"
    ? say(ctx, "Кешіріңіз, қазір ақпаратты нақтылап жатырмыз. Оператор осы чатта жақын арада жауап береді.",
      "Извините, уточняем информацию. Оператор ответит вам в этом чате в ближайшее время.")
    : say(ctx, "Кешіріңіз, қазір ақпаратты нақтылап жатырмыз. Бір-екі минуттан кейін қайта жазыңызшы.",
      "Извините, уточняем информацию. Напишите, пожалуйста, ещё раз через пару минут.");
}

// «составить заказ» is not a composition question, «составе» is.
const COMPOSITION_QUESTION_RE =
  /(құрам|курам|состав(?![иял])|ингредиент|аллерг|жаңғақ|жангак|орех|глютен|лактоз|ішінде не|ишинде не|что внутри|из чего)/iu;
const fold = (value: unknown) => String(value || "").toLowerCase().replace(/ё/g, "е");

/**
 * True when the guest asks what is inside a dish and the menu cannot say: either the
 * whole catalog carries no ingredients (dorumclub: 71 of 71 empty), or every dish the
 * guest names has none. A snapshot without a `composition` field says nothing, so it
 * changes nothing.
 */
export function needsKitchenCompositionCheck(ctx: FastFoodContext): boolean {
  if (!COMPOSITION_QUESTION_RE.test(String(ctx.text || ""))) return false;
  const items: any[] = Array.isArray(ctx.menuSnapshot?.items) ? ctx.menuSnapshot!.items : [];
  if (!items.length || items.some((item) => !("composition" in Object(item)))) return false;
  const known = (item: any) => Boolean(String(item.composition || "").trim());
  if (!items.some(known)) return true;
  const text = fold(ctx.text);
  const named = items.filter((item) => {
    const head = fold(item.name).split(/\s+/)[0] || "";
    return head.length >= 4 && text.includes(head);
  });
  return named.length > 0 && !named.some(known);
}

export async function answerCompositionQuestion(ctx: FastFoodContext, route: Route = routeComplaintToAdmin) {
  const routing = await route(ctx, {
    summary: `Құрам / аллерген сұрағы, мәзірде құрамы жоқ: ${String(ctx.text || "").slice(0, 300)}`,
    customerText: ctx.text,
    urgency: "normal",
    source: "composition_check",
  }).catch(() => null);
  // Without a person behind it the kitchen promise would be false, so the fallback only
  // says what is true: there is no verified composition to quote.
  return routing?.action === "operator_case_created"
    ? say(ctx, "Құрамын дәл қазір асүйден нақтылап беремін.", "Уточняю точный состав на кухне.")
    : say(ctx, "Құрамы бойынша нақты дерек қазір жоқ, сондықтан кепілдік бере алмаймын.",
      "Точного состава у меня сейчас нет, поэтому гарантировать не могу.");
}
