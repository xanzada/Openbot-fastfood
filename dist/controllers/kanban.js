import crypto from "node:crypto";
import { getRuntimeStatus, normalizePhone } from "../services/dle.service.js";
import { getRestaurantConfig } from "../services/nocodb.service.js";
import { connectRedis, deleteShiftNote, getKitchenStatus, redisClient, saveKitchenStatus, saveShiftNote, saveToHistory, } from "../services/redis.service.js";
import { notifyDeveloperSystemFailure } from "../services/developerNotify.service.js";
import { sendWhatsProMessage } from "../transport/whatspro.client.js";
const INSTANCE_RE = /^[a-zA-Z0-9_-]{2,64}$/;
const ORDER_ID_RE = /^\d{1,12}$/;
const VALID_ACTIONS = new Set([
    "new_order",
    "status_changed",
    "request_payment",
    "order_rejected",
    "shift_note_created",
    "shift_note_deleted",
    "update_kitchen_status",
    "get_kitchen_status",
    "developer_alert",
    "complaint",
]);
const statusTemplates = {
    kk: {
        review: "Чек тексерілуде. Оператор растаған соң дайындаймыз.",
        paid: "Төлем расталды, тапсырысыңыз қабылданды. Дайындалып жатыр.",
        delivery: "Тапсырысыңыз курьерге берілді, жеткізу жолында.",
        completed: "Тапсырыс сәтті аяқталды, асыңыз дәмді болсын!",
        pickup_ready: "Тапсырысыңыз дайын. Келіп алып кетуіңізге болады.",
        cancelled: "Тапсырысыңыздан бас тартылды. Қажет болса, мәзір арқылы жаңа тапсырыс бере аласыз.",
    },
    ru: {
        review: "Чек проверяется. Как только оператор подтвердит, начнем готовить.",
        paid: "Оплата подтверждена, заказ принят. Готовим.",
        delivery: "Ваш заказ передан курьеру и уже в пути.",
        completed: "Заказ успешно завершен, приятного аппетита!",
        pickup_ready: "Ваш заказ готов. Можете забирать.",
        cancelled: "Ваш заказ отменен. При необходимости можете оформить новый заказ через меню.",
    },
};
function textValue(value, fallback = "") {
    return String(value ?? fallback).trim();
}
function cleanInline(value, max = 200) {
    return textValue(value).replace(/[\r\n\t]+/g, " ").replace(/\s+/g, " ").slice(0, max).trim();
}
function numberValue(value, fallback = 0) {
    const num = Number(value);
    return Number.isFinite(num) ? num : fallback;
}
function boolValue(value, fallback = false) {
    if (typeof value === "boolean")
        return value;
    if (typeof value === "number")
        return value !== 0;
    const normalized = textValue(value).toLowerCase();
    if (["1", "true", "yes", "on", "pickup"].includes(normalized))
        return true;
    if (["0", "false", "no", "off"].includes(normalized))
        return false;
    return fallback;
}
function parseJsonArray(value) {
    if (Array.isArray(value))
        return value;
    if (typeof value !== "string" || !value.trim())
        return [];
    try {
        const parsed = JSON.parse(value);
        return Array.isArray(parsed) ? parsed : [];
    }
    catch {
        return [];
    }
}
function normalizePaymentDetails(value) {
    return parseJsonArray(value)
        .map((item) => {
        const source = item && typeof item === "object" ? item : {};
        return {
            label: cleanInline(source.label || source.name || source.title || "Реквизит", 60),
            value: cleanInline(source.value || source.number || source.url || source.link || "", 250),
            source: source.source ? cleanInline(source.source, 40) : undefined,
        };
    })
        .filter((item) => item.value)
        .slice(0, 12);
}
function paymentDetailsFromConfig(config) {
    for (const key of ["payment_details", "paymentDetails", "requisites", "requisite_details", "payment_requisites"]) {
        const details = normalizePaymentDetails(config[key]);
        if (details.length)
            return details;
    }
    return normalizePaymentDetails([
        { label: "Kaspi", value: config.kaspi_info || config.kaspi || config.kaspi_number || config.kaspi_phone },
        { label: "Halyk", value: config.halyk_info || config.halyk || config.halyk_number || config.halyk_phone },
        { label: "QR", value: config.payment_qr || config.qr || config.qr_link },
    ]);
}
function paymentDetailsText(details, lang) {
    if (!details.length) {
        return lang === "ru"
            ? "Реквизиты пока не настроены. Пожалуйста, подождите ответ оператора."
            : "Реквизиттер әзірге бапталмаған. Оператор жауабын күте тұрыңыз.";
    }
    return details.map((item) => `${item.label}: ${item.value}`).join("\n");
}
function paymentDetailsFromRuntime(runtimeStatus) {
    if (!runtimeStatus)
        return [];
    const kitchen = runtimeStatus.kitchen_status && typeof runtimeStatus.kitchen_status === "object"
        ? runtimeStatus.kitchen_status
        : {};
    return normalizePaymentDetails(runtimeStatus.payment_details || kitchen.payment_details);
}
async function getLiveRuntimeStatus(instance, config) {
    const domain = textValue(config.domain || config.website || config.url);
    if (!domain)
        return null;
    return getRuntimeStatus(instance, domain, { forceFresh: true }).catch((error) => {
        console.warn(`[KANBAN] ${instance}: runtime read failed:`, error instanceof Error ? error.message : error);
        return null;
    });
}
function getLanguage(body) {
    return textValue(body.lang || body.language).toLowerCase() === "ru" ? "ru" : "kk";
}
function normalizeItems(value) {
    return parseJsonArray(value)
        .map((item) => {
        const source = item && typeof item === "object" ? item : {};
        const qty = Math.min(99, Math.max(1, numberValue(source.qty || source.count || source.quantity, 1)));
        const price = Math.max(0, numberValue(source.price, 0));
        return {
            name: cleanInline(source.name || source.title || source.product_name || "Тауар", 80),
            qty,
            price,
            total: Math.max(0, numberValue(source.total || source.sum, price * qty)),
        };
    })
        .filter((item) => item.name)
        .slice(0, 50);
}
function buildCartText(body) {
    const items = normalizeItems(body.items || body.goods || body.products);
    if (items.length) {
        return items.map((item) => `- ${item.name} x${item.qty} = ${item.total || item.price * item.qty} ₸`).join("\n");
    }
    const cartList = cleanInline(body.cart_list, 3000);
    return cartList || "- Тапсырыс тізімі табылмады";
}
function buildNewOrderMessage(body, lang, orderId, isPickup) {
    const totalAmount = cleanInline(body.total_price || body.total || 0, 40);
    const address = cleanInline(body.address || (lang === "ru" ? "Не указан" : "Көрсетілмеген"), 200);
    const rawComment = cleanInline(body.comment || body.info, 500);
    const persons = numberValue(body.persons, 0);
    const bonus = numberValue(body.bonus, 0);
    const lines = lang === "ru"
        ? [`Ваш заказ №${orderId} принят!`, isPickup ? "Тип: самовывоз" : `Адрес: ${address}`]
        : [`№${orderId} тапсырысыңыз қабылданды!`, isPickup ? "Түрі: алып кету" : `Мекенжай: ${address}`];
    if (bonus > 0)
        lines.push(lang === "ru" ? `Списанный бонус: ${bonus} ₸` : `Жұмсалған бонус: ${bonus} ₸`);
    if (persons > 0)
        lines.push(lang === "ru" ? `Количество персон: ${persons}` : `Адам саны: ${persons}`);
    if (rawComment)
        lines.push(lang === "ru" ? `Комментарий: ${rawComment}` : `Пікір: ${rawComment}`);
    lines.push("", lang === "ru" ? "Состав заказа:" : "Тапсырыс құрамы:", buildCartText(body));
    lines.push("", lang === "ru" ? `Итого: ${totalAmount} ₸` : `Барлығы: ${totalAmount} ₸`);
    lines.push(lang === "ru"
        ? "Мы проверяем наличие на кухне, пожалуйста, ожидайте 1-2 минуты."
        : "Біз ас үйде бар-жоғын тексеріп жатырмыз, 1-2 минут күте тұрыңыз.");
    return lines.join("\n");
}
async function buildPaymentMessage(body, config, lang, instance) {
    const totalAmount = cleanInline(body.total_price || body.total || 0, 40);
    const runtimeStatus = await getLiveRuntimeStatus(instance, config);
    const payloadDetails = normalizePaymentDetails(body.payment_details || body.paymentDetails || body.requisites);
    const runtimeDetails = paymentDetailsFromRuntime(runtimeStatus);
    const configDetails = paymentDetailsFromConfig(config);
    const paymentInfo = paymentDetailsText(payloadDetails.length ? payloadDetails : runtimeDetails.length ? runtimeDetails : configDetails, lang);
    if (lang === "ru") {
        return `Все в наличии!\nСумма к оплате: ${totalAmount} ₸\n\nОплата:\n${paymentInfo}\n\nПожалуйста, отправьте чек об оплате в этот чат.`;
    }
    return `Бәрі бар!\nТөлем сомасы: ${totalAmount} ₸\n\nТөлем жасау:\n${paymentInfo}\n\nТөлем жасағаннан кейін чекті осы чатқа жіберіңіз.`;
}
function buildRejectedMessage(body, lang) {
    const reason = cleanInline(body.reason || (lang === "ru" ? "Неизвестная причина" : "Белгісіз себеп"), 200);
    return lang === "ru"
        ? `К сожалению, мы не сможем приготовить заказ.\nПричина: ${reason}.\nПожалуйста, выберите другое блюдо.`
        : `Өкінішке қарай, тапсырысты дайындай алмаймыз.\nСебебі: ${reason}.\nБасқа тағам таңдауыңызды сұраймыз.`;
}
function extractShiftNotePayload(body) {
    const noteId = cleanInline(body.note_id || body.noteId || body.id, 80);
    const text = textValue(body.text || body.note_text || body.note || body.message);
    const expiresAt = cleanInline(body.expires_at || body.expiresAt || body.expires || body.until, 80);
    const shiftKey = cleanInline(body.shift_key || body.shiftKey, 80);
    const stableLockId = noteId && noteId !== "0"
        ? noteId
        : `fallback_${crypto.createHash("sha1").update(`${body.action || ""}|${shiftKey}|${text}|${expiresAt}`).digest("hex").slice(0, 16)}`;
    return { noteId, text, expiresAt, shiftKey, stableLockId };
}
function getDeveloperPhone(config) {
    return normalizePhone(config.dev_phone || "");
}
function getAdminPhone(config) {
    return normalizePhone(config.admin_phone || "");
}
async function notifyDeveloper(instance, error, meta) {
    await notifyDeveloperSystemFailure(instance, error, { scope: "kanban-webhook", ...meta }).catch(() => undefined);
}
async function notifyComplaint(body, config, instance) {
    const adminPhone = getAdminPhone(config);
    if (!adminPhone)
        return false;
    const phone = normalizePhone(body.phone || body.customer_phone || "");
    const orderId = cleanInline(body.order_id || body.orderId || "Табылмады", 40);
    const restaurant = cleanInline(config.name || config.restaurant_name || instance, 120);
    const summary = cleanInline(body.admin_summary || body.summary || body.reason || body.text || body.message, 600);
    const message = [
        "ЖАҢА ШАҒЫМ",
        `Ресторан: ${restaurant}`,
        phone ? `Клиент: +${phone}` : "",
        `Тапсырыс №: ${orderId}`,
        "",
        `AI анализі: ${summary || "Клиент шағым қалдырды."}`,
    ].filter(Boolean).join("\n");
    await sendWhatsProMessage({ instanceId: instance, phone: adminPhone, text: message });
    return true;
}
async function emitPrintOnPaid(req, body, status) {
    if (status !== "paid")
        return;
    const io = req.app.get("io");
    if (io && typeof io.emit === "function") {
        io.emit("print_new_order", body);
    }
}
async function emitPrintOnNewOrder(req, body, action) {
    if (action !== "new_order")
        return;
    const io = req.app.get("io");
    if (io && typeof io.emit === "function") {
        io.emit("print_new_order", body);
    }
}
async function sendAndRemember(instance, phone, text) {
    await sendWhatsProMessage({ instanceId: instance, phone, text });
    await saveToHistory(instance, phone, "model", `<bot_notification>\n${text}\n</bot_notification>`);
}
export async function handleKanbanWebhook(req, res) {
    const body = (req.body || {});
    const instance = cleanInline(body.instance || body.instanceId || body.restaurant_id, 80);
    const action = cleanInline(body.action, 80);
    let lockKey = "";
    let lockAcquired = false;
    try {
        if (!INSTANCE_RE.test(instance)) {
            res.status(400).json({ ok: false, error: "BAD_INSTANCE" });
            return;
        }
        if (!VALID_ACTIONS.has(action)) {
            res.status(400).json({ ok: false, error: "BAD_ACTION" });
            return;
        }
        if (action === "update_kitchen_status") {
            const status = await saveKitchenStatus(instance, body);
            res.status(200).json({ success: true, status });
            return;
        }
        if (action === "get_kitchen_status") {
            const status = await getKitchenStatus(instance);
            res.status(200).json({ success: true, status });
            return;
        }
        const config = (await getRestaurantConfig(instance)) || {};
        if (action === "developer_alert") {
            const message = cleanInline(body.error || body.message || body.reason || "developer_alert", 600);
            await notifyDeveloper(instance, new Error(message), { source: "developer_alert", orderId: body.order_id });
            res.status(200).json({ success: true, message: "Developer notified" });
            return;
        }
        if (action === "complaint") {
            const sent = await notifyComplaint(body, config, instance);
            res.status(200).json({ success: true, admin_notified: sent });
            return;
        }
        const isShiftNoteAction = action.startsWith("shift_note_");
        const phone = normalizePhone(body.phone || "");
        const orderId = cleanInline(body.order_id || "0", 40);
        const newStatus = cleanInline(body.status || body.new_status || body.order_status, 80);
        const isPickup = boolValue(body.is_pickup, false);
        if (!isShiftNoteAction) {
            if (!ORDER_ID_RE.test(orderId) || orderId === "0") {
                res.status(400).json({ ok: false, error: "BAD_ORDER_ID" });
                return;
            }
            if (!phone) {
                res.status(400).json({ ok: false, error: "BAD_PHONE" });
                return;
            }
        }
        await connectRedis();
        const shiftNotePayload = isShiftNoteAction ? extractShiftNotePayload(body) : null;
        const lockId = shiftNotePayload?.stableLockId || orderId;
        const lockScope = action === "status_changed" ? `${action}:${newStatus || "unknown"}` : action;
        lockKey = `kanban_lock:${instance}:${lockId}:${lockScope}`;
        const locked = await redisClient.set(lockKey, "1", { NX: true, EX: isShiftNoteAction ? 5 : 86400 });
        if (!locked) {
            res.status(200).json({ success: true, message: "Ignored duplicate signal" });
            return;
        }
        lockAcquired = true;
        if (action === "shift_note_created" && shiftNotePayload) {
            const saved = await saveShiftNote(instance, shiftNotePayload.noteId, shiftNotePayload.text, shiftNotePayload.expiresAt);
            if (!saved)
                throw new Error("SHIFT_NOTE_SAVE_FAILED");
            res.status(200).json({ success: true, message: "Note saved to AI memory" });
            return;
        }
        if (action === "shift_note_deleted" && shiftNotePayload) {
            await deleteShiftNote(instance, shiftNotePayload.noteId, shiftNotePayload.text);
            res.status(200).json({ success: true, message: "Note removed from AI memory" });
            return;
        }
        await emitPrintOnNewOrder(req, body, action);
        await emitPrintOnPaid(req, body, newStatus);
        const lang = getLanguage(body);
        let textMessage = "";
        if (action === "new_order")
            textMessage = buildNewOrderMessage(body, lang, orderId, isPickup);
        if (action === "request_payment")
            textMessage = await buildPaymentMessage(body, config, lang, instance);
        if (action === "order_rejected")
            textMessage = buildRejectedMessage(body, lang);
        if (action === "status_changed") {
            const effectiveStatus = newStatus === "completed" && isPickup ? "pickup_ready" : newStatus;
            textMessage = statusTemplates[lang][effectiveStatus] || "";
            if (!textMessage) {
                res.status(200).json({ success: true, message: "Ignored status not intended for client" });
                return;
            }
        }
        if (textMessage) {
            await sendAndRemember(instance, phone, textMessage);
            if (newStatus === "completed" || newStatus === "cancelled" || action === "order_rejected") {
                await redisClient.del([`history:${instance}:${phone}`, `last_order:${instance}:${phone}`]).catch(() => undefined);
            }
        }
        res.status(200).json({ success: true, message: "Processed" });
    }
    catch (error) {
        if (lockAcquired && lockKey) {
            await redisClient.del(lockKey).catch(() => undefined);
        }
        await notifyDeveloper(instance, error, {
            orderId: body.order_id,
            action,
        });
        if (!res.headersSent) {
            res.status(500).json({
                success: false,
                error: error instanceof Error ? error.message : String(error || "kanban webhook failed"),
            });
        }
    }
}
