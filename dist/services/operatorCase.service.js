import crypto from "node:crypto";
import { connectRedis, redisClient } from "./redis.service.js";
export const CASE_TTL_SECONDS = 7 * 24 * 60 * 60;
export const SOS_TTL_SECONDS = 60 * 60;
function clean(value, max = 900) {
    return String(value || "").replace(/[\r\n\t]+/g, " ").replace(/\s+/g, " ").trim().slice(0, max);
}
function phone(value) { return String(value || "").replace(/\D/g, ""); }
function caseKey(instanceId, caseId) { return `operator_case:${instanceId}:${caseId}`; }
function activeKey(instanceId, customerPhone) { return `operator_case_active:${instanceId}:${customerPhone}`; }
export function sosIndexKey(instanceId) { return `chatwoot:sos:${instanceId}`; }
export function sosMarkerKey(instanceId, customerPhone) { return `chatwoot:sos:${instanceId}:${customerPhone}`; }
export function sosUnreadKey(instanceId, customerPhone) { return `chatwoot:sos-unread:${instanceId}:${customerPhone}`; }
export function detectOperatorCaseKind(text = "") {
    const value = clean(text).toLowerCase();
    if (/(курьер.*(номер|нөмір|номерін|телефон)|номер.*курьер|курьерге хабарлас)/iu.test(value))
        return "courier_request";
    if (/(оператор|админ|администратор|менеджер|адаммен|человек|живой человек|шақыр|шакыр|позовите|соедините)/iu.test(value))
        return "human_request";
    if (/(шағым|жалоб|претензи|волос|шаш|гряз|лас|испорч|бұзыл|бузыл|улан|отрав|не тот заказ|қате тапсырыс|сапа|качест)/iu.test(value))
        return "complaint";
    return null;
}
async function activateSos(input) {
    const now = Date.now();
    const expiresAt = now + SOS_TTL_SECONDS * 1000;
    const marker = {
        caseId: input.caseId,
        signalId: input.signalId,
        kind: input.kind,
        summary: clean(input.summary, 500),
        urgency: clean(input.urgency || "normal", 20),
        source: clean(input.source || "openbot", 80),
        startedAt: now,
        expiresAt,
    };
    await redisClient.multi()
        .set(sosMarkerKey(input.instanceId, input.phone), JSON.stringify(marker), { EX: SOS_TTL_SECONDS })
        .set(sosUnreadKey(input.instanceId, input.phone), input.signalId, { EX: SOS_TTL_SECONDS })
        .zAdd(sosIndexKey(input.instanceId), [{ score: expiresAt, value: input.phone }])
        .expire(sosIndexKey(input.instanceId), CASE_TTL_SECONDS)
        .zAdd(`chatwoot:inbox:${input.instanceId}`, [{ score: now, value: input.phone }])
        .exec();
    await redisClient.publish(`chatwoot:events:${input.instanceId}`, JSON.stringify({
        type: "sos.created",
        instanceId: input.instanceId,
        phone: input.phone,
        caseId: input.caseId,
        signalId: input.signalId,
        expiresAt,
        emittedAt: now,
        origin: "openbot",
    })).catch(() => 0);
    return marker;
}
export async function createOperatorCase(input) {
    const instanceId = clean(input.instanceId, 64);
    const customerPhone = phone(input.phone);
    if (!instanceId || !customerPhone)
        return null;
    await connectRedis();
    const signalId = clean(input.signalId || `sos_${Date.now()}_${crypto.randomBytes(4).toString("hex")}`, 96);
    const existingId = await redisClient.get(activeKey(instanceId, customerPhone));
    if (existingId) {
        const existing = await redisClient.get(caseKey(instanceId, existingId));
        if (existing) {
            const data = JSON.parse(existing);
            const sos = await activateSos({ instanceId, phone: customerPhone, caseId: existingId, signalId, kind: input.kind, summary: input.summary, urgency: input.urgency, source: input.source });
            return { ...data, sos };
        }
    }
    const now = Date.now();
    const caseId = `oc_${now}_${crypto.randomBytes(4).toString("hex")}`;
    const data = {
        id: caseId, instanceId, phone: customerPhone, kind: input.kind, status: "open", unread: true, highlight: "red",
        urgency: clean(input.urgency || "normal", 20), summary: clean(input.summary), source: clean(input.source || "openbot", 80),
        orderNumber: clean(input.orderNumber || "", 40), hasMedia: Boolean(input.hasMedia), createdAt: now, updatedAt: now,
    };
    await redisClient.multi()
        .set(caseKey(instanceId, caseId), JSON.stringify(data), { EX: CASE_TTL_SECONDS })
        .set(activeKey(instanceId, customerPhone), caseId, { EX: CASE_TTL_SECONDS })
        .zAdd(`operator_cases:${instanceId}`, [{ score: now, value: caseId }])
        .expire(`operator_cases:${instanceId}`, CASE_TTL_SECONDS)
        .exec();
    const sos = await activateSos({ instanceId, phone: customerPhone, caseId, signalId, kind: input.kind, summary: input.summary, urgency: input.urgency, source: input.source });
    return { ...data, sos };
}
export async function bumpOperatorCaseSignal(instanceId, rawPhone) {
    const customerPhone = phone(rawPhone);
    if (!instanceId || !customerPhone)
        return false;
    await connectRedis();
    const caseId = await redisClient.get(activeKey(instanceId, customerPhone));
    if (!caseId)
        return false;
    const raw = await redisClient.get(caseKey(instanceId, caseId));
    if (!raw)
        return false;
    const data = JSON.parse(raw);
    const now = Date.now();
    const marker = JSON.stringify({
        role: "user", direction: "incoming", fromMe: false, source: "openbot_operator_case", operatorCaseId: caseId,
        caseKind: data.kind, highlight: "red", text: `🚨 Оператор қажет: ${clean(data.summary, 180)}`, createdAt: now,
    });
    await redisClient.multi()
        .rPush(`history:${instanceId}:${customerPhone}`, marker)
        .lTrim(`history:${instanceId}:${customerPhone}`, -120, -1)
        .expire(`history:${instanceId}:${customerPhone}`, 24 * 60 * 60)
        .zAdd(`chatwoot:inbox:${instanceId}`, [{ score: now, value: customerPhone }])
        .exec();
    return true;
}
