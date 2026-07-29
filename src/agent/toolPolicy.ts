import type { FastFoodContext } from "../context/types.js";
import { isCustomerOrderStatusQuestion, isLikelyOrderStatusFollowUp } from "../utils/orderIntent.js";

export type AgentToolName =
  | "searchMenu"
  | "getPaymentDetails"
  | "updateCrmLead"
  | "escalateToAdmin"
  | "sendMenuLink"
  | "checkOrderStatus"
  | "getBusinessInfo";

export interface AgentToolPlan {
  requiredTools: AgentToolName[];
  reason: string[];
}

const MENU_LOOKUP_RE =
  /(бар\s*ма|есть\s*ли|қанша\s*(?:тұр|тұрады|теңге)|сколько\s*(?:стоит|тенге)|баға|цена|құрамы|состав|ингредиент|ащы|остр|вегетари|халал|пепперони|pepperoni|пицц|бургер|донер|шаурм|суши|ролл|салат|сусын|напит|десерт|комбо|сет)/iu;
const DIRECT_MENU_LINK_RE =
  /(сілтеме|ссылка|link|линк|каталог|мәзірді\s*(?:жібер|бер|аш)|меню\s*(?:пришли|скинь|дай|открой|покажи)|тапсырыс\s*(?:бер|жасай|ет)|заказ\s*(?:хочу|сдел|оформ)|заказать|оформить|корзин|себет)/iu;
const PAYMENT_DETAILS_RE =
  /(реквизит|kaspi|каспи|halyk|халық|оплат(?:ить|а|у)|төлем|аударым|перевод).*(?:қалай|қайда|как|куда|номер|счет|шот)?/iu;
const RECEIPT_EVENT_RE =
  /(чек(?:ті|ті\s+жібер| отправ| скин)|receipt|түбіртек|квитанц)/iu;
const BUSINESS_INFO_RE =
  /(мекенжай|адрес|қайда\s*(?:орналас|тұр)|где\s*(?:находит|вы)|жұмыс\s*уақыт|жұмыс\s*істей|график|режим\s*работ|до\s*скольк|сколько.{0,30}(?:работ|открыт)|сағат\s*нешеге|телефон|номер\s*(?:рестора|заведен)|қалай\s*табам)/iu;

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

  if (isCustomerOrderStatusQuestion(text) || (Boolean(ctx.activeOrder) && isLikelyOrderStatusFollowUp(text))) {
    add(plan, "checkOrderStatus", "live_order_status");
  }

  if (PAYMENT_DETAILS_RE.test(text) && !RECEIPT_EVENT_RE.test(text)) {
    add(plan, "getPaymentDetails", "live_payment_details");
  }

  if (BUSINESS_INFO_RE.test(text)) {
    add(plan, "getBusinessInfo", "current_business_information");
  }

  if (MENU_LOOKUP_RE.test(text)) {
    add(plan, "searchMenu", "live_menu_lookup");
  }

  if (DIRECT_MENU_LINK_RE.test(text) || (ctx.explicitMenuLinkIntent && !MENU_LOOKUP_RE.test(text))) {
    add(plan, "sendMenuLink", "personal_menu_link");
  }

  return {
    requiredTools: plan.requiredTools.slice(0, 3),
    reason: plan.reason.slice(0, 3),
  };
}

export function createAgentStepPolicy(plan: AgentToolPlan) {
  return ({ stepNumber }: { stepNumber: number }) => {
    const requiredTool = plan.requiredTools[stepNumber];
    if (requiredTool) {
      return {
        activeTools: [requiredTool],
        toolChoice: { type: "tool" as const, toolName: requiredTool },
      };
    }
    if (plan.requiredTools.length) {
      return { toolChoice: "none" as const };
    }
    return undefined;
  };
}
