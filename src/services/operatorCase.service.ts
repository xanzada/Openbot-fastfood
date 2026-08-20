import crypto from "node:crypto";
import { connectRedis, redisClient } from "./redis.service.js";
import { isLikelyMenuQuestion } from "../utils/intentText.js";
import { reportOperatorSos } from "./alemiApi.service.js";

export type OperatorCaseKind = "complaint" | "human_request" | "courier_request" | "cancel_request" | "long_voice" | "unresolved" | "critical";
export const CASE_TTL_SECONDS = 7 * 24 * 60 * 60;
export const SOS_TTL_SECONDS = 60 * 60;

function clean(value: unknown, max = 900) {
  return String(value || "").replace(/[\r\n\t]+/g, " ").replace(/\s+/g, " ").trim().slice(0, max);
}
function phone(value: unknown) { return String(value || "").replace(/\D/g, ""); }
function caseKey(instanceId: string, caseId: string) { return `operator_case:${instanceId}:${caseId}`; }
function activeKey(instanceId: string, customerPhone: string) { return `operator_case_active:${instanceId}:${customerPhone}`; }
export function sosIndexKey(instanceId: string) { return `chatwoot:sos:${instanceId}`; }
export function sosMarkerKey(instanceId: string, customerPhone: string) { return `chatwoot:sos:${instanceId}:${customerPhone}`; }
export function sosUnreadKey(instanceId: string, customerPhone: string) { return `chatwoot:sos-unread:${instanceId}:${customerPhone}`; }

// "Я передумал, отмените мой заказ" was answered "Активный заказ по этому номеру
// не найден. Отправьте номер заказа" - an ask that leads nowhere, because the bot
// may never change order state at all. Cancelling is an operator action, so the
// request is an operator case in its own right (live round, 2026-08-12).
const CANCEL_ORDER_RE =
  /((?:отмен\p{L}*|отказ\p{L}*|откаж\p{L}*|cancel)\s*(?:от\s*)?(?:мо[йея]\s*|наш\p{L}*\s*)?(?:заказ\p{L}*|order|тапсырыс\p{L}*)|(?:заказ\p{L}*|order|тапсырыс\p{L}*)\s*(?:отмен\p{L}*|болдырма\p{L}*|болдырыл\p{L}*|жой\p{L}*|бас\s*тарт\p{L}*|cancel)|(?:заказ\p{L}*|тапсырыс\p{L}*)\p{L}*\s*(?:бас\s*тарт|жойып|жоя)|бас\s*тарт(?:қым|амын|айын|сам|уды)\p{L}*)/iu;

export function isOrderCancellationRequest(text = ""): boolean {
  return CANCEL_ORDER_RE.test(clean(text).toLowerCase());
}

export function detectOperatorCaseKind(text = ""): OperatorCaseKind | null {
  const value = clean(text).toLowerCase();
  if (CANCEL_ORDER_RE.test(value)) return "cancel_request";
  if (/(курьер.*(номер|нөмір|номерін|телефон)|номер.*курьер|курьерге хабарлас)/iu.test(value)) return "courier_request";
  if (/(оператор|админ|администратор|менеджер|адаммен|человек|живой человек|шақыр|шакыр|позовите|соедините)/iu.test(value)) return "human_request";
  // A dish or menu question is never a complaint: "шашлык бар ма?" and
  // "суық суы бар ма?" are catalog talk. The case kind stays null so no SOS
  // can grow out of an off-menu ask (2026-08-20).
  if (/(шағым|жалоб|претензи|волос|шаш(?!л)|гряз|лас(?!с)|испорч|бұзыл|бузыл|улан|отрав|не тот заказ|қате тапсырыс|сапа|качест)/iu.test(value) && !isLikelyMenuQuestion(value)) return "complaint";
  return null;
}

async function activateSos(input: {
  instanceId: string; phone: string; caseId: string; signalId: string; kind: OperatorCaseKind; summary: string; urgency?: string; source?: string;
}) {
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

export async function createOperatorCase(input: {
  instanceId: string; phone: string; kind: OperatorCaseKind; summary: string; source?: string; urgency?: string; orderNumber?: string; hasMedia?: boolean; signalId?: string;
}) {
  const instanceId = clean(input.instanceId, 64);
  const customerPhone = phone(input.phone);
  if (!instanceId || !customerPhone) return null;
  await connectRedis();
  const signalId = clean(input.signalId || `sos_${Date.now()}_${crypto.randomBytes(4).toString("hex")}`, 96);
  const existingId = await redisClient.get(activeKey(instanceId, customerPhone));
  if (existingId) {
    const existing = await redisClient.get(caseKey(instanceId, existingId));
    if (existing) {
      // An open case is reused so the operator keeps one thread per guest, but it
      // must describe what the guest is saying NOW. Leaving the first summary in
      // place showed "asked for an operator" and an old order number while the
      // guest was actually complaining about a cold delivery.
      const previous = JSON.parse(existing);
      const now = Date.now();
      const data = {
        ...previous,
        kind: input.kind,
        status: "open",
        unread: true,
        highlight: "red",
        urgency: clean(input.urgency || previous.urgency || "normal", 20),
        summary: clean(input.summary) || previous.summary,
        source: clean(input.source || previous.source || "openbot", 80),
        orderNumber: clean(input.orderNumber || "", 40) || previous.orderNumber || "",
        hasMedia: Boolean(input.hasMedia) || Boolean(previous.hasMedia),
        updatedAt: now,
      };
      await redisClient.multi()
        .set(caseKey(instanceId, existingId), JSON.stringify(data), { EX: CASE_TTL_SECONDS })
        .expire(activeKey(instanceId, customerPhone), CASE_TTL_SECONDS)
        .zAdd(`operator_cases:${instanceId}`, [{ score: now, value: existingId }])
        .exec();
      const sos = await activateSos({ instanceId, phone: customerPhone, caseId: existingId, signalId, kind: input.kind, summary: input.summary, urgency: input.urgency, source: input.source });
      await notifyHubSos({ instanceId, phone: customerPhone, caseId: existingId, signalId, kind: input.kind, summary: data.summary, orderNumber: data.orderNumber });
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
  await notifyHubSos({ instanceId, phone: customerPhone, caseId, signalId, kind: input.kind, summary: data.summary, orderNumber: data.orderNumber });
  return { ...data, sos };
}

// The site gets the same signal the panel got: one SOS = one notification, in
// order (operator request, 2026-08-20). Hub dedupes on signal_id. A hub failure
// must never touch the guest flow or the panel, so this is log-and-continue.
async function notifyHubSos(args: {
  instanceId: string; phone: string; caseId: string; signalId: string;
  kind: OperatorCaseKind; summary: string; orderNumber?: string;
}) {
  // One escalation episode = one site signal. The AI tool path and the webhook
  // gate can both raise the same SOS a second apart (each re-activates the
  // panel marker); the site must see it exactly once. A fresh episode after
  // the window still sends again, so "4 SOS = 4 signals" holds.
  const dedupeKey = `sos_hub_sent:${args.instanceId}:${args.phone}`;
  const claimed = await redisClient.set(dedupeKey, args.signalId, { EX: 90, NX: true }).catch(() => null);
  if (claimed !== "OK") return;
  await reportOperatorSos({
    instanceId: args.instanceId,
    caseId: args.caseId,
    signalId: args.signalId,
    phone: args.phone,
    kind: args.kind,
    summary: args.summary,
    orderNumber: args.orderNumber,
  }).catch((error) => console.warn(`[SOS:HUB] ${args.instanceId}/${args.phone} ${args.signalId}: ${error?.message || error}`));
}

// A case already sitting on the operator board must not raise a second red flag
// just because the chat scrolled past the first one, and a case nobody has
// touched for half a day must not keep flagging a guest who has long moved on
// to ordinary questions.
export const CASE_FLAG_QUIET_MS = 12 * 60 * 60 * 1000;

export type CaseFlagDecision = "flag" | "already_flagged" | "stale";

export function decideCaseFlag(data: { markerPushedAt?: number; updatedAt?: number; createdAt?: number }, now = Date.now()): CaseFlagDecision {
  if (data?.markerPushedAt) return "already_flagged";
  const lastTouch = Number(data?.updatedAt || data?.createdAt || 0);
  if (lastTouch && now - lastTouch > CASE_FLAG_QUIET_MS) return "stale";
  return "flag";
}

export async function bumpOperatorCaseSignal(instanceId: string, rawPhone: string) {
  const customerPhone = phone(rawPhone);
  if (!instanceId || !customerPhone) return false;
  await connectRedis();
  const caseId = await redisClient.get(activeKey(instanceId, customerPhone));
  if (!caseId) return false;
  const raw = await redisClient.get(caseKey(instanceId, caseId));
  if (!raw) return false;
  const data = JSON.parse(raw);
  const now = Date.now();
  // The case record remembers its own flag, so trimming the history can never
  // resurrect it.
  const decision = decideCaseFlag(data, now);
  if (decision === "already_flagged") {
    await redisClient.zAdd(`chatwoot:inbox:${instanceId}`, [{ score: now, value: customerPhone }]);
    return true;
  }
  if (decision === "stale") {
    await redisClient.del(activeKey(instanceId, customerPhone));
    return false;
  }
  const recent = await redisClient.lRange(`history:${instanceId}:${customerPhone}`, -40, -1);
  const alreadyFlagged = recent.some((entry: string) => {
    try {
      const parsed = JSON.parse(entry);
      return parsed?.source === "openbot_operator_case" && parsed?.operatorCaseId === caseId;
    } catch {
      return false;
    }
  });
  const flagged = { ...data, markerPushedAt: now };
  if (alreadyFlagged) {
    await redisClient.multi()
      .set(caseKey(instanceId, caseId), JSON.stringify(flagged), { EX: CASE_TTL_SECONDS })
      .zAdd(`chatwoot:inbox:${instanceId}`, [{ score: now, value: customerPhone }])
      .exec();
    return true;
  }
  const marker = JSON.stringify({
    role: "user", direction: "incoming", fromMe: false, source: "openbot_operator_case", operatorCaseId: caseId,
    caseKind: data.kind, highlight: "red", text: `\u{1F6A8} Оператор қажет: ${clean(data.summary, 180)}`, createdAt: now,
  });
  await redisClient.multi()
    .rPush(`history:${instanceId}:${customerPhone}`, marker)
    .lTrim(`history:${instanceId}:${customerPhone}`, -120, -1)
    .expire(`history:${instanceId}:${customerPhone}`, 24 * 60 * 60)
    .set(caseKey(instanceId, caseId), JSON.stringify(flagged), { EX: CASE_TTL_SECONDS })
    .zAdd(`chatwoot:inbox:${instanceId}`, [{ score: now, value: customerPhone }])
    .exec();
  return true;
}
