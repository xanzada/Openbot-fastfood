import crypto from "node:crypto";
import type {NotificationRecord} from "./durableNotification.service.js";
import { CHAT_HISTORY_TTL_SECONDS, connectRedis, redisClient } from "./redis.service.js";
import { isLikelyMenuQuestion } from "../utils/intentText.js";
import { queueOperatorCaseNotifications, drainOperatorNotifications } from "./operatorNotification.service.js";

export type OperatorCaseKind = "complaint" | "human_request" | "courier_request" | "cancel_request" | "long_voice" | "unresolved" | "critical";
export const CASE_TTL_SECONDS = 7 * 24 * 60 * 60;
// An SOS must outlive the shift it was raised in. One hour meant a complaint that
// arrived at night was silently gone from the operator's SOS column by morning: the
// case itself lives CASE_TTL_SECONDS (7 days) and the red row stayed, but the SOS
// marker, the unread key and the index entry had all expired, so the panel tab read
// zero and the site's green button never had a count to show (owner report,
// 2026-08-27). 24h matches how a restaurant actually works - a shift hands over and
// the next operator still sees what happened - and stays well inside the case's own
// life so the two can never disagree about a live episode.
export const SOS_TTL_SECONDS = 24 * 60 * 60;

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
  /((?:отмен\p{L}*|отказ\p{L}*|откаж\p{L}*|cancel)\s*(?:от\s*)?(?:мо[йея]\s*|наш\p{L}*\s*|(?:перв|втор|трет)\p{L}*\s*|\d+\s*)?(?:заказ\p{L}*|order|тапсырыс\p{L}*)|(?:заказ\p{L}*|order|тапсырыс\p{L}*)\s*(?:отмен\p{L}*|болдырма\p{L}*|болдырыл\p{L}*|жой\p{L}*|бас\s*тарт\p{L}*|cancel)|(?:заказ\p{L}*|тапсырыс\p{L}*)\p{L}*\s*(?:бас\s*тарт|жойып|жоя)|бас\s*тарт(?:қым|амын|айын|сам|уды)\p{L}*)/iu;

function hasNonNegatedCancellation(text: string): boolean {
  const clauses = clean(text).toLowerCase().split(/[.!?;,]|\s+(?:но|однако|бірақ)\s+/iu);
  for (const clause of clauses) {
    for (const match of clause.matchAll(new RegExp(CANCEL_ORDER_RE.source, "giu"))) {
      const before = clause.slice(0, match.index).trimEnd();
      const after = clause.slice(match.index! + match[0].length);
      // Negation belongs to this cancellation verb, not the whole turn.
      const refusalBefore = /(?:^|[^\p{L}])(?:не\s+(?:(?:надо|нужно|хочу|хотел\p{L}*|буду)\s+)?|нельзя\s+|do\s+not\s+|don['’]t\s+)$/iu.test(before + " ");
      const refusalAfter = /^\s*(?:не\s+(?:надо|нужно|требуется|нуж\p{L}*|хочу|хочется|буду)|(?:керек|қажет)\s+емес|қажеті\s+жоқ|келмейді|келмеймін|қаламай\p{L}*|жоқ)(?:$|[^\p{L}])/iu.test(after);
      const negativeKkVerb = /жойма\p{L}*|бас\s+тарт(?:па|пе|пай|пей)\p{L}*/iu.test(match[0] + after.slice(0, 12));
      if (!refusalBefore && !refusalAfter && !negativeKkVerb) return true;
    }
  }
  return false;
}

export function isOrderCancellationRequest(text = ""): boolean {
  return hasNonNegatedCancellation(text);
}

export function detectOperatorCaseKind(text = ""): OperatorCaseKind | null {
  const value = clean(text).toLowerCase();
  if (hasNonNegatedCancellation(value)) return "cancel_request";
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

export function isTechnicalRecoveryCase(value: Record<string, any> | null | undefined): boolean {
  return String(value?.source || "") === "ai_unavailable" && String(value?.kind || "") === "unresolved";
}

export function shouldPreserveExistingCase(
  existing: Record<string, any> | null | undefined,
  incoming: { source?: string; kind?: string },
): boolean {
  return Boolean(existing)
    && !isTechnicalRecoveryCase(existing)
    && isTechnicalRecoveryCase(incoming as Record<string, any>);
}

export function canAutoResolveTechnicalSos(
  marker: Record<string, any> | null | undefined,
  operatorCase: Record<string, any> | null | undefined,
): boolean {
  return isTechnicalRecoveryCase(marker) && isTechnicalRecoveryCase(operatorCase);
}

// Every lifecycle writer uses the same key layout. Lua runtime errors do not
// undo prior writes: check all key types before the first mutation.
const LIFECYCLE_TYPES = `
local types = {'string','string','string','string','string','zset','zset','zset','list'}
for i, expected in ipairs(types) do
  local actual = redis.call('TYPE', KEYS[i]).ok
  if actual ~= 'none' and actual ~= expected then
    return redis.error_reply('OPERATOR_LIFECYCLE_WRONGTYPE')
  end
end
`;
const LIFECYCLE_FENCE = `
if (redis.call('GET', KEYS[1]) or '') ~= ARGV[1] then return 0 end
if (redis.call('GET', KEYS[2]) or '') ~= ARGV[2] then return 0 end
if (redis.call('GET', KEYS[4]) or '') ~= ARGV[3] then return 0 end
`;
function lifecycleKeys(instanceId: string, customerPhone: string, oldCaseId: string, caseId = oldCaseId) {
  return [
    activeKey(instanceId, customerPhone), caseKey(instanceId, oldCaseId), caseKey(instanceId, caseId),
    sosMarkerKey(instanceId, customerPhone), sosUnreadKey(instanceId, customerPhone), sosIndexKey(instanceId),
    `chatwoot:inbox:${instanceId}`, `operator_cases:${instanceId}`, `history:${instanceId}:${customerPhone}`,
    `chatwoot:events:${instanceId}`,
    `operator_notification:${instanceId}:${caseId}:hub`, `operator_notification:${instanceId}:${caseId}:admin`,
    `operator_notification_pending:${instanceId}`,
  ];
}
function parseRecord(raw: string | null): Record<string, any> | null {
  try {
    const value = JSON.parse(raw || 'null');
    return value && typeof value === 'object' && !Array.isArray(value) ? value : null;
  } catch { return null; }
}
function ownsOpenCase(data: Record<string, any> | null, instanceId: string, customerPhone: string, caseId: string) {
  return Boolean(data && data.id === caseId && data.instanceId === instanceId
    && phone(data.phone) === customerPhone && data.status === 'open');
}
function historySignal(caseId: string, data: Record<string, any>, now: number) {
  return JSON.stringify({
    role: "user", direction: "incoming", fromMe: false, source: "openbot_operator_case", operatorCaseId: caseId,
    caseKind: data.kind, highlight: "red", text: `\u{1F6A8} Оператор қажет: ${clean(data.summary, 180)}`, createdAt: now,
  });
}
const APPEND_HISTORY = `
if ARGV[6] ~= '' then
  local found = false
  for _, row in ipairs(redis.call('LRANGE', KEYS[9], -40, -1)) do
    local ok, item = pcall(cjson.decode, row)
    if ok and type(item) == 'table' and item.source == 'openbot_operator_case'
      and item.operatorCaseId == ARGV[12] then found = true; break end
  end
  if not found then
    redis.call('RPUSH', KEYS[9], ARGV[6])
    redis.call('LTRIM', KEYS[9], -120, -1)
  end
  redis.call('EXPIRE', KEYS[9], ARGV[10])
end
`;
const ATOMIC_NOTIFICATION_TYPES = `
for _, i in ipairs({11, 12}) do
  local actual = redis.call('TYPE', KEYS[i]).ok
  if actual ~= 'none' and actual ~= 'string' then return redis.error_reply('OPERATOR_NOTIFICATION_WRONGTYPE') end
end
local actual = redis.call('TYPE', KEYS[13]).ok
if actual ~= 'none' and actual ~= 'zset' then return redis.error_reply('OPERATOR_NOTIFICATION_WRONGTYPE') end
`;
const ATOMIC_NOTIFICATION_VALIDATE = `
local plans = {}
if ARGV[16] ~= '' then
  for offset = 0, 1 do
    local key = KEYS[11 + offset]
    local raw = redis.call('GET', key)
    if raw then
      local ok, record = pcall(cjson.decode, raw)
      if not ok or type(record) ~= 'table' or type(record.payload) ~= 'table'
        or (record.status ~= 'pending' and record.status ~= 'delivered')
        or type(record.prepared_at) ~= 'string' or type(record.recipient) ~= 'string' or type(record.text) ~= 'string'
        or type(record.attempts) ~= 'number' or record.attempts < 0 or record.attempts % 1 ~= 0
        or type(record.next_attempt_at) ~= 'number' or record.next_attempt_at < 0
        or record.next_attempt_at >= math.huge then
        return redis.error_reply('OPERATOR_NOTIFICATION_RECORD_INVALID')
      end
      local payload = record.payload
      if record.instance_id ~= ARGV[18] or payload.instanceId ~= ARGV[18]
        or payload.caseId ~= ARGV[12] or type(payload.phone) ~= 'string'
        or payload.phone ~= ARGV[11] or type(payload.signalId) ~= 'string' or payload.signalId == ''
        or type(payload.kind) ~= 'string'
        or payload.channel ~= (offset == 0 and 'hub' or 'admin') then
        return redis.error_reply('OPERATOR_NOTIFICATION_SCOPE_MISMATCH')
      end
      plans[offset + 1] = record
    end
  end
end
`;
const ATOMIC_NOTIFICATION_COMMIT = `
if ARGV[16] ~= '' then
  for offset = 0, 1 do
    local key = KEYS[11 + offset]
    local record = plans[offset + 1]
    if not record then
      -- Pending plans and their due index must survive outages without TTL.
      redis.call('SET', key, ARGV[16 + offset])
      redis.call('ZADD', KEYS[13], ARGV[7], key)
    elseif record.status == 'pending' then
      redis.call('PERSIST', key)
      redis.call('ZADD', KEYS[13], record.next_attempt_at, key)
    end
  end
  redis.call('PERSIST', KEYS[13])
end
`;

const CREATE_LIFECYCLE = LIFECYCLE_TYPES + ATOMIC_NOTIFICATION_TYPES + LIFECYCLE_FENCE + `
if ARGV[14] == 'preserve' then return 1 end
if ARGV[14] == 'new' and redis.call('EXISTS', KEYS[3]) == 1 then return 0 end
` + ATOMIC_NOTIFICATION_VALIDATE + `
-- Canonical signal and BOTH recoverable delivery plans commit together.
redis.call('SET', KEYS[3], ARGV[4], 'EX', ARGV[8])
redis.call('SET', KEYS[1], ARGV[12], 'EX', ARGV[8])
redis.call('SET', KEYS[4], ARGV[5], 'EX', ARGV[9])
redis.call('SET', KEYS[5], ARGV[15], 'EX', ARGV[9])
redis.call('ZADD', KEYS[6], tonumber(ARGV[7]) + tonumber(ARGV[9]) * 1000, ARGV[11])
redis.call('ZREMRANGEBYSCORE', KEYS[6], '-inf', ARGV[7])
redis.call('EXPIRE', KEYS[6], ARGV[8])
redis.call('ZADD', KEYS[7], ARGV[7], ARGV[11])
redis.call('EXPIRE', KEYS[7], ARGV[8])
redis.call('ZADD', KEYS[8], ARGV[7], ARGV[12])
redis.call('EXPIRE', KEYS[8], ARGV[8])
` + APPEND_HISTORY + ATOMIC_NOTIFICATION_COMMIT + `
redis.call('PUBLISH', KEYS[10], ARGV[13])
return 1
`;

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
  // Concurrent close/new signal invalidates the complete snapshot. Re-read it;
  // never reopen the closed record or inherit its accepted notification ledger.
  for (let attempt = 0; attempt < 8; attempt++) {
    const existingId = await redisClient.get(activeKey(instanceId, customerPhone));
    const now = Date.now();
    const freshId = `oc_${now}_${crypto.randomBytes(4).toString("hex")}`;
    const oldCaseId = existingId || freshId;
    const rawCase = await redisClient.get(caseKey(instanceId, oldCaseId));
    const rawMarker = await redisClient.get(sosMarkerKey(instanceId, customerPhone));
    const previous = parseRecord(rawCase);
    const reuse = Boolean(existingId && ownsOpenCase(previous, instanceId, customerPhone, existingId));
    const preserved = reuse && shouldPreserveExistingCase(previous, input);
    const caseId = reuse ? existingId! : freshId;
    const revision = crypto.randomUUID();
    const data: Record<string, any> = {
      ...(reuse ? previous : {}),
      id: caseId, instanceId, phone: customerPhone, kind: input.kind, status: "open", unread: true, highlight: "red",
      urgency: clean(input.urgency || (reuse && previous?.urgency) || "normal", 20),
      summary: clean(input.summary) || (reuse ? previous?.summary : '') || '',
      source: clean(input.source || (reuse && previous?.source) || "openbot", 80),
      orderNumber: clean(input.orderNumber || "", 40) || (reuse ? previous?.orderNumber : '') || '',
      hasMedia: Boolean(input.hasMedia) || Boolean(reuse && previous?.hasMedia),
      createdAt: reuse ? previous?.createdAt || now : now, updatedAt: now,
      markerPushedAt: reuse ? previous?.markerPushedAt || now : now, revision,
    };
    const expiresAt = now + SOS_TTL_SECONDS * 1000;
    const sos = {
      caseId, caseRevision: revision, signalId, kind: input.kind, summary: clean(data.summary, 500),
      urgency: data.urgency, source: data.source, startedAt: now, expiresAt,
    };
    const notificationPayload = {instanceId, phone: customerPhone, caseId, signalId, kind: data.kind,
      summary: data.summary, source: data.source, orderNumber: data.orderNumber, createdAt: now};
    const plan = (channel: "hub" | "admin"): NotificationRecord => ({
      instance_id: instanceId, status: "pending", prepared_at: new Date(now).toISOString(),
      attempts: 0, next_attempt_at: now, recipient: "", text: "", payload: {...notificationPayload, channel},
    });
    const planIncident = !isTechnicalRecoveryCase(data);
    const applied = Number(await redisClient.eval(CREATE_LIFECYCLE, {
      keys: lifecycleKeys(instanceId, customerPhone, oldCaseId, caseId),
      arguments: [
        existingId || '', rawCase || '', rawMarker || '', JSON.stringify(data), JSON.stringify(sos),
        reuse && previous?.markerPushedAt ? '' : historySignal(caseId, data, now),
        String(now), String(CASE_TTL_SECONDS), String(SOS_TTL_SECONDS), String(CHAT_HISTORY_TTL_SECONDS),
        customerPhone, caseId,
        JSON.stringify({type: "sos.created", instanceId, phone: customerPhone, caseId, signalId, caseRevision: revision, expiresAt, emittedAt: now, origin: "openbot"}),
        preserved ? 'preserve' : reuse ? 'reuse' : 'new', signalId,
        planIncident ? JSON.stringify(plan('hub')) : '', planIncident ? JSON.stringify(plan('admin')) : '', instanceId,
      ],
    })) === 1;
    if (!applied) continue;
    if (preserved) return {...previous, id: existingId, preservedExistingCase: true, sos: null};
    await queueOperatorCaseNotifications({instanceId, phone: customerPhone, caseId, signalId, kind: input.kind, summary: data.summary, source: data.source, orderNumber: data.orderNumber});
    // Both plans already committed with the canonical signal; this idempotent
    // call preserves the queue API. A crash before it is recovered by the cron drain.
    // Network delivery never delays the guest reply.
    void notifyHubSos({instanceId, phone: customerPhone, caseId, signalId, kind: input.kind, summary: data.summary, orderNumber: data.orderNumber}).catch(() => undefined);
    return {...data, id: caseId, sos};
  }
  throw new Error('OPERATOR_LIFECYCLE_CONFLICT');
}

// Network work runs after the delivery plan is durably persisted. One active
// case has independent Hub and admin acceptance ledgers; a restart drains them.
async function notifyHubSos(args: {
  instanceId: string; phone: string; caseId: string; signalId: string;
  kind: OperatorCaseKind; summary: string; orderNumber?: string;
}) {
  await drainOperatorNotifications([{instance_id: args.instanceId}]);
}

// A case already sitting on the operator board must not raise a second red flag
// just because the chat scrolled past the first one, and a case nobody has
// touched for half a day must not keep flagging a guest who has long moved on
// to ordinary questions.
export const CASE_FLAG_QUIET_MS = 12 * 60 * 60 * 1000;

export type CaseFlagDecision = "flag" | "already_flagged" | "stale";

export function decideCaseFlag(data: { markerPushedAt?: number; updatedAt?: number; createdAt?: number }, now = Date.now()): CaseFlagDecision {
  // Quiet episodes release their active pointer before the flag check. The
  // outstanding 24h SOS, history and acceptance ledgers remain for the operator;
  // only an explicit matching close/recovery resolves the canonical record.
  const lastTouch = Number(data?.updatedAt || data?.createdAt || 0);
  if (lastTouch && now - lastTouch > CASE_FLAG_QUIET_MS) return "stale";
  if (data?.markerPushedAt) return "already_flagged";
  return "flag";
}

export async function resolveTechnicalSosAfterRecovery(instanceId: string, rawPhone: string): Promise<boolean> {
  const customerPhone = phone(rawPhone);
  if (!instanceId || !customerPhone) return false;
  await connectRedis();
  const rawMarker = await redisClient.get(sosMarkerKey(instanceId, customerPhone));
  const marker = parseRecord(rawMarker);
  const caseId = clean(marker?.caseId, 96);
  if (!caseId) return false;
  const rawCase = await redisClient.get(caseKey(instanceId, caseId));
  const operatorCase = parseRecord(rawCase);
  const currentActive = await redisClient.get(activeKey(instanceId, customerPhone));
  if (currentActive !== caseId || !ownsOpenCase(operatorCase, instanceId, customerPhone, caseId)
    || !canAutoResolveTechnicalSos(marker, operatorCase)) return false;
  if ((marker?.caseRevision || operatorCase?.revision) && marker?.caseRevision !== operatorCase?.revision) return false;
  const now = Date.now();
  const resolved = JSON.stringify({
    ...operatorCase, status: "resolved", unread: false, highlight: "", resolvedAt: now,
    resolution: "automatic_recovery", updatedAt: now, revision: crypto.randomUUID(),
  });
  // A reused case/changed marker/closed case wins, even at the same millisecond.
  // Keep historical notification ledgers; clearing a signal is not a new send.
  const script = LIFECYCLE_TYPES + LIFECYCLE_FENCE + `
redis.call('SET', KEYS[2], ARGV[4], 'KEEPTTL')
redis.call('DEL', KEYS[1], KEYS[4], KEYS[5])
redis.call('ZREM', KEYS[6], ARGV[5])
redis.call('PUBLISH', KEYS[10], ARGV[6])
return 1
`;
  return Number(await redisClient.eval(script, {
    keys: lifecycleKeys(instanceId, customerPhone, caseId),
    arguments: [caseId, rawCase!, rawMarker!, resolved, customerPhone, JSON.stringify({
      type: "sos.resolved", instanceId, phone: customerPhone, caseId, reason: "automatic_recovery", emittedAt: now, origin: "openbot",
    })],
  })) === 1;
}

const BUMP_LIFECYCLE = LIFECYCLE_TYPES + LIFECYCLE_FENCE + `
if ARGV[14] == 'stale' then
  -- Release only this pointer; outstanding SOS/history/ledgers remain for the operator.
  redis.call('DEL', KEYS[1])
  return 2
end
if ARGV[14] == 'flag' then
  redis.call('SET', KEYS[2], ARGV[4], 'EX', ARGV[8])
  if ARGV[5] ~= '' then redis.call('SET', KEYS[4], ARGV[5], 'KEEPTTL') end
end
` + APPEND_HISTORY + `
redis.call('ZADD', KEYS[7], ARGV[7], ARGV[11])
redis.call('EXPIRE', KEYS[7], ARGV[8])
return 1
`;

export async function bumpOperatorCaseSignal(instanceId: string, rawPhone: string) {
  const customerPhone = phone(rawPhone);
  if (!instanceId || !customerPhone) return false;
  await connectRedis();
  const caseId = await redisClient.get(activeKey(instanceId, customerPhone));
  if (!caseId) return false;
  const rawCase = await redisClient.get(caseKey(instanceId, caseId));
  const data = parseRecord(rawCase);
  if (!ownsOpenCase(data, instanceId, customerPhone, caseId)) return false;
  const rawMarker = await redisClient.get(sosMarkerKey(instanceId, customerPhone));
  const marker = parseRecord(rawMarker);
  if (rawMarker && (!marker || marker.caseId !== caseId
    || ((marker.caseRevision || data?.revision) && marker.caseRevision !== data?.revision))) return false;
  const now = Date.now();
  const decision = decideCaseFlag(data!, now);
  const revision = crypto.randomUUID();
  const flagged = {...data, markerPushedAt: now, revision};
  const updatedMarker = marker ? JSON.stringify({...marker, caseRevision: revision}) : '';
  return Number(await redisClient.eval(BUMP_LIFECYCLE, {
    keys: lifecycleKeys(instanceId, customerPhone, caseId),
    arguments: [
      caseId, rawCase!, rawMarker || '', JSON.stringify(flagged), updatedMarker,
      decision === 'flag' ? historySignal(caseId, data!, now) : '',
      String(now), String(CASE_TTL_SECONDS), String(SOS_TTL_SECONDS), String(CHAT_HISTORY_TTL_SECONDS),
      customerPhone, caseId, '', decision,
    ],
  })) === 1;
}
