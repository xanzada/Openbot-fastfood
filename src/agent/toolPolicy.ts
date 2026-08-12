import type { FastFoodContext } from "../context/types.js";
import { isCustomerOrderStatusQuestion, isLikelyOrderStatusFollowUp } from "../utils/orderIntent.js";
import { complaintHasActionableDetail, isLikelyComplaintText } from "../services/complaintRouting.service.js";
import { classifyKitchenSalesPolicy } from "../services/kitchenPolicy.service.js";
import { intentMatches } from "../utils/intentText.js";
import { wantsMenuAsText } from "../utils/magicLink.js";

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
const MENU_LOOKUP_RE =
  /(бар\s*ма|барма|есть\s*ли|что\s+(?:входит|взять|выбрать|посоветуе)|что-нибудь|қанша\s*(?:тұр|тұрады|теңге)|ск(?:олько|ока)\s*(?:стоит|тенге)|баға|цена|құрамы|состав|ингредиент|ащы|остр|вегетари|халал|п[ие]п+ерони|pepperoni|маргарит|пицц|бургер|донер|шаурм|суши|ролл|салат|сусын|напит|десерт|комбо|сет|балалар|дет(?:ям|ское)|реб[её]н|етсіз|без\s*мяс|бюджет|деш[её]в|арзан|лаваш|ұсынас|ұсыныңыз|кеңес\s*бер|советуе|посоветуй|рекоменд|аллерг|глютен|лактоз|жаңғақ|орех|теңіз\s*өнім|морепродукт|(?:жоқ|без)\s*(?:тағам|блюд)|тағам\s*керек)/iu;
const DIRECT_MENU_LINK_RE =
  /(сілтеме|ссылка|link|линк|каталог|мәзірді\s*(?:жібер|бер|аш)|меню\s*(?:пришли|скинь|дай|открой|покажи)|тапсырыс\s*(?:бер|жасай|ет)|заказ\s*(?:хочу|сдел|оформ)|заказать|оформить|корзин|себет)/iu;
const PAYMENT_DETAILS_RE =
  /(реквизит|kaspi|каспи|halyk|халық|оплат\p{L}*|төлем|аудар\p{L}*|перевод).*(?:қалай|қайда|как|куда|номер|счет|шот|сілтеме|ссылка)?/iu;
const RECEIPT_EVENT_RE =
  /(чек(?:ті|ті\s+жібер| отправ| скин)|receipt|түбірте[кг]|квитанц|ақшаны\s+аудар|деньги\s+перев[её]л)/iu;
const BUSINESS_INFO_RE =
  /(мекенжай|адрес|қайда\s*(?:орналас|тұр)|қай\s*жерде|орналасқан|где\s*(?:находит|вы)|жұмыс\s*уақыт|жұмыс\s*істей|график|режим\s*работ|до\s*скольк|сколько.{0,30}(?:работ|открыт)|сағат\s*нешеге|телефон|номер\s*(?:рестора|заведен)|қалай\s*табам|бүгін\s*ашық|сегодня\s*открыт|түнде\s*жұмыс|работа\p{L}*\s*ночью)/iu;

// The kitchen's live state is the first thing the operator changes and the last
// thing a cached snapshot knows. Any question about waiting, closure or whether
// an order can be taken right now must re-read it instead of trusting context.
const KITCHEN_STATUS_RE =
  /(қанша\s*(?:уақыт|минут)|неше\s*минут|күтем|күту\s*уақыт|дайын\s*бол|сколько\s*(?:ждать|минут|по\s*времени)|ждать|ожидан|как\s*(?:долго|быстро)|быстро\s*ли|жеткіз\p{L}*\s*(?:бар|қанша|уақыт)|доставка\s*(?:работает|есть|сколько)|өзім\s*алып|самовывоз|навынос|қабылдай\s*(?:ма|сыз\s*ба)|принима\p{L}*\s*заказ|ашық\s*па|жабық\s*па|закрыт\p{L}*\s*ли|открыт\p{L}*\s*ли|жұмыс\s*(?:істеп\s*)?(?:тұр\s*ма|жасай\s*ма))/iu;

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
  const runtime = ctx.hardRealtimeContext || ctx.runtimeStatus;
  const kitchenPolicy = classifyKitchenSalesPolicy(runtime || null);
  const checkoutBlocked = kitchenPolicy.blocksAllSales || kitchenPolicy.requiresConsent;

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

  if (!immediateServiceIncident && (intentMatches(MENU_LOOKUP_RE, text) || wantsMenuAsText(text))) {
    add(plan, "searchMenu", "live_menu_lookup");
  }

  // A complaint suppressed searchMenu but not sendMenuLink, so an angry guest
  // demanding a refund was handed the menu link and nothing else. Nobody who is
  // complaining is asking to start a new order.
  if (!paymentDetailsIntent && !checkoutBlocked && !immediateServiceIncident && !wantsMenuAsText(text)
    && (intentMatches(DIRECT_MENU_LINK_RE, text) || ctx.explicitMenuLinkIntent)) {
    add(plan, "sendMenuLink", "personal_menu_link");
  }

  return {
    requiredTools: plan.requiredTools.slice(0, 3),
    reason: plan.reason.slice(0, 3),
  };
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
