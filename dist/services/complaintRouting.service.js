import { clearComplaintMedia, getComplaintMedia } from "./redis.service.js";
import { getRestaurantConfig } from "./nocodb.service.js";
import { sendWhatsProMessage } from "../transport/whatspro.client.js";
const ESCALATION_SIGNAL_RE = /\[(ESCALATE_ADMIN|ESCALATE_DEVELOPER)\]/giu;
const ADMIN_SIGNAL_RE = /\[ESCALATE_ADMIN\]/iu;
const DEVELOPER_SIGNAL_RE = /\[ESCALATE_DEVELOPER\]/iu;
const COMPLAINT_RE = /(шағым|жалоб|претензи|волос|шаш|гряз|лас|суық|суык|холодн|испорч|бұзыл|бузыл|улан|отрав|не тот заказ|басқа тапсырыс|қате тапсырыс|не привезли|жетпей|не хватает|сапа|качест)/iu;
function normalizePhone(value = "") {
    return String(value || "").replace(/\D/g, "");
}
function cleanLine(value, max = 700) {
    return String(value || "")
        .replace(/\s+/g, " ")
        .trim()
        .slice(0, max);
}
function getAdminPhone(config = {}) {
    return normalizePhone(config.admin_phone ||
        config.admin ||
        config.manager_phone ||
        config.operator_phone ||
        config.complaint_phone ||
        process.env.ADMIN_PHONE ||
        "");
}
function getRestaurantLabel(ctx, liveConfig) {
    return cleanLine(liveConfig.name || liveConfig.restaurant_name || ctx.config?.name || ctx.config?.restaurant_name || ctx.instanceId, 120);
}
function getOrderLabel(ctx) {
    return cleanLine(ctx.activeOrder?.order_id || ctx.activeOrder?.id || ctx.activeOrder?.orderId || "not_found", 80);
}
function toWhatsProMedia(media) {
    if (!media?.base64)
        return null;
    const mimeType = media.mimeType || media.mediaType || "image/jpeg";
    return {
        base64: media.base64,
        mimeType,
        filename: media.filename,
        type: mimeType.startsWith("image/") ? "image" : "document",
    };
}
export function hasEscalateAdminSignal(text = "") {
    return ADMIN_SIGNAL_RE.test(String(text || ""));
}
export function hasEscalateDeveloperSignal(text = "") {
    return DEVELOPER_SIGNAL_RE.test(String(text || ""));
}
export function stripEscalationSignals(text = "") {
    return String(text || "").replace(ESCALATION_SIGNAL_RE, "").replace(/\s{2,}/g, " ").trim();
}
export function isLikelyComplaintText(text = "") {
    return COMPLAINT_RE.test(String(text || ""));
}
export function buildComplaintClarificationReply(language) {
    return language === "ru"
        ? "Пожалуйста, коротко опишите проблему текстом. Я передам фото и описание администратору."
        : "Мәселені қысқаша мәтінмен сипаттап жіберіңіз. Фото мен сипаттаманы админге жіберемін.";
}
export function buildComplaintAckReply(language) {
    return language === "ru"
        ? "Извините за ситуацию. Я передал жалобу администратору, он проверит и свяжется с вами."
        : "Кешіріңіз. Шағымды админге жібердім, ол тексеріп сізбен байланысады.";
}
export async function hasPendingComplaintMedia(instanceId, phone) {
    const media = await getComplaintMedia(instanceId, phone).catch(() => null);
    return Boolean(media?.base64);
}
export async function routeComplaintToAdmin(ctx, input) {
    const liveConfig = (await getRestaurantConfig(ctx.instanceId).catch(() => null)) || {};
    const adminPhone = getAdminPhone(liveConfig);
    const savedMedia = await getComplaintMedia(ctx.instanceId, ctx.phone).catch(() => null);
    const media = toWhatsProMedia(input.media || savedMedia);
    const summary = cleanLine(input.summary || input.customerText || ctx.text || "Customer complaint requires review.");
    const customerText = cleanLine(input.customerText || ctx.text || "", 900);
    const urgency = input.urgency || "normal";
    const adminText = [
        "OPENBOT COMPLAINT",
        `Restaurant: ${getRestaurantLabel(ctx, liveConfig)}`,
        `Customer: +${ctx.phone}`,
        `Order: ${getOrderLabel(ctx)}`,
        `Urgency: ${urgency}`,
        `Source: ${cleanLine(input.source || "openbot", 80)}`,
        "",
        `Summary: ${summary}`,
        customerText && customerText !== summary ? `Customer text: ${customerText}` : "",
    ]
        .filter(Boolean)
        .join("\n");
    let sent = null;
    if (adminPhone) {
        sent = await sendWhatsProMessage({
            instanceId: ctx.instanceId,
            phone: adminPhone,
            text: adminText,
            media,
        });
        if (savedMedia?.base64) {
            await clearComplaintMedia(ctx.instanceId, ctx.phone).catch(() => undefined);
        }
    }
    return {
        action: "complaint_to_admin",
        adminPhone: adminPhone || null,
        escalationAvailable: Boolean(adminPhone),
        mediaAttached: Boolean(media),
        sent,
        customerReply: input.customerReply || buildComplaintAckReply(ctx.language),
        adminText,
    };
}
