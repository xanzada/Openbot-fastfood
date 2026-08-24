import crypto from "node:crypto";
import { CHAT_HISTORY_TTL_SECONDS, connectRedis, redisClient } from "./redis.service.js";
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
  // "адаммен" only covers the comitative case. A guest in a hurry writes "маған адам
  // керек", "жанды адам керек", "адам жоқ па" - none of which matched, so the case was
  // never opened while the model, told an operator would be notified, answered "адамға
  // хабар беремін" to somebody nobody had been told about (found 2026-08-24). The noun is
  // matched with its ordinary Kazakh case endings instead, next to a request word.
  if (/(оператор|админ|администратор|менеджер|человек|позовите|соедините|шақыр|шакыр)/iu.test(value)) return "human_request";
  // ...but "адам" is also how portions are counted ("екі адамға сет бар ма?"), so a
  // quantity in front of it means the guest is talking about people eating, not about
  // wanting to speak to one.
  const PERSON_QUANTITY_RE = /(?:\d+|бір|бир|екі|еки|үш|уш|төрт|торт|бес|неше|қанша|канша|көп|коп)\s+адам/iu;
  if (!PERSON_QUANTITY_RE.test(value)
    && /(?:^|[^\p{L}])(?:тірі\s+|тiрi\s+|жанды\s+|нақты\s+)?адам(?:мен|ға|га|ды|ы)?(?![\p{L}])[^.!?]{0,24}(?:керек|қажет|кажет|шақыр|шакыр|берші|беріңіз|сөйлес|сойлес|байланыс|жоқ\s*па|жок\s*па|бар\s*ма)/iu.test(value)) {
    return "human_request";
  }
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
    // The SOS index is scored by expiry, so anything scored in the past is a
    // marker that died an hour ago. Nothing pruned them, so the index only ever
    // grew and could report a guest as flagged whose marker and unread key had
    // both expired (found 2026-08-22).
    .zRemRangeByScore(sosIndexKey(input.instanceId), 0, now)
    .zAdd(`chatwoot:inbox:${input.instanceId}`, [{ score: now, value: input.phone }])
    .expire(`chatwoot:inbox:${input.instanceId}`, CASE_TTL_SECONDS)
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

// The clarify-first gate needs to know whether the guest is already
// mid-escalation: with an open case a bare "оператор!" is insistence, not a new
// bare demand, so it must update the case instead of earning another question.
export async function getActiveOperatorCaseId(instanceId: string, customerPhone: string): Promise<string | null> {
  const id = clean(instanceId, 64);
  const guestPhone = phone(customerPhone);
  if (!id || !guestPhone) return null;
  try {
    await connectRedis();
    return await redisClient.get(activeKey(id, guestPhone));
  } catch {
    return null;
  }
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
      // Deliberately not awaited: this is log-and-continue by contract, and the
      // hub call carries a 10s timeout that the rotated-secret retry can double.
      // Awaiting it put up to ~20s of silence between the guest's complaint and
      // their acknowledgement, on the reply path (found 2026-08-22).
      void notifyHubSos({ instanceId, phone: customerPhone, caseId: existingId, signalId, kind: input.kind, summary: data.summary, orderNumber: data.orderNumber }).catch(() => undefined);
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
  // Same reason as the reuse branch above: the guest must not wait for the hub.
  void notifyHubSos({ instanceId, phone: customerPhone, caseId, signalId, kind: input.kind, summary: data.summary, orderNumber: data.orderNumber }).catch(() => undefined);
  return { ...data, sos };
}

// The site gets the same signal the panel got: one SOS = one notification, in
// order (operator request, 2026-08-20). Hub dedupes on signal_id. A hub failure
// must never touch the guest flow or the panel, so this is log-and-continue.
async function notifyHubSos(args: {
  instanceId: string; phone: string; caseId: string; signalId: string;
  kind: OperatorCaseKind; summary: string; orderNumber?: string;
}) {
  // One operator case = one site notification. The 90-second window let a
  // single open case re-notify the site on every bump, so the operator badge
  // showed 4 for what was one guest issue (2026-08-21). The hub dedupes on
  // signal_id; we now dedupe on the case for its whole life. A genuinely new
  // episode becomes a new case (the stale sweep frees the phone), which sends
  // a fresh notification. The claim is released when the send fails, so the
  // next signal of this case retries instead of the case staying silent.
  const dedupeKey = `sos_hub_sent:${args.instanceId}:${args.caseId}`;
  // A Redis ERROR and "already claimed" both used to come back as null, so a
  // transient blip on the claim silently suppressed the site notification for the
  // rest of the case's 7-day life - the operator saw the red row and the site
  // never heard about it. They are distinguished now: only a real "somebody else
  // holds this claim" stops the send. The hub dedupes on signal_id, so sending
  // when the claim state is unknown is the safe direction (found 2026-08-22).
  const claimed = await redisClient
    .set(dedupeKey, args.signalId, { EX: CASE_TTL_SECONDS, NX: true })
    .catch(() => "CLAIM_UNAVAILABLE" as const);
  if (claimed === null) return;
  const claimHeld = claimed === "OK";
  try {
    await reportOperatorSos({
      instanceId: args.instanceId,
      caseId: args.caseId,
      signalId: args.signalId,
      phone: args.phone,
      kind: args.kind,
      summary: args.summary,
      orderNumber: args.orderNumber,
    });
  } catch (error: any) {
    // Release only a claim we actually took; deleting one we never held would let
    // the next signal of this case notify the site a second time.
    if (claimHeld) await redisClient.del(dedupeKey).catch(() => undefined);
    // The hub answers 400 INTEGRATION_COMMAND_INVALID for a payload problem and
    // 401 INTEGRATION_SIGNATURE_INVALID for a credential one. axios throws before
    // assertAlemiResponse runs, so error.code was unset and every failure logged
    // as the bare axios message - a 400 was indistinguishable from a dropped
    // connection. That is how the order_number:"not_found" payload regression
    // survived 48 hours unnoticed (2026-08-21). Log the status and the hub's own
    // code so the next payload regression is visible in one grep.
    const status = Number(error?.statusCode ?? error?.response?.status ?? 0) || "-";
    const hubCode = error?.response?.data?.error?.code
      ?? error?.response?.data?.code
      ?? error?.code
      ?? "-";
    console.warn(`[SOS:HUB] ${args.instanceId}/${args.phone} ${args.signalId} case=${args.caseId}: status=${status} hubCode=${hubCode} ${error?.message || error}`);
  }
}

// A case already sitting on the operator board must not raise a second red flag
// just because the chat scrolled past the first one, and a case nobody has
// touched for half a day must not keep flagging a guest who has long moved on
// to ordinary questions.
export const CASE_FLAG_QUIET_MS = 12 * 60 * 60 * 1000;

export type CaseFlagDecision = "flag" | "already_flagged" | "stale";

export function decideCaseFlag(data: { markerPushedAt?: number; updatedAt?: number; createdAt?: number }, now = Date.now()): CaseFlagDecision {
  // Staleness is checked FIRST, and that order is the whole fix. With the flag test in
  // front, a case that had been flagged could never be reported stale, so only an
  // unflagged case was ever swept - and the sweep is the only thing that releases the
  // guest's phone. A flagged case therefore held it for the full 7-day CASE_TTL_SECONDS,
  // re-extended on every reuse (found 2026-08-23; measured: a 6-day-old flagged case
  // still answered "already_flagged").
  //
  // That is not a cosmetic leak. createOperatorCase reuses the held case for a genuinely
  // new complaint days later, and notifyHubSos dedupes on sos_hub_sent:{instance}:{caseId}
  // for the case's whole life - so the second complaint reached the operator's board and
  // never reached the site at all. The comment above notifyHubSos already assumed this
  // behaviour ("a genuinely new episode becomes a new case, the stale sweep frees the
  // phone"); it just was not true yet.
  //
  // A case nobody has touched for CASE_FLAG_QUIET_MS is over whether or not we drew a
  // red row for it. Fresh cases are unaffected, which keeps "one SOS = one notification"
  // intact for the episode that is actually live.
  const lastTouch = Number(data?.updatedAt || data?.createdAt || 0);
  if (lastTouch && now - lastTouch > CASE_FLAG_QUIET_MS) return "stale";
  if (data?.markerPushedAt) return "already_flagged";
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
    await redisClient.multi()
      .zAdd(`chatwoot:inbox:${instanceId}`, [{ score: now, value: customerPhone }])
      .expire(`chatwoot:inbox:${instanceId}`, CASE_TTL_SECONDS)
      .exec();
    return true;
  }
  if (decision === "stale") {
    // Releasing the phone is what lets the guest's next complaint open a NEW case, which
    // is what makes the site hear about it: notifyHubSos dedupes per case id.
    // The finished case's hub claim goes with it - keeping a 7-day key for a case nobody
    // will signal again only delays the cleanup.
    await redisClient
      .multi()
      .del(activeKey(instanceId, customerPhone))
      .del(`sos_hub_sent:${instanceId}:${caseId}`)
      .exec()
      .catch(() => null);
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
      .expire(`chatwoot:inbox:${instanceId}`, CASE_TTL_SECONDS)
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
    // 24h here permanently SHORTENED the 7-day chat history, and saveToHistory
    // only restores the TTL when it finds none at all - so exactly the guests who
    // escalated, the ones support most needs to read back, lost their
    // conversation six days early (found 2026-08-22).
    .expire(`history:${instanceId}:${customerPhone}`, CHAT_HISTORY_TTL_SECONDS)
    .set(caseKey(instanceId, caseId), JSON.stringify(flagged), { EX: CASE_TTL_SECONDS })
    .zAdd(`chatwoot:inbox:${instanceId}`, [{ score: now, value: customerPhone }])
    .expire(`chatwoot:inbox:${instanceId}`, CASE_TTL_SECONDS)
    .exec();
  return true;
}
