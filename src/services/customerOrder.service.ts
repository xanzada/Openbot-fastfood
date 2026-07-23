import { auditError } from "./auditLogger.service.js";
import { getOrderContext, normalizePhone } from "./dle.service.js";

export interface CustomerOrder {
  orderNumber: string;
  status: string;
  statusExplanation: string;
  items: Array<{ name: string; quantity: number }>;
}

export type CustomerOrderLookup =
  | { state: "found"; order: CustomerOrder }
  | { state: "not_found" }
  | { state: "ambiguous" }
  | { state: "unavailable" };

function statusKey(status: string) {
  return String(status || "")
    .trim()
    .toLowerCase()
    .replace(/[\s-]+/g, "_");
}

export function describeOrderStatus(status: string, language: "kk" | "ru") {
  const key = statusKey(status);
  const isDelivery = /(^|_)(delivery|out_of_delivery|out_for_delivery|on_the_way|courier)(_|$)/.test(key);
  if (isDelivery) return language === "ru" ? "курьер в пути" : "жеткізу жолында";
  if (/(prepar|cook|готовит|дайында|әзірле)/u.test(key)) return language === "ru" ? "готовится" : "дайындалып жатыр";
  if (/(ready|готов|дайын)/u.test(key)) return language === "ru" ? "готов к выдаче" : "алып кетуге дайын";
  if (/(paid|confirm|accepted|принят|қабылдан)/u.test(key)) return language === "ru" ? "принят и ожидает приготовления" : "қабылданды және дайындалуын күтуде";
  if (/(cancel|reject|отмен)/u.test(key)) return language === "ru" ? "отменён" : "бас тартылды";
  if (/(complete|done|finish|закрыт|аяқтал)/u.test(key)) return language === "ru" ? "завершён" : "аяқталды";
  return language === "ru" ? "статус обновлён" : "статус жаңартылды";
}

function customerItems(value: unknown): Array<{ name: string; quantity: number }> {
  if (!Array.isArray(value)) return [];
  return value
    .map((item: any) => {
      const name = String(item?.name || item?.title || "").trim().slice(0, 120);
      const quantity = Math.max(1, Math.min(99, Number(item?.qty || item?.quantity || item?.count || 1) || 1));
      return name ? { name, quantity } : null;
    })
    .filter((item): item is { name: string; quantity: number } => Boolean(item));
}

export function customerOrderFromRecord(
  value: Record<string, any> | null | undefined,
  expectedPhone: string,
  language: "kk" | "ru"
): CustomerOrderLookup {
  const record = value?.order || value?.active_order || value || null;
  const orderNumber = String(record?.id || record?.order_id || value?.order_id || "").trim().slice(0, 40);
  const status = String(record?.status || value?.status || "").trim().slice(0, 80);
  if (!orderNumber || !status) return { state: "not_found" };

  const ownerPhone = normalizePhone(record?.phone || value?.phone || "");
  const requestedPhone = normalizePhone(expectedPhone);
  if (ownerPhone && requestedPhone && ownerPhone !== requestedPhone) {
    auditError("Customer order ownership mismatch", new Error("ORDER_PHONE_MISMATCH"), {
      orderNumber,
      expectedPhone: requestedPhone,
      ownerPhone,
    });
    return { state: "not_found" };
  }

  return {
    state: "found",
    order: {
      orderNumber,
      status,
      statusExplanation: describeOrderStatus(status, language),
      items: customerItems(record?.items || value?.items),
    },
  };
}

export function customerOrderFromContext(
  context: Record<string, any> | null | undefined,
  expectedPhone: string,
  language: "kk" | "ru",
  hasRequestedOrderNumber = false
): CustomerOrderLookup {
  if (!context) return { state: "not_found" };
  if (context.is_stale) return { state: "unavailable" };
  if (Array.isArray(context.active_orders) && context.active_orders.length > 1 && !hasRequestedOrderNumber) {
    return { state: "ambiguous" };
  }
  return customerOrderFromRecord(context, expectedPhone, language);
}

export async function getCustomerOrder(
  instanceId: string,
  domain: string,
  phone: string,
  language: "kk" | "ru",
  orderNumber?: string
): Promise<CustomerOrderLookup> {
  try {
    const context = await getOrderContext(instanceId, domain, { phone, orderId: orderNumber }) as Record<string, any> | null;
    return customerOrderFromContext(context, phone, language, Boolean(orderNumber));
  } catch (error) {
    auditError("Customer order lookup failed", error, { instanceId, orderNumber: orderNumber || "", phone: normalizePhone(phone) });
    return { state: "unavailable" };
  }
}

export function formatCustomerOrderStatus(order: CustomerOrder, language: "kk" | "ru") {
  const items = order.items.slice(0, 8).map((item) => `${item.name} ×${item.quantity}`).join(", ");
  if (language === "ru") {
    return items
      ? `Заказ #${order.orderNumber}: текущий статус — ${order.status} (${order.statusExplanation}). Состав: ${items}.`
      : `Заказ #${order.orderNumber}: текущий статус — ${order.status} (${order.statusExplanation}).`;
  }
  return items
    ? `Тапсырыс #${order.orderNumber}: ағымдағы күйі — ${order.status} (${order.statusExplanation}). Құрамы: ${items}.`
    : `Тапсырыс #${order.orderNumber}: ағымдағы күйі — ${order.status} (${order.statusExplanation}).`;
}
