import { auditError } from "./auditLogger.service.js";
import { getOrderContext, normalizePhone } from "./dle.service.js";

export type CustomerOrderStage = "awaiting_confirmation" | "awaiting_receipt" | "receipt_review" | "preparing" | "delivery" | "completed" | "cancelled" | "unknown";
export interface CustomerOrder { orderNumber: string; status: string; stage: CustomerOrderStage; statusLabel: string; statusExplanation: string; items: Array<{ name: string; quantity: number }>; }
export type CustomerOrderLookup = { state: "found"; order: CustomerOrder } | { state: "not_found" } | { state: "ambiguous" } | { state: "unavailable" };

function statusKey(status: string) { return String(status || "").trim().toLowerCase().replace(/[\s-]+/g, "_"); }
function hasPaymentRequest(aiComment: unknown) { return String(aiComment || "").toUpperCase().includes("[PAY_REQ]"); }
function hasReceiptMarker(aiComment: unknown) {
  const value=String(aiComment||"").trim();
  return /\[RECEIPT(?:_REVIEW)?\]/i.test(value) || /^сумма:\s*.+,\s*отправитель:\s*.+\s+\([^)]+\)$/iu.test(value);
}
export function classifyOrderStage(status: string, aiComment: unknown = ""): CustomerOrderStage {
  const key = statusKey(status);
  if (key === "pending") {
    if (hasPaymentRequest(aiComment)) return "awaiting_receipt";
    if (hasReceiptMarker(aiComment)) return "receipt_review";
    return "awaiting_confirmation";
  }
  if (key === "paid") return "preparing";
  if (key === "delivery") return "delivery";
  if (key === "completed") return "completed";
  if (key === "cancelled" || key === "canceled") return "cancelled";
  return "unknown";
}
export function describeOrderStage(stage: CustomerOrderStage, language: "kk" | "ru") {
  const labels = language === "ru" ? {
    awaiting_confirmation: ["Новый", "заказ получен и ожидает подтверждения ресторана"], awaiting_receipt: ["Ждём чек", "реквизиты отправлены, ожидаем чек об оплате"], receipt_review: ["Чек отправлен", "чек получен и ожидает проверки оператора"], preparing: ["Готовится", "оплата подтверждена, заказ готовится"], delivery: ["В пути", "заказ у курьера и едет к вам"], completed: ["Завершён", "заказ завершён"], cancelled: ["Отменён", "заказ отменён"], unknown: ["Статус обновлён", "точный этап пока не определён"],
  } : {
    awaiting_confirmation: ["Жаңа", "тапсырыс қабылданды және ресторан растауын күтуде"], awaiting_receipt: ["Чек күтудеміз", "реквизиттер жіберілді, төлем чегін күтіп тұрмыз"], receipt_review: ["Чек жіберілді", "чек алынды және оператор тексеруін күтуде"], preparing: ["Дайындалуда", "төлем расталды, тапсырыс дайындалып жатыр"], delivery: ["Жолда", "тапсырыс курьерде және сізге келе жатыр"], completed: ["Аяқталды", "тапсырыс аяқталды"], cancelled: ["Бас тартылды", "тапсырыстан бас тартылды"], unknown: ["Статус жаңартылды", "нақты кезеңі әзірге анықталмады"],
  };
  const value = labels[stage] as string[]; return { label: value[0], explanation: value[1] };
}
export function describeOrderStatus(status: string, language: "kk" | "ru", aiComment: unknown = "") { return describeOrderStage(classifyOrderStage(status, aiComment), language).explanation; }
function customerItems(value: unknown): Array<{ name: string; quantity: number }> { if (!Array.isArray(value)) return []; return value.map((item:any)=>{const name=String(item?.name||item?.title||"").trim().slice(0,120);const quantity=Math.max(1,Math.min(99,Number(item?.qty||item?.quantity||item?.count||1)||1));return name?{name,quantity}:null;}).filter((x):x is {name:string;quantity:number}=>Boolean(x)); }
export function customerOrderFromRecord(value: Record<string,any>|null|undefined, expectedPhone:string, language:"kk"|"ru"): CustomerOrderLookup {
  const record=value?.order||value?.active_order||value||null; const orderNumber=String(record?.id||record?.order_id||value?.order_id||"").trim().slice(0,40); const status=String(record?.status||value?.status||"").trim().slice(0,80); if(!orderNumber||!status)return{state:"not_found"};
  const ownerPhone=normalizePhone(record?.phone||value?.phone||""); const requestedPhone=normalizePhone(expectedPhone); if(ownerPhone&&requestedPhone&&ownerPhone!==requestedPhone){auditError("Customer order ownership mismatch",new Error("ORDER_PHONE_MISMATCH"),{orderNumber,expectedPhone:requestedPhone,ownerPhone});return{state:"not_found"};}
  const stage=classifyOrderStage(status,record?.ai_comment||value?.ai_comment); const description=describeOrderStage(stage,language); return{state:"found",order:{orderNumber,status,stage,statusLabel:description.label,statusExplanation:description.explanation,items:customerItems(record?.items||value?.items)}};
}
export function customerOrderFromContext(context:Record<string,any>|null|undefined,expectedPhone:string,language:"kk"|"ru",hasRequestedOrderNumber=false):CustomerOrderLookup{if(!context)return{state:"not_found"};if(context.is_stale)return{state:"unavailable"};if(Array.isArray(context.active_orders)&&context.active_orders.length>1&&!hasRequestedOrderNumber)return{state:"ambiguous"};return customerOrderFromRecord(context,expectedPhone,language);}
export async function getCustomerOrder(instanceId:string,domain:string,phone:string,language:"kk"|"ru",orderNumber?:string):Promise<CustomerOrderLookup>{try{const context=await getOrderContext(instanceId,domain,{phone,orderId:orderNumber}) as Record<string,any>|null;return customerOrderFromContext(context,phone,language,Boolean(orderNumber));}catch(error){auditError("Customer order lookup failed",error,{instanceId,orderNumber:orderNumber||"",phone:normalizePhone(phone)});return{state:"unavailable"};}}
// A status line that stops at the label leaves the guest wondering what to do
// next, so every answer ends with who moves and when.
export function orderNextStepLine(order:CustomerOrder,language:"kk"|"ru"){
  const label=String(order.statusLabel||"").toLowerCase();
  // "Дайындалуда" contains "дайын", so the ready branch used to win and sent a
  // guest to collect food that was still on the stove. In-progress labels are
  // matched first and "ready" now has to stand as a whole word.
  if(/готовит|даярла|дайындал|дайындау|принят|қабылдан|жаңа|новый/.test(label)) return language==="ru"?"Как только будет готово, сразу напишем.":"Дайын болған сәтте бірден хабарлаймыз.";
  if(/пути|достав|жолда|жеткіз/.test(label)) return language==="ru"?"Курьер уже едет к вам.":"Курьер жолға шықты.";
  if(/отмен|болдыр|бас тарт/.test(label)) return language==="ru"?"Если это ошибка, напишите — сразу разберёмся.":"Егер бұл қате болса, жазыңыз — бірден шешеміз.";
  if(/(?<!\p{L})готов(?:о|а|ый)?(?!\p{L})|(?<!\p{L})дайын(?!\p{L})|заверш|орындал/u.test(label)) return language==="ru"?"Можете забирать — всё упаковано.":"Алып кетуге болады — бәрі дайын.";
  return language==="ru"?"Как только что-то изменится, сразу напишем.":"Жаңалық болса, бірден хабарлаймыз.";
}
export function formatCustomerOrderStatus(order:CustomerOrder,language:"kk"|"ru"){const items=order.items.slice(0,8).map(i=>`${i.name} ×${i.quantity}`).join(", ");if(language==="ru")return items?`Заказ #${order.orderNumber}: ${order.statusLabel} — ${order.statusExplanation}. Состав: ${items}. ${orderNextStepLine(order,language)}`:`Заказ #${order.orderNumber}: ${order.statusLabel} — ${order.statusExplanation}. ${orderNextStepLine(order,language)}`;return items?`Тапсырыс #${order.orderNumber}: ${order.statusLabel} — ${order.statusExplanation}. Құрамы: ${items}. ${orderNextStepLine(order,language)}`:`Тапсырыс #${order.orderNumber}: ${order.statusLabel} — ${order.statusExplanation}. ${orderNextStepLine(order,language)}`;}
