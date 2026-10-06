import type { FastFoodContext } from "../context/types.js";
import { hasDirectOrderIntent, hasCustomerCheckoutIntent, hasMenuInquiryIntent, isCustomerOrderStatusQuestion, isLikelyOrderStatusFollowUp } from "../utils/orderIntent.js";
import { complaintHasActionableDetail, isLikelyComplaintText } from "../services/complaintRouting.service.js";
import { classifyKitchenSalesPolicyForContext, detectKitchenConsentAnswer } from "../services/kitchenPolicy.service.js";
import { intentMatches } from "../utils/intentText.js";
import { isMenuBudgetInquiry } from "../utils/menuBudget.js";
import { getKitchenCheckoutFingerprint } from "../services/redis.service.js";
import { wantsMenuAsText } from "../utils/magicLink.js";
import { isContextualCompositionQuestion } from "../utils/menuQuestionContext.js";

export type AgentToolName =
  | "searchMenu"
  | "getPaymentDetails"
  | "updateCrmLead"
  | "escalateToAdmin"
  | "sendMenuLink"
  | "checkOrderStatus"
  | "getBusinessInfo"
  | "getKitchenStatus"
  | "getShiftNotes";

export interface AgentToolPlan {
  requiredTools: AgentToolName[];
  reason: string[];
}

// "Балама аллергия бар... Не ұсынасыз?" asked for a recommendation and named a
// constraint, and none of the patterns below matched it: the model answered with
// invented prices, the validator stripped them, and the guest was left with
// "these dishes contain no seafood" naming no dishes at all (live round,
// 2026-08-12). Any request for a recommendation, or one that rules an ingredient
// out, is a menu lookup.
//
// A question about discounts belongs here too. The catalog is what knows which dishes
// carry a crossed-out old price, so "акцияларыңыз бар ма?" is a menu lookup - it used to
// reach the model with no tool and no promo facts, which is how the bot denied a promotion
// its own storefront was running (found 2026-08-24).
//
// «етсіз» must start a word: «Сәлеметсіз бе», the most common formal greeting, folds to
// «салеметсиз» and pinned a menu lookup on a plain hello (live log, 2026-10-03).
const MENU_OVERVIEW_RE =
  /(мәзірде|мәзірден|менюде|ассортимент|мәзірде\s*не\s*бар|не\s*бар\s*мәзірде|сіздерде\s*не(?:\s*бар)?\s*[?.!]*$|что\s*(?:у\s*вас\s*)?есть\s*в\s*меню|что\s+у\s+вас(?:\s+есть)?\s*[?.!]*$|какие\s*(?:у\s*вас\s*)?(?:есть\s*)?(?:блюда|позиции)|қандай\s*(?:тағам|ас))/iu;
const MENU_LOOKUP_RE =
  /(мәзірде|мәзірден|менюде|ассортимент|мәзірде\s*не\s*бар|не\s*бар\s*мәзірде|сіздерде\s*не(?:\s*бар)?\s*[?.!]*$|что\s*(?:у\s*вас\s*)?есть\s*в\s*меню|что\s+у\s+вас(?:\s+есть)?\s*[?.!]*$|какие\s*(?:у\s*вас\s*)?(?:есть\s*)?(?:блюда|позиции)|қандай\s*(?:тағам|ас)|бар\s*ма|барма|есть\s*ли|что\s+(?:входит|взять|выбрать|посоветуе)|что-нибудь|қанша\s*(?:тұр|тұрады|теңге)|ск(?:олько|ока)\s*(?:стоит|тенге)|баға|цена|құрамы|состав|ингредиент|ащы|остр|вегетари|халал|п[ие]п+ерони|pepperoni|маргарит|пицц|бургер|донер|шаурм|суши|ролл|салат|сусын|напит|ішетін|ишетин|кока|кол[ауы]|cola|спрайт|sprite|фанта|fanta|пепси|pepsi|айран|кофе|лимонад|цезар|(?<!\p{L})(?:сок|вода|чай|шай)(?!\p{L})|десерт|комбо|сет|балалар|дет(?:ям|ское)|реб[её]н|(?<!\p{L})етсіз|без\s*мяс|бюджет|деш[её]в|арзан|лаваш|ұсынас|ұсыныңыз|кеңес\s*бер|советуе|посоветуй|рекоменд|аллерг|глютен|лактоз|жаңғақ|орех|теңіз\s*өнім|морепродукт|(?:жоқ|без)\s*(?:тағам|блюд)|тағам\s*керек|акци|скидк|жеңілдік|женилдик|промо|арзандат|распродаж|выгодн)/iu;
const DIRECT_MENU_LINK_RE =
  /(сілтеме|ссылка|link|линк|каталог|мәзірді\s*(?:жібер|бер|аш)|меню\s*(?:пришли|скинь|дай|открой|покажи)|тапсырыс\s*(?:бер|жасай|ет)|заказ\s*(?:хочу|сдел|оформ)|заказать|оформить|корзин|себет)/iu;
// The guest is DOING something, not asking about the assortment: placing an order, asking
// for the link, continuing a checkout. For them the link is the answer, so the
// answer-before-link swap below leaves the pin alone.
const ORDER_ACTION_RE =
  /(сілтеме|ссылк\p{L}*|link|линк|мәзір(?:ді|\s+сілтемесін)\s*(?:жібер|бер|аш)|меню\s*(?:пришли|скинь|дай|открой|покажи)|тапсырыс\s*(?:бер|берей|берем|жасай|жасас|ет|қыл)|заказ\s*(?:бер|берей|берем|жасай|хочу|сдел|оформ)|заказать|оформить|корзин|себет|жалғастыр|продолж)/iu;
const PAYMENT_DETAILS_RE =
  /(реквизит|kaspi|каспи|halyk|халық|оплат\p{L}*|төлем|аудар\p{L}*|перевод).*(?:қалай|қайда|как|куда|номер|счет|шот|сілтеме|ссылка)?/iu;
const RECEIPT_EVENT_RE =
  /(чек(?:ті|ті\s+жібер| отправ| скин)|receipt|түбірте[кг]|квитанц|ақшаны\s+аудар|деньги\s+перев[её]л)/iu;
export const BUSINESS_INFO_RE =
  /(мекен-?жай|адрес|қайда\s*(?:орналас|тұр)|қай\s*жерде|орналасқан|где\s*(?:находит|вы)|жұмыс\s*уақыт|жұмыс\s*істей|график|режим\s*работ|до\s*скольк|сколько.{0,30}(?:работ|открыт)|сағат\s*нешеге|телефон|номер\s*(?:рестора|заведен)|қалай\s*табам|бүгін\s*ашық|сегодня\s*открыт|түнде\s*жұмыс|работа\p{L}*\s*ночью)/iu;

// The kitchen's live state is the first thing the operator changes and the last
// thing a cached snapshot knows. Any question about waiting, closure or whether
// an order can be taken right now must re-read it instead of trusting context.
const KITCHEN_STATUS_RE =
  /(қанша\s*(?:уақыт|минут)|неше\s*минут|күтем|күту\s*уақыт|дайын\s*бол|сколько\s*(?:ждать|минут|по\s*времени)|ждать|ожидан|как\s*(?:долго|быстро)|быстро\s*ли|жеткіз\p{L}*\s*(?:бар|қанша|уақыт)|доставка\s*(?:работает|есть|сколько)|өзім\s*алып|самовывоз|навынос|қабылдай\s*(?:ма|сыз\s*ба)|принима\p{L}*\s*заказ|ашық\s*па|жабық\s*па|закрыт\p{L}*\s*ли|открыт\p{L}*\s*ли|жұмыс\s*(?:істеп\s*)?(?:тұр\s*ма|жасай\s*ма))/iu;

// Browsing needs catalog facts even when checkout is unavailable. Keep the
// shared broad inquiry detector behind a current, unquoted menu + viewing ask;
// a link request, past report or refusal alone must not pin a catalog lookup.
function hasCurrentMenuBrowseInquiry(text: string): boolean {
  const current = text.replace(/«[^»]*»|“[^”]*”|"[^"]*"|‘[^’]*’|'[^']*'/gu, "");
  if (!hasMenuInquiryIntent(current)) return false;
  let browse = false;
  for (const clause of current.split(/[.!?;,\n]+|(?<!\p{L})(?:но|бірақ|и|және)(?!\p{L})/iu)) {
    if (!intentMatches(/(?<!\p{L})(?:мәзір\p{L}*|меню)(?!\p{L})/iu, clause)) continue;
    if (intentMatches(/(?:кеше|вчера|раньше|оператор[^,;.!?]{0,30}(?:сказал|айтты)|клиент[^,;.!?]{0,30}(?:написал|жазды))/iu, clause)) continue;
    if (intentMatches(/(?:қарама|қарамай|көрме|көрмей|қарағым\s+келмейді|(?:мәзір\p{L}*|меню)[^,;.!?]{0,20}(?:керек\s+емес|қажет\s+емес|не\s+(?:нуж\p{L}*|надо))|не\s+(?:(?:хочу|буду)\s+)?(?:смотр\p{L}*|посмотр\p{L}*|нуж\p{L}*)|(?:смотр\p{L}*|посмотр\p{L}*)\s+не\s+(?:буду|хочу))/iu, clause)) {
      browse = false;
      continue;
    }
    if (intentMatches(/(?:қарай|қарап|қарағым|көрейін|көру|көрсем|посмотр\p{L}*|смотр\p{L}*|(?:қайдан|қайда|қандай|что|где|как)[^,;.!?]{0,35}(?:мәзір|меню)|(?:мәзір|меню)[^,;.!?]{0,35}(?:қайдан|қайда|қандай|что|где|как))/iu, clause)
      || /^(?:мәзір|мазір|меню)\s*$/iu.test(clause.trim())) browse = true;
  }
  return browse;
}

function add(plan: AgentToolPlan, tool: AgentToolName, reason: string) {
  if (plan.requiredTools.includes(tool)) return;
  plan.requiredTools.push(tool);
  plan.reason.push(reason);
}

/**
 * Code-gates only high-confidence live-data intents. Everything else remains
 * model-decided so the agent can reason about new conversational situations
 * without waiting for a new regex or prompt example.
 */
export function resolveAgentToolPlan(ctx: FastFoodContext): AgentToolPlan {
  const text = String(ctx.text || "").trim();
  const plan: AgentToolPlan = { requiredTools: [], reason: [] };
  const immediateServiceIncident = isLikelyComplaintText(text) && complaintHasActionableDetail(text);
  const paymentDetailsIntent = intentMatches(PAYMENT_DETAILS_RE, text) && !intentMatches(RECEIPT_EVENT_RE, text);
  // hardRealtimeContext is ALWAYS truthy and carries neither is_accepting_orders nor
  // within_work_hours - and classifyKitchenSalesPolicy defaults BOTH to true. So a
  // closed, emergency-stopped or off-hours kitchen was classified "normal" here,
  // checkoutBlocked stayed false, sendMenuLink got pinned, and the skill then
  // refused: the turn was spent on a refusal instead of the honest closed answer.
  // Every other caller (buildFactsPrompt, menuLink.skill) reads ctx.runtimeStatus;
  // this was the one place that preferred the partial object (found 2026-08-22).
  const runtime = ctx.runtimeStatus || ctx.hardRealtimeContext;
  const kitchenPolicy = classifyKitchenSalesPolicyForContext(runtime || null, ctx.activeShiftNotes);
  const checkoutBlocked = (kitchenPolicy.blocksAllSales && kitchenPolicy.mode !== "off_hours") || (kitchenPolicy.requiresConsent && ctx.kitchenCheckoutFingerprint !== kitchenPolicy.fingerprint);

  if (immediateServiceIncident) {
    add(plan, "escalateToAdmin", "actionable_service_incident");
  } else if (isCustomerOrderStatusQuestion(text) || (Boolean(ctx.activeOrder) && isLikelyOrderStatusFollowUp(text))) {
    add(plan, "checkOrderStatus", "live_order_status");
  }

  if (paymentDetailsIntent) {
    add(plan, "getPaymentDetails", "live_payment_details");
  }

  if (intentMatches(BUSINESS_INFO_RE, text)) {
    add(plan, "getBusinessInfo", "current_business_information");
  }

  if (intentMatches(KITCHEN_STATUS_RE, text)) {
    add(plan, "getKitchenStatus", "live_kitchen_status");
  }

  // The runtime read failed, so every sales flag fell back to its open default. Rather
  // than selling on that assumption, spend one call on the real state - getKitchenStatus
  // hits the hub with forceFresh (found 2026-08-23). Keyed on the positive signal
  // preloadContext writes, not on a missing object: hardRealtimeContext is always
  // present, so "no object" is a test shape, never a production one.
  if ((runtime as Record<string, any> | null)?.runtime_available === false) {
    add(plan, "getKitchenStatus", "kitchen_state_unknown");
  }

  // A complaint suppressed searchMenu but not sendMenuLink, so an angry guest
  // demanding a refund was handed the menu link and nothing else. Nobody who is
  // complaining is asking to start a new order.
  const directOrderIntent = hasDirectOrderIntent(text);
  const catalogWords = (Array.isArray(ctx.menuSnapshot?.items) ? ctx.menuSnapshot.items : [])
    .flatMap((item: any) => String(item?.name || item?.title || "").toLowerCase().match(/\p{L}{3,}/gu) || []);
  const customerWords = text.toLowerCase().match(/\p{L}{3,}/gu) || [];
  const namedCatalogItem = catalogWords.some((name: string) => customerWords.some((word) =>
    word === name || (name.length >= 4 && word.startsWith(name))));
  const menuLookup = hasCurrentMenuBrowseInquiry(text) || isMenuBudgetInquiry(text) || intentMatches(MENU_LOOKUP_RE, text) || namedCatalogItem || wantsMenuAsText(text) || isContextualCompositionQuestion(text);
  if (!paymentDetailsIntent && !checkoutBlocked && !immediateServiceIncident
    && (hasCustomerCheckoutIntent(text) || ctx.explicitMenuLinkIntent && detectKitchenConsentAnswer(text) === "yes" && ctx.kitchenCheckoutFingerprint === kitchenPolicy.fingerprint)) {
    add(plan, "sendMenuLink", "personal_menu_link");
  }

  if (!immediateServiceIncident && menuLookup) {
    add(plan, "searchMenu", "live_menu_lookup");
  }

  // Read the named product before checkout, including direct orders. A link cannot
  // establish whether that product exists, is available, or is blocked by a note.
  const searchIndex = plan.requiredTools.indexOf("searchMenu");
  const linkIndex = plan.requiredTools.indexOf("sendMenuLink");
  if (searchIndex > -1 && linkIndex > -1 && linkIndex < searchIndex
    && (menuLookup || !(intentMatches(ORDER_ACTION_RE, text) || directOrderIntent) || intentMatches(MENU_OVERVIEW_RE, text))) {
    plan.requiredTools[linkIndex] = "searchMenu";
    plan.requiredTools[searchIndex] = "sendMenuLink";
    const reason = plan.reason[linkIndex];
    plan.reason[linkIndex] = plan.reason[searchIndex];
    plan.reason[searchIndex] = reason;
  }

  // Accepted deferred checkout must spend the first autonomous step on its link.
  if (ctx.kitchenCheckoutFingerprint === kitchenPolicy.fingerprint && detectKitchenConsentAnswer(text) === "yes") {
    const continuationLink = plan.requiredTools.indexOf("sendMenuLink");
    if (continuationLink > 0) {
      plan.requiredTools.unshift(plan.requiredTools.splice(continuationLink, 1)[0]);
      plan.reason.unshift(plan.reason.splice(continuationLink, 1)[0]);
    }
  }

  return {
    requiredTools: plan.requiredTools.slice(0, 3),
    reason: plan.reason.slice(0, 3),
  };
}

// Both webhook and standalone agent entrypoints honor the same persisted consent.
export async function resolveLiveAgentToolPlan(ctx: FastFoodContext): Promise<AgentToolPlan> {
  const policy = classifyKitchenSalesPolicyForContext(ctx.runtimeStatus || ctx.hardRealtimeContext, ctx.activeShiftNotes);
  if (policy.requiresConsent) {
    ctx.kitchenCheckoutFingerprint = await getKitchenCheckoutFingerprint(ctx.instanceId, ctx.phone).catch(() => null);
    const priorCheckout = (Array.isArray(ctx.chatHistory) ? ctx.chatHistory : []).slice(-8)
      .some((entry: any) => entry.role === "user" && hasCustomerCheckoutIntent(String(entry.text || entry.content || "")));
    if (ctx.kitchenCheckoutFingerprint === policy.fingerprint && detectKitchenConsentAnswer(ctx.text) === "yes" && priorCheckout) {
      ctx.explicitMenuLinkIntent = true;
    }
  } else {
    ctx.kitchenCheckoutFingerprint = null;
  }
  return resolveAgentToolPlan(ctx);
}

/**
 * The plan seeds the first move, it does not drive the whole turn.
 *
 * The previous policy forced one tool per step and then locked toolChoice to
 * "none", with activeTools narrowed to a single tool. Any regex hit therefore
 * removed the agent's own judgment for the rest of the turn: it could not chain
 * a second lookup, could not re-check a fact, and could not skip a tool that
 * turned out to be irrelevant. That is exactly the "prompt/regex dependence"
 * that made replies feel mechanical.
 *
 * Now: when code is confident about a live-data intent, the first step is still
 * pinned so the answer is always grounded in fresh data. Every later step is
 * the agent's own decision, with the full toolset available.
 */
export function createAgentStepPolicy(plan: AgentToolPlan) {
  return ({ stepNumber }: { stepNumber: number }) => {
    if (stepNumber === 0 && plan.requiredTools.length) {
      const firstTool = plan.requiredTools[0];
      return {
        toolChoice: { type: "tool" as const, toolName: firstTool },
      };
    }
    // Four autonomous tool rounds are enough even for a multi-intent request.
    // The final two steps are reserved for synthesis so a model cannot spend the
    // whole budget repeating lookups and return an empty customer reply.
    if (stepNumber >= 4) return { toolChoice: "none" as const };
    return { toolChoice: "auto" as const };
  };
}
