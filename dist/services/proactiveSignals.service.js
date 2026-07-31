import { getJsonCache, setJsonCache } from "./redis.service.js";
const ORDER_SNAPSHOT_TTL = 60 * 60 * 24 * 14;
const LINK_SENT_TTL = 60 * 60 * 24 * 14;
function orderSnapshotKey(instanceId, phone) {
    return `order_snapshot:${instanceId}:${phone}`;
}
function linkSentKey(instanceId, phone) {
    return `link_sent_at:${instanceId}:${phone}`;
}
export function orderSignature(order) {
    if (!order)
        return "";
    const id = order.id || order.order_id || order.orderId || order.number || order.order_number || "";
    const status = order.status || order.state || order.order_status || "";
    return id || status ? `${id}|${status}` : "";
}
export function statusWord(order) {
    const raw = String(order?.status || order?.state || order?.order_status || "").toLowerCase();
    if (!raw)
        return "";
    if (/(достав|jetkiz|жеткіз|deliver)/u.test(raw))
        return "delivered";
    if (/(путь|road|jol|жол|courier|курьер)/u.test(raw))
        return "on_the_way";
    if (/(готов|daiyn|дайын|ready)/u.test(raw))
        return "ready";
    if (/(cancel|отмен|bolydyrma|болдырма)/u.test(raw))
        return "cancelled";
    return "";
}
/**
 * Computes notes and refreshes the snapshots for the next turn. Never throws.
 */
export async function computeProactiveSignals(ctx) {
    try {
        const notes = [];
        const now = Date.now();
        const previousRaw = await getJsonCache(orderSnapshotKey(ctx.instanceId, ctx.phone)).catch(() => null);
        const currentSignature = orderSignature(ctx.activeOrder);
        const previousSignature = String(previousRaw?.signature || "");
        if (currentSignature !== previousSignature) {
            const currentStatus = statusWord(ctx.activeOrder);
            if (previousSignature && currentSignature && currentStatus) {
                const humanStatus = {
                    delivered: { kk: "тапсырысы жеткізілген сияқты", ru: "заказ, похоже, доставлен" },
                    on_the_way: { kk: "тапсырысы жолға шыққан", ru: "заказ уже в пути" },
                    ready: { kk: "тапсырысы дайын болған", ru: "заказ уже готов" },
                    cancelled: { kk: "тапсырысы болдырылған", ru: "заказ был отменён" },
                };
                const label = humanStatus[currentStatus];
                if (label) {
                    notes.push(ctx.language === "kk" ? `Соңғы байланыстан бері ${label.kk}.` : `С прошлого контакта ${label.ru}.`);
                }
            }
            void setJsonCache(orderSnapshotKey(ctx.instanceId, ctx.phone), ORDER_SNAPSHOT_TTL, { signature: currentSignature, at: now }).catch(() => undefined);
        }
        // Abandoned checkout: a link was sent a while ago, no active order exists,
        // and the guest is back. Worth a gentle nudge only if the topic comes up.
        if (ctx.magicLinkAlreadySent && !ctx.activeOrder) {
            const linkInfo = await getJsonCache(linkSentKey(ctx.instanceId, ctx.phone)).catch(() => null);
            const sentAt = Number(linkInfo?.at || 0);
            const hoursAgo = sentAt ? (now - sentAt) / 3_600_000 : 0;
            if (sentAt && hoursAgo >= 3 && hoursAgo <= 24 * 14) {
                notes.push(ctx.language === "kk"
                    ? "Бұрын жіберілген тапсырыс сілтемесі әлі аяқталмаған сияқты."
                    : "Ранее отправленная ссылка на заказ, похоже, так и не была завершена.");
            }
        }
        if (ctx.explicitMenuLinkIntent) {
            void setJsonCache(linkSentKey(ctx.instanceId, ctx.phone), LINK_SENT_TTL, { at: now }).catch(() => undefined);
        }
        return notes.length ? { notes: notes.slice(0, 3) } : null;
    }
    catch {
        return null;
    }
}
