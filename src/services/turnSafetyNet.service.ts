import type { FastFoodContext } from "../context/types.js";
import { resolveAgentToolPlan, resolveLiveAgentToolPlan } from "../agent/toolPolicy.js";
import { groundMenuTurn } from "../skills/searchMenu.skill.js";
import { getCustomerOrder } from "./customerOrder.service.js";
import { requestedOrderNumber, lastDiscussedOrderNumber } from "../utils/orderIntent.js";
import { getMenuContext } from "./dle.service.js";
import { classifyKitchenSalesPolicyForContext } from "./kitchenPolicy.service.js";
import { hasDirectOrderIntent, hasCustomerCheckoutIntent, hasMenuInquiryIntent } from "../utils/orderIntent.js";
import { hasExplicitMenuLinkIntent } from "../utils/magicLink.js";
import { hasConfirmedCustomerIncident, isLikelyComplaintText, isLikelyOperatorRequestText, resolveComplaintContinuation, routeComplaintToAdmin } from "./complaintRouting.service.js";
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
 *    states the missing facts honestly; a known allergy can warrant a recorded handoff.
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
  /(келмеді|келмей|не\s*привез|не\s*пришл|не\s*приш[её]л|кешік|опазд|долго|ұзақ|күттім|күтіп\s*отыр|жду|жд[её]м|отмен|болдырма|возврат|верн|ақшам|деньг|суық|холодн|жалоб|шағым|оператор|менеджер|админ|адаммен|человек|қате|ошиб|неправильн)/iu;
const ORDER_WORD_RE = /(заказ|тапсырыс)/iu;
const NON_TEXT_MEDIA_RE = /(image|photo|document|video|sticker|file)/i;

export function needsHumanRecovery(ctx: FastFoodContext) {
  const text = String(ctx.text || "").trim();
  if (!text) return false;
  if (resolveAgentToolPlan(ctx).requiredTools.includes("checkOrderStatus") && !hasConfirmedCustomerIncident(ctx, text)) return false;
  if (isLikelyComplaintText(text) || isLikelyOperatorRequestText(text)) return true;
  if (intentMatches(NEEDS_PERSON_RE, text)) return true;
  if (intentMatches(ORDER_WORD_RE, text) && /(?:қайда|где)/iu.test(text)) return true;
  return Boolean(ctx.activeOrder && intentMatches(ORDER_WORD_RE, text));
}

export function isCalmCatalogTurn(ctx: FastFoodContext) {
  const text = String(ctx.text || "").trim();
  if (!text || !intentMatches(CATALOG_TURN_RE, text)) return false;
  if (needsHumanRecovery(ctx)) return false;
  if (resolveAgentToolPlan(ctx).requiredTools.includes("checkOrderStatus")) return false;
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

const VOICE_MENU_OVERVIEW_RE =
  /(мәзірде\s*не\s*бар|не\s*бар\s*мәзірде|сіздерде\s*не(?:\s*бар)?\s*[?.!]*$|что\s*(?:у\s*вас\s*)?есть\s*в\s*меню|что\s+у\s+вас(?:\s+есть)?\s*[?.!]*$|какие\s+(?:у\s+вас\s+)?(?:есть\s+)?(?:блюда|позиции)|ассортимент)/iu;
const VOICE_BEVERAGE_RE =
  /((?:ішетін|ишетин)\s*(?:не|нәрсе|сусын)?\s*бар|сусын(?:дар)?\s*(?:не|қандай)?\s*бар|не\s*ішем|что\s+(?:есть\s+)?попить|какие\s+напитки|напитки\s+есть|ішінде\s+не\s+бар[\s\S]{0,40}(?:кола|сусын)|шетінде\s+бар\s+деші)/iu;
const BEVERAGE_ITEM_RE =
  /(сусын|напит|кока|coca|cola|кола|pepsi|пепси|sprite|спрайт|fanta|фанта|айран|шай|шәй|чай|кофе|вода|сок|компот|лимонад|морс|энергет)/iu;

function isVoice(ctx: FastFoodContext) {
  const media: any = ctx.mediaContext || null;
  return Boolean(media && /audio|voice|ptt/i.test(String(media.kind || media.type || media.mimeType || "")));
}

export function isVoiceBeverageRequest(ctx: FastFoodContext) {
  return isVoice(ctx) && intentMatches(VOICE_BEVERAGE_RE, String(ctx.text || ""));
}

export function isVoiceMenuOverview(ctx: FastFoodContext) {
  return isVoice(ctx) && (
    intentMatches(VOICE_MENU_OVERVIEW_RE, String(ctx.text || ""))
    || isVoiceBeverageRequest(ctx)
  );
}

function itemIsBeverage(item: any) {
  const label = `${item?.name || ""} ${item?.category_name || item?.category || ""}`;
  return BEVERAGE_ITEM_RE.test(label) || /(?:^|\s)су(?:\s|$)/iu.test(label);
}

function voiceMenuExamples(ctx: FastFoodContext, max = 3, beveragesOnly = false) {
  const items: any[] = Array.isArray(ctx.menuSnapshot?.items) ? ctx.menuSnapshot.items : [];
  const notes: any[] = Array.isArray(ctx.activeShiftNotes) ? ctx.activeShiftNotes : [];
  const vocabulary = notes.length ? menuVocabulary(items) : [];
  const allowed = items.filter((item) =>
    item?.available !== false
    && String(item?.name || "").trim()
    && Number(item?.price) > 0
    && (!beveragesOnly || itemIsBeverage(item))
    && (!notes.length || !menuItemBlockedByNotes(notes, item, vocabulary).blocked));
  const picked: any[] = [];
  const categories = new Set<string>();
  for (const item of allowed) {
    const category = foldIntentText(item?.category_name || item?.category || "");
    if (!beveragesOnly && category && categories.has(category)) continue;
    picked.push(item);
    if (category) categories.add(category);
    if (picked.length >= max) break;
  }
  for (const item of allowed) {
    if (picked.length >= max) break;
    if (!picked.includes(item)) picked.push(item);
  }
  return picked;
}

export async function answerVoiceMenuOverview(ctx: FastFoodContext, grantLink: GrantLink = grantMenuLinkForFallback, readMenu: typeof getMenuContext = getMenuContext) {
  if (!isVoiceMenuOverview(ctx)) return null;
  const grounding = await groundMenuTurn(ctx, readMenu);
  if (grounding.menu_lookup === "unavailable") return say(ctx,
    "Қазір мәзірді тексере алмай тұрмын. Біраздан кейін қайта сұраңызшы.",
    "Сейчас не могу проверить меню. Попробуйте, пожалуйста, чуть позже.");
  const beverageRequest = isVoiceBeverageRequest(ctx);
  const examples = voiceMenuExamples(ctx, 3, beverageRequest);
  if (beverageRequest) {
    if (!examples.length) {
      return ctx.language === "ru"
        ? "Сейчас в меню не вижу доступных напитков. Могу подсказать другие позиции."
        : "Қазір мәзірде қолжетімді сусын көрінбейді. Басқа тағамдарды айтып бере аламын.";
    }
    const drinks = examples.map((item) => `${String(item.name).trim()} — ${Math.round(Number(item.price))} ₸`).join(", ");
    return ctx.language === "ru"
      ? `Из напитков есть: ${drinks}. Что выберете?`
      : `Ішетіннен бар: ${drinks}. Қайсысын қалайсыз?`;
  }
  if (!examples.length) return null;
  const linked = await grantLink(ctx).catch(() => false);
  const list = examples.map((item) => `${String(item.name).trim()} — ${Math.round(Number(item.price))} ₸`).join(", ");
  if (ctx.language === "ru") {
    return `Есть 😊 Например: ${list}. Что вам больше нравится?${linked ? " Полное меню тоже отправляю ссылкой ниже." : ""}`;
  }
  return `Бар 😊 Мысалы: ${list}. Қайсысы көңіліңізден шығады?${linked ? " Толық мәзірді де төмендегі сілтемеден көре аласыз." : ""}`;
}

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
  readMenu: typeof getMenuContext = getMenuContext,
  readOrder: typeof getCustomerOrder = getCustomerOrder,
) {
  const reason = String((error as any)?.message || error || "unknown").slice(0, 80);
  const continuation = await resolveComplaintContinuation(ctx);
  if (continuation) return continuation.customerReply;
  const plan = await resolveLiveAgentToolPlan(ctx);
  if (plan.requiredTools.includes("checkOrderStatus") && !hasConfirmedCustomerIncident(ctx)) {
    const number = requestedOrderNumber(ctx.text) || lastDiscussedOrderNumber(ctx.chatHistory);
    const lookup = await readOrder(ctx.instanceId, ctx.config?.domain || "", ctx.phone, ctx.language, number || undefined)
      .catch(() => ({ state: "unavailable" as const }));
    if (lookup.state === "found") {
      const order = lookup.order;
      return `Тапсырыс #${order.orderNumber}: ${order.statusLabel}. ${order.statusExplanation}.`.replace(/^Тапсырыс/u, ctx.language === "ru" ? "Заказ" : "Тапсырыс");
    }
    if (lookup.state === "not_found") return say(ctx, "Тапсырыс қазір табылған жоқ. Тапсырыс нөмірін тексеріңізші.",
      "Заказ сейчас не найден. Проверьте, пожалуйста, номер заказа.");
    return say(ctx, "Тапсырыстың қазіргі күйін растай алмаймын. Тапсырыс нөмірін жазыңызшы.",
      "Не могу сейчас подтвердить состояние заказа. Уточните, пожалуйста, номер заказа.");
  }
  const requestedLink = plan.requiredTools.includes("sendMenuLink");
  const linkReply = (linked: boolean) => {
    if (!linked) return say(ctx, "Қазір сілтемені жіберу мүмкін болмады. Біраздан кейін қайта сұраңызшы.",
      "Сейчас не удалось отправить ссылку. Попробуйте, пожалуйста, чуть позже.");
    const kitchen = classifyKitchenSalesPolicyForContext(ctx.runtimeStatus || ctx.hardRealtimeContext || null, ctx.activeShiftNotes);
    // A successful link preserves the customer's purpose, but does not establish
    // that an unread, closed or waiting kitchen can accept an order right now.
    const ordering = hasDirectOrderIntent(ctx.text) && kitchen.stateKnown && kitchen.mode === "normal";
    return ordering
      ? say(ctx, "Тапсырысты төмендегі сілтеме арқылы рәсімдей аласыз.", "Оформить заказ можно по ссылке ниже.")
      : say(ctx, "Мәзірді төмендегі сілтемеден қарай аласыз.", "Меню можно посмотреть по ссылке ниже.");
  };
  const menuLookup = plan.requiredTools.includes("searchMenu");
  if (menuLookup && !needsHumanRecovery(ctx)) {
    const grounding = await groundMenuTurn(ctx, readMenu);
    if (grounding.menu_lookup === "unavailable") return say(ctx,
      "Қазір мәзірді тексере алмай тұрмын. Біраздан кейін қайта сұраңызшы.",
      "Сейчас не могу проверить меню. Попробуйте, пожалуйста, чуть позже.");
    const matches = (grounding.items || []).filter((item: any) => Number(item.price) > 0).slice(0, 3);
    const alternatives = (grounding.safe_alternatives || []).filter((item: any) => Number(item.price) > 0).slice(0, 3);
    const list = (matches.length ? matches : alternatives)
      .map((item: any) => String(item.name) + " — " + Number(item.price) + " ₸").join(", ");
    const directOrdering = hasDirectOrderIntent(ctx.text);
    // A broad menu request may have no named item match. Execute its current
    // planned link through the real issuer instead of claiming a missing dish.
    if (!matches.length && requestedLink && !directOrdering
      && !findBlockedMenuItemMention(ctx.activeShiftNotes || [], ctx.menuSnapshot?.items || [], ctx.text)) {
      return linkReply(await grantLink(ctx).catch(() => false));
    }
    if (!matches.length) return say(ctx,
      "Бұл сұрағаныңыз қазір қолжетімсіз." + (list ? " Мыналар бар: " + list + "." : ""),
      "Сейчас этой позиции нет в доступном меню." + (list ? " Есть другие варианты: " + list + "." : ""));
    const kitchen = classifyKitchenSalesPolicyForContext(ctx.runtimeStatus || ctx.hardRealtimeContext || null, ctx.activeShiftNotes);
    // Current ordering-method questions share checkout intent; an explicit menu
    // link request still asks for browsing rather than current order acceptance.
    const ordering = directOrdering || (hasCustomerCheckoutIntent(ctx.text) && !hasMenuInquiryIntent(ctx.text));
    if (ordering && !kitchen.stateKnown) return say(ctx,
      "Қазір тапсырыс қабылдап жатқанымызды растай алмаймын. Мәзірде: " + list + ".",
      "Не могу сейчас подтвердить, принимаем ли заказы. В меню: " + list + ".");
    if (ordering && kitchen.blocksAllSales && kitchen.mode !== "off_hours") return say(ctx,
      "Қазір тапсырыс қабылдай алмаймыз. Мәзірде: " + list + ".",
      "Сейчас заказы не принимаем. В меню: " + list + ".");
    if (ordering && kitchen.requiresConsent && ctx.kitchenCheckoutFingerprint !== kitchen.fingerprint) return say(ctx,
      "Мәзірде: " + list + ". Күту уақыты — " + kitchen.waitLabelKk + ". Күтуге келісесіз бе?",
      "В меню: " + list + ". Ожидание — " + kitchen.waitLabelRu + ". Вы готовы подождать?");
    const linked = requestedLink ? await grantLink(ctx).catch(() => false) : false;
    let linkFailure = "";
    // Keep a denied or failed current link request useful after the fresh price
    // answer. Kitchen facts explain blocked actions; an allowed issuer failure
    // supplies no additional backend cause or successful-link evidence.
    if (!linked && (requestedLink || hasCustomerCheckoutIntent(ctx.text))) {
      if (!kitchen.stateKnown) linkFailure = say(ctx,
        "Қазір асүйдің күйін растай алмаймын, сондықтан сілтемені әзірше жібермеймін. Біраздан кейін қайта сұраңызшы.",
        "Не могу сейчас подтвердить состояние кухни, поэтому ссылку пока не отправляю. Попробуйте, пожалуйста, чуть позже.");
      else if (kitchen.blocksAllSales && kitchen.mode !== "off_hours") linkFailure = say(ctx,
        "Қазір тапсырыс қабылдамаймыз, сілтемені әзірше жібермеймін. Мәзірді осында айтып бере аламын.",
        "Сейчас заказы не принимаем, ссылку пока не отправляю. Могу подсказать меню здесь.");
      else if (kitchen.requiresConsent && ctx.kitchenCheckoutFingerprint !== kitchen.fingerprint) linkFailure = say(ctx,
        "Сілтемені әзірше жібермеймін. Күту уақыты — " + kitchen.waitLabelKk + ". Күтуге келісесіз бе?",
        "Ссылку пока не отправляю. Ожидание — " + kitchen.waitLabelRu + ". Вы готовы подождать?");
      else linkFailure = linkReply(false);
    }
    const offHours = ordering && kitchen.mode === "off_hours";
    const orderLink = ordering && kitchen.stateKnown && !kitchen.blocksAllSales
      && (!kitchen.requiresConsent || ctx.kitchenCheckoutFingerprint === kitchen.fingerprint);
    return say(ctx, "Бар: " + list + "." + (offHours ? " Қазір жұмыс уақытынан тыс, тапсырыс ашылғанда қабылданады." : "")
      + (linked ? (orderLink ? " Тапсырыс беру сілтемесін төменге жібердім." : " Мәзірді қарау сілтемесін төменге жібердім.") : (linkFailure ? " " + linkFailure : "")),
      "Есть: " + list + "." + (offHours ? " Сейчас вне рабочего времени, заказ можно оформить после открытия." : "")
      + (linked ? (orderLink ? " Оформить заказ можно по ссылке ниже." : " Ссылку для просмотра меню отправил ниже.") : (linkFailure ? " " + linkFailure : "")));
  }
  if (requestedLink && !needsHumanRecovery(ctx)) {
    return linkReply(await grantLink(ctx).catch(() => false));
  }
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
      return linkReply(linked);
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
  const customerTexts = [ctx.text, ...(Array.isArray(ctx.chatHistory) ? ctx.chatHistory : [])
    .filter((entry: any) => entry.role === "user").slice(-8).map((entry: any) => String(entry.text || entry.content || ""))];
  const latestAllergyStatement = [
    ...customerTexts.slice(1), ctx.text,
  ].filter((text) => /аллерг/iu.test(text)).at(-1);
  const actualAllergy = Boolean(latestAllergyStatement && hasConfirmedCustomerIncident(ctx, latestAllergyStatement));
  const uncertainty = say(ctx, "Құрамы мен аллергендері туралы расталған дерек жоқ. Қауіпсіздігіне кепілдік бере алмаймын.",
    "У меня нет подтверждённых данных о составе и аллергенах. Гарантировать безопасность не могу.");
  if (!actualAllergy) return uncertainty;
  const routing = await route(ctx, {
    summary: `Аллергия: құрамы мен қауіпсіздігін нақтылау қажет. ${String(ctx.text || "").slice(0, 300)}`,
    customerText: ctx.text,
    urgency: "normal",
    source: "composition_check",
  }).catch(() => null);
  return routing?.action === "operator_case_created"
    ? say(ctx, "Құрам туралы сұрағыңыз операторға берілді. Қауіпсіздігіне кепілдік бере алмаймын.",
      "Вопрос о составе передан оператору. Гарантировать безопасность не могу.")
    : uncertainty;
}
