import { auditError } from "./auditLogger.service.js";
import { getOrderContext, normalizePhone } from "./dle.service.js";
function statusKey(status) { return String(status || "").trim().toLowerCase().replace(/[\s-]+/g, "_"); }
function hasPaymentRequest(aiComment) { return String(aiComment || "").toUpperCase().includes("[PAY_REQ]"); }
function hasReceiptMarker(aiComment) {
    const value = String(aiComment || "").trim();
    return /\[RECEIPT(?:_REVIEW)?\]/i.test(value) || /^сумма:\s*.+,\s*отправитель:\s*.+\s+\([^)]+\)$/iu.test(value);
}
export function classifyOrderStage(status, aiComment = "", paymentStatus = "") {
    const key = statusKey(status);
    const paymentKey = statusKey(String(paymentStatus || ""));
    if (["receipt_review", "receipt_uploaded", "waiting_review", "pending_review"].includes(paymentKey) || ["receipt_review", "receipt_uploaded"].includes(key))
        return "receipt_review";
    if (["waiting_receipt", "awaiting_receipt", "payment_pending", "awaiting_payment"].includes(paymentKey) || ["confirmed", "accepted", "waiting_receipt", "awaiting_receipt", "payment_pending", "awaiting_payment"].includes(key))
        return "awaiting_receipt";
    if (paymentKey === "paid")
        return "preparing";
    if (key === "pending") {
        if (hasPaymentRequest(aiComment))
            return "awaiting_receipt";
        if (hasReceiptMarker(aiComment))
            return "receipt_review";
        return "awaiting_confirmation";
    }
    if (key === "paid")
        return "preparing";
    if (key === "delivery")
        return "delivery";
    if (key === "completed")
        return "completed";
    if (key === "cancelled" || key === "canceled")
        return "cancelled";
    return "unknown";
}
export function describeOrderStage(stage, language) {
    const labels = language === "ru" ? {
        awaiting_confirmation: ["Новый", "заказ получен и ожидает подтверждения ресторана"], awaiting_receipt: ["Ждём чек", "реквизиты отправлены, ожидаем чек об оплате"], receipt_review: ["Чек отправлен", "чек получен и ожидает проверки оператора"], preparing: ["Готовится", "оплата подтверждена, заказ готовится"], delivery: ["В пути", "заказ у курьера и едет к вам"], completed: ["Завершён", "заказ завершён"], cancelled: ["Отменён", "заказ отменён"], unknown: ["Статус обновлён", "точный этап пока не определён"],
    } : {
        awaiting_confirmation: ["Жаңа", "тапсырыс қабылданды және ресторан растауын күтуде"], awaiting_receipt: ["Чек күтудеміз", "реквизиттер жіберілді, төлем чегін күтіп тұрмыз"], receipt_review: ["Чек жіберілді", "чек алынды және оператор тексеруін күтуде"], preparing: ["Дайындалуда", "төлем расталды, тапсырыс дайындалып жатыр"], delivery: ["Жолда", "тапсырыс курьерде және сізге келе жатыр"], completed: ["Аяқталды", "тапсырыс аяқталды"], cancelled: ["Бас тартылды", "тапсырыстан бас тартылды"], unknown: ["Статус жаңартылды", "нақты кезеңі әзірге анықталмады"],
    };
    const value = labels[stage];
    return { label: value[0], explanation: value[1] };
}
export function describeOrderStatus(status, language, aiComment = "") { return describeOrderStage(classifyOrderStage(status, aiComment), language).explanation; }
function localizedItemName(value) { if (typeof value === "string" || typeof value === "number")
    return String(value).trim(); if (!value || typeof value !== "object" || Array.isArray(value))
    return ""; const record = value; for (const candidate of [record.ru, record.kk, record.kz, record.name, record.title, record.value]) {
    const text = localizedItemName(candidate);
    if (text)
        return text;
} return ""; }
function customerItems(value) { if (!Array.isArray(value))
    return []; return value.map((item) => { const name = localizedItemName(item?.name || item?.title || item?.product_name || item?.product?.name || item?.product?.title).slice(0, 120); const quantity = Math.max(1, Math.min(99, Number(item?.qty || item?.quantity || item?.count || 1) || 1)); return name ? { name, quantity } : null; }).filter((x) => Boolean(x)); }
export function customerOrderFromRecord(value, expectedPhone, language) {
    const record = value?.order || value?.active_order || value || null;
    const orderId = String(record?.id || record?.order_id || record?.uuid || value?.order_id || "").trim().slice(0, 80);
    const orderNumber = String(record?.display_number || record?.order_number || record?.number || record?.order_no || orderId).trim().slice(0, 40);
    const status = String(record?.status || value?.status || "").trim().slice(0, 80);
    if (!orderId || !status)
        return { state: "not_found" };
    const ownerPhone = normalizePhone(record?.phone || record?.phone_e164 || value?.phone || value?.phone_e164 || "");
    const requestedPhone = normalizePhone(expectedPhone);
    if (ownerPhone && requestedPhone && ownerPhone !== requestedPhone) {
        auditError("Customer order ownership mismatch", new Error("ORDER_PHONE_MISMATCH"), { orderNumber, expectedPhone: requestedPhone, ownerPhone });
        return { state: "not_found" };
    }
    const stage = classifyOrderStage(status, record?.ai_comment || value?.ai_comment, record?.payment_status || value?.payment_status);
    const description = describeOrderStage(stage, language);
    return { state: "found", order: { orderId, orderNumber, status, stage, statusLabel: description.label, statusExplanation: description.explanation, items: customerItems(record?.items || value?.items) } };
}
function orderIdOf(record) { return String(record?.id || record?.order_id || "").trim(); }
function orderMatchesNumber(record, value) { const expected = String(value || "").trim(); return [record?.id, record?.order_id, record?.display_number, record?.order_number, record?.number, record?.order_no].some((candidate) => String(candidate || "").trim() === expected); }
function createdAtOf(record) { return Date.parse(String(record?.created_at || "").replace(" ", "T")) || 0; }
function orderPools(context) {
    if (!context)
        return [];
    const pools = [context.recent_orders, context.active_orders, [context.order, context.active_order]];
    const seen = new Set();
    const out = [];
    for (const pool of pools) {
        if (!Array.isArray(pool))
            continue;
        for (const record of pool) {
            const id = orderIdOf(record);
            if (!id || seen.has(id))
                continue;
            seen.add(id);
            out.push(record);
        }
    }
    return out;
}
function orderItemWords(record) {
    const items = customerItems(record?.items);
    const words = [];
    for (const item of items) {
        for (const word of String(item.name).toLowerCase().split(/[^\p{L}\p{N}]+/u)) {
            if (word.length >= 4)
                words.push(word);
        }
    }
    return words;
}
// Guests rarely quote an order number. They say "the one with the Caesar".
// Matching the dishes they name against their own orders lets the bot follow
// what the person actually means instead of whatever the site calls active.
export function orderMentionedByItems(context, text) {
    const haystack = String(text || "").toLowerCase();
    if (!haystack)
        return null;
    let best = null;
    let bestScore = 0;
    for (const record of orderPools(context)) {
        let score = 0;
        for (const word of orderItemWords(record)) {
            if (haystack.includes(word.slice(0, Math.max(4, word.length - 2))))
                score += 1;
        }
        if (score > bestScore) {
            bestScore = score;
            best = record;
        }
    }
    return bestScore > 0 ? best : null;
}
// The order the conversation is about wins over whichever order the site calls
// "active", unless the site knows about a newer one the guest has not mentioned yet.
export function pickConversationOrder(context, discussedNumber) {
    if (!context || !discussedNumber)
        return null;
    const pools = [context.recent_orders, context.active_orders, [context.order, context.active_order]];
    let pinned = null;
    for (const pool of pools) {
        if (!Array.isArray(pool))
            continue;
        const hit = pool.find((record) => orderMatchesNumber(record, discussedNumber));
        if (hit) {
            pinned = hit;
            break;
        }
    }
    if (!pinned)
        return null;
    const current = context.order || context.active_order || null;
    if (current && orderIdOf(current) !== orderIdOf(pinned) && createdAtOf(current) > createdAtOf(pinned))
        return null;
    return pinned;
}
export function customerOrderFromContext(context, expectedPhone, language, hasRequestedOrderNumber = false) { if (!context)
    return { state: "not_found" }; if (context.is_stale)
    return { state: "unavailable" }; if (Array.isArray(context.active_orders) && context.active_orders.length > 1 && !hasRequestedOrderNumber)
    return { state: "ambiguous" }; return customerOrderFromRecord(context, expectedPhone, language); }
export async function getCustomerOrder(instanceId, domain, phone, language, orderNumber) { try {
    const context = await getOrderContext(instanceId, domain, { phone, orderId: orderNumber });
    return customerOrderFromContext(context, phone, language, Boolean(orderNumber));
}
catch (error) {
    auditError("Customer order lookup failed", error, { instanceId, orderNumber: orderNumber || "", phone: normalizePhone(phone) });
    return { state: "unavailable" };
} }
// A status line that stops at the label leaves the guest wondering what to do
// next, so every answer ends with who moves and when.
export function orderNextStepLine(order, language) {
    const label = String(order.statusLabel || "").toLowerCase();
    // "Дайындалуда" contains "дайын", so the ready branch used to win and sent a
    // guest to collect food that was still on the stove. In-progress labels are
    // matched first and "ready" now has to stand as a whole word.
    if (/готовит|даярла|дайындал|дайындау|принят|қабылдан|жаңа|новый/.test(label))
        return language === "ru" ? "Как только будет готово, сразу напишем." : "Дайын болған сәтте бірден хабарлаймыз.";
    if (/пути|достав|жолда|жеткіз/.test(label))
        return language === "ru" ? "Курьер уже едет к вам." : "Курьер жолға шықты.";
    if (/отмен|болдыр|бас тарт/.test(label))
        return language === "ru" ? "Если это ошибка, напишите — сразу разберёмся." : "Егер бұл қате болса, жазыңыз — бірден шешеміз.";
    if (/(?<!\p{L})готов(?:о|а|ый)?(?!\p{L})|(?<!\p{L})дайын(?!\p{L})|заверш|орындал/u.test(label))
        return language === "ru" ? "Можете забирать — всё упаковано." : "Алып кетуге болады — бәрі дайын.";
    return language === "ru" ? "Как только что-то изменится, сразу напишем." : "Жаңалық болса, бірден хабарлаймыз.";
}
export function formatCustomerOrderStatus(order, language) { const items = order.items.slice(0, 8).map(i => `${i.name} ×${i.quantity}`).join(", "); if (language === "ru")
    return items ? `Заказ #${order.orderNumber}: ${order.statusLabel} — ${order.statusExplanation}. Состав: ${items}. ${orderNextStepLine(order, language)}` : `Заказ #${order.orderNumber}: ${order.statusLabel} — ${order.statusExplanation}. ${orderNextStepLine(order, language)}`; return items ? `Тапсырыс #${order.orderNumber}: ${order.statusLabel} — ${order.statusExplanation}. Құрамы: ${items}. ${orderNextStepLine(order, language)}` : `Тапсырыс #${order.orderNumber}: ${order.statusLabel} — ${order.statusExplanation}. ${orderNextStepLine(order, language)}`; }
