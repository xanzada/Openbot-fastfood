import crypto from "node:crypto";
import type { FastFoodContext } from "../context/types.js";
import {
  clearComplaintMedia,
  getComplaintMedia,
  markComplaintClarificationPending,
  saveCaseMedia,
  takeComplaintClarification,
  redisClient,
} from "./redis.service.js";
import { bumpOperatorCaseSignal, createOperatorCase, detectOperatorCaseKind, getActiveOperatorCaseId, CASE_FLAG_QUIET_MS } from "./operatorCase.service.js";
import { auditError } from "./auditLogger.service.js";
import { intentMatches, isLikelyMenuQuestion } from "../utils/intentText.js";

export type ComplaintUrgency = "low" | "normal" | "high";

export interface ComplaintMediaPayload {
  base64: string;
  mimeType?: string;
  mediaType?: string;
  filename?: string;
}

export interface ComplaintRoutingInput {
  summary: string;
  customerText?: string;
  customerReply?: string;
  urgency?: ComplaintUrgency;
  media?: ComplaintMediaPayload | null;
  source?: string;
}

const ESCALATION_SIGNAL_RE = /\[(ESCALATE_ADMIN|ESCALATE_DEVELOPER)\]/giu;
const ADMIN_SIGNAL_RE = /\[ESCALATE_ADMIN\]/iu;
const DEVELOPER_SIGNAL_RE = /\[ESCALATE_DEVELOPER\]/iu;
const COMPLAINT_RE =
  /(шағым|жалоб|претензи|волос|шаш(?!л)|гряз|(?:^|[^\p{L}])лас(?!с)|суық|суык|холодн|испорч|бұзыл|бузыл|улан|отрав|не тот заказ|чужой заказ|басқа (?:тапсырыс|заказ)|қате (?:тапсырыс|заказ)|не привезли|жетпей|не хватает|дөрек|груб|сапа|качест)/iu;
const ACTIONABLE_SERVICE_INCIDENT_RE =
  /(заказ|тапсырыс).{0,40}(опозд|задерж|кешік|кешіг|не\s+(?:приехал|доставлен|привезли)|келмед|жеткізілмед)/iu;
const CONCRETE_COMPLAINT_DETAIL_RE =
  /(волос|шаш(?!л)|гряз|(?:^|[^\p{L}])лас(?!с)|суық|суык|холодн|испорч|бұзыл|бузыл|улан|отрав|не тот заказ|чужой заказ|басқа (?:тапсырыс|заказ)|қате (?:тапсырыс|заказ)|не привезли|жетпей|не хватает|курьер.{0,30}(?:дөрек|груб)|(?:дөрек|груб).{0,30}курьер)/iu;

function normalizePhone(value = "") {
  return String(value || "").replace(/\D/g, "");
}

function cleanLine(value: unknown, max = 700) {
  return String(value || "")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, max);
}

function getRestaurantLabel(ctx: FastFoodContext, liveConfig: Record<string, any>) {
  return cleanLine(liveConfig.name || liveConfig.restaurant_name || ctx.config?.name || ctx.config?.restaurant_name || ctx.instanceId, 120);
}

// The operator's first question is always "which order?", so the number a HUMAN can
// read comes first. The 2026-08-29 nail complaint reached the operator with
// order_number "not_found" while order #61 sat in the same conversation: the lookup
// only tried the internal uuid fields and never display_number/order_number, which is
// what both the guest and the panel actually use.
function getOrderLabel(ctx: FastFoodContext) {
  const order = ctx.activeOrder as Record<string, any> | null | undefined;
  const candidate =
    order?.display_number
    ?? order?.order_number
    ?? order?.number
    ?? order?.order_no
    ?? order?.order_id
    ?? order?.id
    ?? order?.orderId
    ?? "not_found";
  return cleanLine(candidate, 80);
}

function toWhatsProMedia(media: ComplaintMediaPayload | null) {
  if (!media?.base64) return null;
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

// This additional arrival report proves only a current customer incident.
// Keep punctuation/quote scope until admission; the legacy clause splitter below
// cannot turn a question or a reported past arrival into this new evidence.
function hasCurrentMissingArrivalReport(text = ""): boolean {
  const value = String(text).replace(/«[^»]*»|“[^”]*”|"[^"]*"|‘[^’]*’|'[^']*'/gu, "");
  const subject = "(?:(?:сегодня|сейчас|до\\s+сих\\s+пор)\\s+)?(?:(?:мой|наш)\\s+)?заказ\\s+";
  const missing = new RegExp("^" + subject + "(?:(?:так\\s+и|вс[её]\\s+ещ[её]|до\\s+сих\\s+пор|ещ[её]|уже)\\s+)?не\\s+приш[её]л(?!\\p{L})", "iu");
  const arrived = new RegExp("^" + subject + "(?:(?:уже|сейчас|теперь)\\s+)?приш[её]л(?!\\p{L})", "iu");
  let current = false;
  for (const sentence of value.match(/[^\n.!?;]+[.!?;]?/gu) || []) {
    let conditional = false;
    let reported = false;
    const parts = sentence.split(/(,\s*(?:но\s+)?|\s+но\s+)/iu);
    for (let index = 0; index < parts.length; index++) {
      if (index % 2) {
        // Contrast introduces an independent assertion; a plain comma keeps
        // the reporting verb's dependent clause attached to its speaker.
        if (/(?<!\p{L})но(?!\p{L})/iu.test(parts[index])) reported = false;
        continue;
      }
      const clause = parts[index].trim();
      const ownCurrentReport = /^я\s+(?:говорю|пишу|сообщаю)(?!\p{L})/iu.test(clause);
      if (!ownCurrentReport
        && /^(?:[\p{L}-]+\s+){1,4}(?:говор(?:ит|ят|ил|ила|или|ю)|сказа(?:л|ла|ли)|пиш(?:ет|ут|у)|написа(?:л|ла|ли)|сообщ(?:ает|ают|ил|ила|или|аю))(?!\p{L})/iu.test(clause)) reported = true;
      if (/^(?:если|допустим|представ\p{L}*)(?!\p{L})/iu.test(clause)) conditional = true;
      if (conditional || reported || /\?/u.test(clause)) continue;
      // The actual subject must lead this clause. Quoted/reported/historical
      // prefixes cannot lend their order noun to a current missing-arrival claim.
      if (missing.test(clause)
        && !/(?<!\p{L})(?:бы|ли|вчера|позавчера|раньше|прошл\p{L}*)(?!\p{L})/iu.test(clause)) current = true;
      if (arrived.test(clause)) current = false;
    }
  }
  return current;
}

function hasExistingComplaintText(text: string): boolean {
  return intentMatches(COMPLAINT_RE, text) || intentMatches(ACTIONABLE_SERVICE_INCIDENT_RE, text);
}

export function isLikelyComplaintText(text = "") {
  const value = String(text || "");
  return hasExistingComplaintText(value) || hasCurrentMissingArrivalReport(value);
}

export function isLikelyOperatorRequestText(text = "") {
  return Boolean(detectOperatorCaseKind(text));
}

// Detail improves the case summary; a current complaint itself is enough for
// the human handoff. Technical failures and unrelated turns are not complaints.
export function complaintHasActionableDetail(text = "") {
  const clean = String(text || "").replace(/\s+/g, " ").trim();
  if (hasCurrentMissingArrivalReport(text)) return true;
  if (intentMatches(ACTIONABLE_SERVICE_INCIDENT_RE, clean) || intentMatches(CONCRETE_COMPLAINT_DETAIL_RE, clean)) return true;
  if (clean.length >= 60) return true;
  const words = clean.split(" ").filter(word => word.length > 2);
  return words.length >= 6;
}

export function buildComplaintDetailQuestion(language: "kk" | "ru") {
  return language === "ru"
    ? "Извините. Расскажите, пожалуйста, что именно случилось — передам оператору."
    : "Кешіріңіз. Нақты не болғанын жазып жіберіңізші — операторға беремін.";
}

// A clarification is available for ambiguous turns, not an explicit current
// complaint, courier-contact request or human request.
export function buildEscalationClarifyQuestion(kind: string | null, language: "kk" | "ru") {
  if (language === "ru") {
    if (kind === "courier_request") {
      return "Подскажите, что именно с доставкой: заказ задерживается или нужно что-то передать курьеру? Напишите коротко - я сразу разберусь или передам оператору с деталями.";
    }
    if (kind === "human_request") {
      return "Конечно, помогу. Напишите коротко, что случилось - если решение за мной, отвечу сразу, а если нужен человек, передам оператору уже с деталями.";
    }
    return buildComplaintDetailQuestion(language);
  }
  if (kind === "courier_request") {
    return "Жеткізу жайлы нақты айтыңызшы: тапсырыс кешігіп жатыр ма, әлде курьерге бір нәрсе жеткізу керек пе? Қысқаша жазыңыз - бірден шешейін немесе операторға дәл мәселемен жіберейін.";
  }
  if (kind === "human_request") {
    return "Әрене, көмектесейін. Не болғанын қысқаша жазып жіберіңізші - шеше алсам бірден өзім жауап беремін, адам керек болса операторға дәл мәселемен жеткіземін.";
  }
  return buildComplaintDetailQuestion(language);
}

export function buildOperatorHandoffReply(language: "kk" | "ru") {
  return language === "ru"
    ? "Передал оператору — он свяжется с вами."
    : "Операторға бердім — ол сізбен байланысады.";
}

export function buildComplaintClarificationReply(language: "kk" | "ru") {
  return language === "ru"
    ? "Пожалуйста, коротко опишите проблему текстом. Я передам фото и описание администратору."
    : "Мәселені қысқаша мәтінмен сипаттап жіберіңіз. Фото мен сипаттаманы админге жіберемін.";
}

/**
 * The photo already showed what went wrong, so the guest is never asked to describe it.
 *
 * A photo of a nail in the food was answered "please describe the problem in text" -
 * twice, once per photo (owner report, 2026-08-29). The reader had seen it and written
 * a summary; the code threw that away and asked anyway. When there is nothing left to
 * ask, this acknowledges and hands over. When one detail genuinely helps the operator
 * (which dish, which order), the model supplies that ONE question and it is appended -
 * never a generic "describe the issue".
 */
export function buildEvidenceSeenReply(language: "kk" | "ru", detailQuestion = "") {
  const detail = String(detailQuestion || "").replace(/\s+/g, " ").trim().slice(0, 160);
  if (language === "ru") {
    return detail
      ? `Извините за это. Фото передал администратору. ${detail}`
      : "Извините за это. Фото передал администратору — он свяжется с вами.";
  }
  return detail
    ? `Кешіріңіз. Фотоны админге жібердім. ${detail}`
    : "Кешіріңіз. Фотоны админге жібердім — ол сізбен байланысады.";
}

export function buildComplaintAckReply(language: "kk" | "ru") {
  return language === "ru"
    ? "Извините за ситуацию. Я передал жалобу администратору, он проверит и свяжется с вами."
    : "Кешіріңіз. Шағымды админге жібердім, ол тексеріп сізбен байланысады.";
}

// Said when the guest's problem is real but the case could not be recorded. It
// promises nothing a human has not been told about.
export function buildEscalationUnavailableReply(language: "kk" | "ru") {
  return language === "ru"
    ? "Извините за ситуацию. Сейчас не могу передать обращение оператору из-за технического сбоя. Напишите, пожалуйста, ещё раз через пару минут — или позвоните нам."
    : "Кешіріңіз. Техникалық ақаудан қазір өтінішті операторға жібере алмадым. Екі-үш минуттан кейін қайта жазыңыз — немесе бізге қоңырау шалыңыз.";
}

export async function hasPendingComplaintMedia(instanceId: string, phone: string): Promise<boolean> {
  const media = await getComplaintMedia(instanceId, phone).catch(() => null);
  return Boolean(media?.base64);
}

export function isExplicitHumanOperatorRequest(text = ""): boolean {
  const value = String(text).toLowerCase().replace(/«[^»]*»|“[^”]*”|"[^"]*"/g, " ").replace(/\s+/g, " ").trim();
  const human = "(?:оператор\\p{L}*|администратор\\p{L}*|админ\\p{L}*|менеджер\\p{L}*|человек\\p{L}*|адам\\p{L}*)";
  return value.split(/[.!?;]|\s+но\s+|бірақ/iu).map(part => {
    // Urgency/politeness modifies a request; it is not evidence by itself.
    // Keep the remaining negation and explicit human-request grammar unchanged.
    const clause = part.trim().replace(/^(?:(?:(?:очень\s+)?срочно|шұғыл|пожалуйста|өтінемін)(?:\s*[,:\u2014-]\s*|\s+)){1,3}/iu, "");
    const refusal = "(?:хочу|хотел\\p{L}*|нужен|нужна|нужно|надо|зов\\p{L}*|позов\\p{L}*|вызыв\\p{L}*|соедин\\p{L}*|переключ\\p{L}*|свяж\\p{L}*|поговор\\p{L}*)";
    if (new RegExp("(?:^|[^\\p{L}])не\\s+" + refusal + "(?:\\s+(?:говорить|разговаривать|поговорить|с|со|меня|нас|видеть|живого|живой|настоящего|пожалуйста)){0,6}\\s+" + human + "|" + human + ".{0,20}(?:не\\s+(?:нужен|нужна|нужно|надо)|керек\\s*емес|қажет\\s*емес)", "iu").test(clause)) return false;
    if (new RegExp("^(?:пожалуйста[, ]*)?(?:живой\\s+|тірі\\s+|жанды\\s+)?" + human + "(?:[, ]*пожалуйста)?$", "iu").test(clause)) return true;
    // Imperative and first-person speech requests are different from an
    // operator's own needs or a reported/quoted statement about that person.
    const action = "(?:позови(?:те)?|соедини(?:те)?|переключи(?:те)?|свяжи(?:те)?|дайте|дай|вызови(?:те)?|хочу|хотел(?:а)?\\s+бы|можно\\s+(?:позвать|поговорить)|шақыр\\p{L}*|шакыр\\p{L}*|байланыстыр\\p{L}*)";
    if (new RegExp("(?:^|[^\\p{L}])" + action + "(?:\\s+(?:меня|нас|пожалуйста|с|со|к|живого|живой|настоящего|поговорить|говорить|связаться|лично)){0,6}\\s+" + human, "iu").test(clause)) return true;
    if (new RegExp("^(?:(?:мне|нам)\\s+)?(?:нужен|нужна|нужны)\\s+(?:живой\\s+|настоящий\\s+)?" + human + "$", "iu").test(clause)) return true;
    if (/^(?:оператор|администратор|админ|менеджер|человек)\s+(?:нужен|нужна|нужны)(?:\s+(?:мне|нам))?$/iu.test(clause)) return true;
    const kkHuman = "(?:оператор(?:мен|ды|ға|га)?|админ(?:мен|ді|ге)?|менеджер(?:мен|ді|ге)?|адам(?:мен|ды|ға|га)?)";
    const kkRequest = "(?:керек|қажет|кажет|шақыр\\p{L}*|шакыр\\p{L}*|берші|беріңіз|сөйлескім\\p{L}*|сөйлесейін\\p{L}*|сойлескім\\p{L}*|байланысқым\\p{L}*)";
    if (new RegExp("^(?:(?:маған|бізге|мен|қазір)\\s+)*(?:тірі\\s+|жанды\\s+)?" + kkHuman + "\\s+" + kkRequest + "(?:\\s+келеді|\\s+пожалуйста|\\s+өтінемін)?$", "iu").test(clause)) return true;
    return null;
  }).filter(flag => flag !== null).at(-1) === true;
}


function currentRequestClauses(text: string): string[] {
  return String(text).replace(/«[^»]*»|“[^”]*”|"[^"]*"/gu, " ")
    .split(/[.!?;]|\s+но\s+|\s+бірақ\s+/iu).map(part => part.trim()).filter(Boolean);
}

export function isCurrentComplaintRequest(text = ""): boolean {
  let requested = false;
  for (const clause of currentRequestClauses(text)) {
    if (/^(?:если|егер|друг|клиент|оператор|он\s+сказал|она\s+сказала)/iu.test(clause)) continue;
    if (/(?:не\s+хочу\s+(?:жаловаться|пожаловаться)|жалоб\p{L}*.{0,15}(?:нет|не\s+нуж)|шағым.{0,30}(?:емес|жоқ)|передумал)/iu.test(clause)) {
      requested = false; continue;
    }
    const describesFailure = !isLikelyMenuQuestion(clause)
      || /(заказ|тапсырыс|привез|келді|келдi|достав|волос|тырнақ|отрав|улан)/iu.test(clause);
    if (/^(?:(?:я\s+)?хочу\s+пожаловаться|(?:у\s+меня\s+)?жалоба|шағым\s+(?:айтқым\s+келеді|бар))$/iu.test(clause)
      || (describesFailure && hasExistingComplaintText(clause) && complaintHasActionableDetail(clause))) requested = true;
  }
  // Arrival authority retains whole-message question, reporting and resolution scope.
  return requested || hasCurrentMissingArrivalReport(text);
}

export function isExplicitCourierContactRequest(text = ""): boolean {
  let requested = false;
  for (const clause of currentRequestClauses(text)) {
    if (/^(?:если|егер|друг|клиент|он\s+сказал|она\s+сказала)/iu.test(clause)) continue;
    if (!/курьер/iu.test(clause) || !/(?:номер|нөмір|номір|телефон|хабарлас)/iu.test(clause)) continue;
    if (/(?:не\s+(?:нуж|надо|хочу)|керек\s*емес|қажет\s*емес|не\s+давайте|бермеңіз)/iu.test(clause)) { requested = false; continue; }
    if (/(?:дай|дайте|пришл|подскаж|покаж|нуж|надо|хочу|связ|хабарлас|керек|қажет|бер|какой|қандай|где)/iu.test(clause)
      || /^(?:номер|телефон)\s+курьера$/iu.test(clause)) requested = true;
  }
  return requested;
}

export function hasConfirmedCustomerIncident(ctx: FastFoodContext, guestText = ctx.text || ""): boolean {
  if (isExplicitHumanOperatorRequest(guestText) || isExplicitCourierContactRequest(guestText)
    || isCurrentComplaintRequest(guestText)) return true;
  if (hasCurrentMissingArrivalReport(guestText)) return true;
  const clauses = String(guestText).split(/[.!?;,]|\s+но\s+|\s+бірақ\s+/iu).map(part => part.trim()).filter(Boolean);
  const cancellationDenied = /(?:^|[^\p{L}])не\s+(?:надо\s+|нужно\s+|хочу\s+)?(?:отмен\p{L}*|отказ\p{L}*|откаж\p{L}*)|(?:отмен\p{L}*|отказ\p{L}*).{0,20}(?:не\s+(?:нуж|надо|хочу)|керек\s*емес)|жойма|болдырма.{0,20}керек\s*емес/iu;
  const refundDenied = /(?:возврат|верн\p{L}*.{0,20}деньг).{0,20}не\s+(?:нуж|надо|хочу)|(?:^|[^\p{L}])не\s+(?:надо\s+|нужно\s+|хочу\s+)?(?:возврат|верн\p{L}*)|қайтарма|қайтар.{0,20}керек\s*емес/iu;
  for (const clause of clauses) {
    const customerDescribesFailure = !isLikelyMenuQuestion(clause)
      || /(заказ|тапсырыс|привез|келді|келдi|достав|волос|тырнақ|отрав|улан)/iu.test(clause);
    if (customerDescribesFailure && hasExistingComplaintText(clause) && complaintHasActionableDetail(clause)) return true;
    if (!cancellationDenied.test(clause) && detectOperatorCaseKind(clause) === "cancel_request") return true;
    // Charged/paid facts remain independent of declining a refund in another clause.
    if (/(уже\s+оплат|деньг\p{L}*\s+спис|спис\p{L}*\s+деньг|ақша.{0,20}алын|төлед|толед)/iu.test(clause)) return true;
    if (!refundDenied.test(clause) && /(верн\p{L}*.{0,20}деньг|возврат|ақша.{0,20}қайтар)/iu.test(clause)) return true;
    const emergencyDenied = /(?:^|[^\p{L}])не\s+(?:надо\s+|нужно\s+)?(?:вызыва\p{L}*|зов\p{L}*).{0,20}скорую|скорая.{0,20}не\s+(?:нуж|надо)|(?:задыха|анафилак).{0,15}(?:нет|жоқ)/iu;
    if (!emergencyDenied.test(clause) && /(задыха|не\s+могу\s+дышать|анафилак|скорую|плохо\s+после\s+еды|тамақтан.{0,25}(?:улан|ауырып)|дем\s+ала\s+алмай|(?:убью|өлтір|угрожа))/iu.test(clause)) return true;
  }
  // Allergy context comes only from recent customer statements. A denial in the
  // latest statement replaces prior context; summaries/assistant text cannot prove it.
  const customerHistory = (Array.isArray(ctx.chatHistory) ? ctx.chatHistory : [])
    .filter(entry => entry?.role === "user").slice(-6)
    .map(entry => String(entry.content ?? entry.text ?? ""));
  const allergyStatements = [...customerHistory, guestText].flatMap(text => String(text)
    .split(/[.!?;,]|\s+но\s+|\s+бірақ\s+/iu)).filter(clause => /аллерг|анафилак/iu.test(clause));
  const allergyDenied = /(?:аллерг\p{L}*|анафилак\p{L}*).{0,24}(?:нет|жоқ|жок|не\s+(?:было|бывает))|(?:нет|жоқ|жок|без)\s+(?:у\s+\p{L}+\s+)?(?:аллерг\p{L}*|анафилак\p{L}*)/iu;
  const allergyContext = allergyStatements.map(clause => !allergyDenied.test(clause)).at(-1) === true;
  return allergyContext && /қауіп|кепіл|жаңғақ|без\s+орех|гарант|безопас|аллерг|анафилак/iu.test(guestText);
}

// A current bare complaint may continue an already admitted incident. Quoted,
// withdrawn or unrelated turns cannot borrow authority from an active pointer.
export async function resolveComplaintContinuation(ctx: FastFoodContext) {
  if (ctx.mediaContext) return null;
  const text = String(ctx.text || "").trim();
  const currentBareComplaint = /^(?:(?:я\s+)?хочу\s+пожаловаться|(?:у\s+меня\s+)?жалоба|шағым\s+(?:айтқым\s+келеді|бар))[.!]?$/iu.test(text);
  if (!currentBareComplaint) return null;
  const clarification = {
    action: "complaint_clarification" as const, caseId: null as string | null,
    customerReply: ctx.language === "ru"
      ? "Коротко опишите, что произошло, пожалуйста."
      : "Қысқаша не болғанын жазыңызшы.",
  };
  const instanceId = cleanLine(ctx.instanceId, 64);
  const customerPhone = normalizePhone(ctx.phone);
  if (!instanceId || !customerPhone) return clarification;
  try {
    const caseId = await getActiveOperatorCaseId(instanceId, customerPhone);
    if (!caseId) return null;
    // This is the unchanged canonical operatorCase record, not a history entry
    // or a model assertion. Redis expiry/null and read failures stay fail-closed.
    const raw = await redisClient.get(`operator_case:${instanceId}:${caseId}`);
    const record = raw ? JSON.parse(raw) : null;
    const lastTouch = Number(record?.updatedAt || record?.createdAt || 0);
    const now = Date.now();
    const age = now - lastTouch;
    if (!record || record.id !== caseId || record.instanceId !== instanceId
      || normalizePhone(record.phone) !== customerPhone || record.status !== "open"
      || record.kind !== "complaint" || !Number.isFinite(lastTouch) || lastTouch <= 0
      || age < 0 || age > CASE_FLAG_QUIET_MS
      || !isLikelyComplaintText(String(record.summary || ""))
      || !complaintHasActionableDetail(String(record.summary || ""))) return null;
    return {
      action: "complaint_continued" as const, caseId: String(caseId),
      customerReply: ctx.language === "ru"
        ? "Что хотите дополнить или уточнить по вашей жалобе?"
        : "Шағымыңыз бойынша не қосқыңыз немесе нақтылағыңыз келеді?",
    };
  } catch {
    return null;
  }
}

export async function routeComplaintToAdmin(ctx: FastFoodContext, input: ComplaintRoutingInput) {
  const continuation = input.source === "ai_unavailable" && !input.media
    ? await resolveComplaintContinuation(ctx) : null;
  if (continuation) return {
    ...continuation, operatorFlagged: false, queuedForChat: false,
    escalationAvailable: false, signaledToDle: false, signalId: "",
    mediaAttached: false, sent: false,
  };
  const savedMedia = await getComplaintMedia(ctx.instanceId, ctx.phone).catch(() => null);
  const media = toWhatsProMedia(input.media || (savedMedia as ComplaintMediaPayload | null));
  const guestText = String(ctx.text || input.customerText || "");
  const guestKind = detectOperatorCaseKind(guestText);
  const receiptContext = /receipt|payment|чек/iu.test(String(ctx.mediaContext?.kind || ctx.mediaContext?.type || ""))
    || /чек|түбіртек|тубиртек/iu.test(guestText);
  const detailedComplaint = isLikelyComplaintText(guestText) && complaintHasActionableDetail(guestText);
  const confirmedIncident = hasConfirmedCustomerIncident(ctx, guestText);
  const realFallbackIncident = input.source === "ai_unavailable"
    && Boolean(confirmedIncident || (media && receiptContext));
  // A provider failure is not a customer incident. Only the customer's actual
  // request/evidence may cross this boundary, even when the failed lane asks to escalate.
  if (input.source === "ai_unavailable" && !realFallbackIncident) {
    return {
      action: "skipped_technical_failure", caseId: null, operatorFlagged: false,
      queuedForChat: false, escalationAvailable: true, signaledToDle: false,
      signalId: "", mediaAttached: false, sent: false,
      customerReply: ctx.language === "ru"
        ? "Пожалуйста, уточните вопрос одним сообщением — попробую помочь."
        : "Сұрағыңызды бір хабарламамен нақтылап жазыңызшы — көмектесіп көрейін.",
    };
  }


  // A menu/availability/price question can never become an operator case, no
  // matter which path brought it here - regex lane, webhook gate, or the AI
  // tool. "Суық суы бар ма?" asks about a cold drink; it is answered from the
  // menu, and SOS stays silent. The AI tool path runs before the webhook gate,
  // so the refusal has to live here at the choke point (live false positives,
  // 2026-08-20). escalationAvailable stays true so callers never mistake the
  // skip for a missing admin phone and alert the developer.
  // ...but only for the lanes that carry a bare guest sentence. A photo of a wrong
  // order captioned "бұл дұрыс емес, пепперони бар ма еді?", a cancellation, or a
  // too-long voice note all match MENU_QUESTION_RE on the caption while being
  // anything but a menu question. Those lanes used to be dropped here with
  // escalationAvailable:true, so the caller skipped its developer alert and still
  // sent the guest an apology promising an operator - no case, no panel SOS, no
  // hub signal, and the photo expiring unseen (found 2026-08-22).
  const menuSkipApplies = !confirmedIncident && !realFallbackIncident
    && !media
    && !savedMedia?.base64
    && input.source !== "cancel_request"
    && input.source !== "media_analysis"
    && input.source !== "long_voice"
    // A payment shortfall is a measured amount, not a sentence to classify. The
    // guest's caption on the receipt photo often mentions a dish, and reading that
    // as a menu question would silently drop an underpayment (found 2026-08-23).
    && input.source !== "payment_shortfall"
    // Same reason, one step earlier in the money path: a file we could not read may
    // be a receipt, and its caption often names a dish. Dropping it here would put
    // the guest back on "try again later" with nobody looking at the payment
    // (owner, 2026-08-28).
    && input.source !== "media_unreadable_evidence"
    // The catalog has no ingredients, so a person has to read the real recipe;
    // skipping it made «асүйден нақтылап беремін» a promise nobody kept (2026-10-04).
    && input.source !== "composition_check"
    // The planner already classified this turn as an actionable incident and pinned
    // escalateToAdmin; the model skipped the tool. A dish named in the complaint must not
    // turn the guaranteed hand-off back into a silent skip (2026-10-04).
    && input.source !== "planned_escalation_missed";
  if (menuSkipApplies && isLikelyMenuQuestion(input.customerText || ctx.text)) {
    return {
      action: "skipped_menu_question",
      caseId: null,
      operatorFlagged: false,
      queuedForChat: false,
      escalationAvailable: true,
      signaledToDle: false,
      signalId: "",
      mediaAttached: false,
      sent: false,
      customerReply: ctx.language === "ru"
        ? "Пожалуйста, уточните вопрос одним сообщением — попробую помочь."
        : "Сұрағыңызды бір хабарламамен нақтылап жазыңызшы — көмектесіп көрейін.",
    };
  }
  const customerEvidenceRequired = [
    "ai_tool_escalate_to_admin", "ai_escalation_signal", "planned_escalation_missed",
    "human_request", "courier_request", "complaint_text", "complaint", "cancel_request", "long_voice",
  ].includes(String(input.source || ""));
  const bareComplaintNeedsClarification = input.source === "ai_tool_escalate_to_admin"
    && isLikelyComplaintText(guestText) && !detailedComplaint;
  if (customerEvidenceRequired && !confirmedIncident && !media && !savedMedia?.base64
    && !bareComplaintNeedsClarification) {
    return {
      action: "skipped_unconfirmed_incident", caseId: null, operatorFlagged: false,
      queuedForChat: false, escalationAvailable: true, signaledToDle: false,
      signalId: "", mediaAttached: false, sent: false,
      customerReply: ctx.language === "ru"
        ? "Пожалуйста, уточните вопрос одним сообщением — попробую помочь."
        : "Сұрағыңызды бір хабарламамен нақтылап жазыңызшы — көмектесіп көрейін.",
    };
  }
  // Only actual customer intent/evidence may open a case. A model's urgency,
  // summary, mood, or an unrelated answer to an old clarification is not evidence.
  if (input.source === "ai_tool_escalate_to_admin") {
    const guestText = input.customerText || ctx.text || "";
    const clarifyKind = detectOperatorCaseKind(guestText);
    const hasActionableStory = complaintHasActionableDetail(guestText);
    if (!confirmedIncident && !hasActionableStory && !media && clarifyKind !== "cancel_request") {
      const openCaseId = await getActiveOperatorCaseId(ctx.instanceId, ctx.phone).catch(() => null);
      if (!openCaseId) {
        // An unreadable state maps to "nothing pending" here, deliberately: during a
        // Redis outage createOperatorCase cannot work either (same backend), so failing
        // open would only produce escalation_failed one round sooner and lose the
        // clarify-first contract. Re-asking during an outage is the bounded cost.
        const firstDemandRaw = await takeComplaintClarification(ctx.instanceId, ctx.phone);
        const firstDemand = firstDemandRaw === "error" ? null : firstDemandRaw;
        if (firstDemand === null) {
          await markComplaintClarificationPending(ctx.instanceId, ctx.phone, guestText).catch(() => false);
          return {
            action: "clarification_requested",
            caseId: null,
            operatorFlagged: false,
            queuedForChat: false,
            escalationAvailable: true,
            signaledToDle: false,
            signalId: "",
            mediaAttached: false,
            sent: false,
            customerReply: buildEscalationClarifyQuestion(clarifyKind, ctx.language),
          };
        }
        // Repeating a bare complaint does not confirm a new incident.
        return {
          action: "skipped_unconfirmed_incident", caseId: null, operatorFlagged: false,
          queuedForChat: false, escalationAvailable: true, signaledToDle: false,
          signalId: "", mediaAttached: false, sent: false,
          customerReply: ctx.language === "ru"
            ? "Чтобы разобраться, нужно знать, что именно произошло."
            : "Көмектесу үшін нақты не болғанын білу керек.",
        };
      }
    }
  }
  const summary = cleanLine(realFallbackIncident ? guestText : input.summary || input.customerText || ctx.text || "Customer complaint requires review.");
  const urgency = input.urgency || "normal";
  const detectedKind = detectOperatorCaseKind(input.customerText || ctx.text);
  const kind = input.source === "long_voice" ? "long_voice"
    : realFallbackIncident ? (guestKind || (detailedComplaint ? "complaint" : "critical"))
    : input.source === "composition_check" ? "unresolved"
    : detectedKind || "complaint";
  const signalId = `sos_${Date.now()}_${crypto.randomBytes(4).toString("hex")}`;

  // WhatsPro Chat is the canonical operator workflow and already stores the
  // original customer message/media in the correctly scoped tenant inbox. The
  // legacy DLE endpoint does not implement operator_sos (it returns "unknown
  // action"), so duplicating the signal there only creates false production
  // incidents while adding no operator visibility.
  const operatorCase = await createOperatorCase({
    instanceId: ctx.instanceId,
    phone: ctx.phone,
    kind,
    summary,
    source: input.source,
    urgency,
    orderNumber: getOrderLabel(ctx),
    hasMedia: Boolean(media),
    signalId,
  }).catch((error) => {
    auditError("WhatsPro SOS signal failed", error, { instanceId: ctx.instanceId, signalId, kind });
    return null;
  });

  // The scratch copy is promoted to a case-scoped one before it is dropped. Deleting it
  // outright left the case pointing at evidence that only whatspro held, on a 24h TTL,
  // while the case itself lives 7 days - so a two-day-old red row said hasMedia:true with
  // nothing behind it (found 2026-08-23).
  if (media?.base64 && operatorCase?.id) {
    await saveCaseMedia(ctx.instanceId, String(operatorCase.id), {
      base64: media.base64,
      mimeType: media.mimeType,
      filename: media.filename,
    }).catch(() => false);
  }
  if (savedMedia?.base64 && operatorCase) {
    await clearComplaintMedia(ctx.instanceId, ctx.phone).catch(() => undefined);
  }

  // Creating the case only writes records the panel does not read. The one thing
  // an operator actually sees - the red "Оператор қажет" row at the top of the
  // inbox - is pushed by bumpOperatorCaseSignal, and nothing was calling it, so
  // every escalation since it was written has been silent: the guest was told a
  // person would come and no person was told anything. It carries its own
  // already-flagged/stale guard, so calling it here cannot double-flag.
  const preservedExistingCase = Boolean((operatorCase as any)?.preservedExistingCase);
  const flagged = operatorCase
    ? preservedExistingCase
      ? true
      : await bumpOperatorCaseSignal(ctx.instanceId, ctx.phone).catch((error) => {
          auditError("Operator case flag push failed", error, { instanceId: ctx.instanceId, signalId, kind });
          return false;
        })
    : false;

  return {
    // WHY this is derived and not a constant: createOperatorCase is wrapped in a
    // .catch that returns null (Redis unreachable, hub refusing), and the action
    // used to stay "operator_case_created" regardless. instructions.ts and the
    // tool description both teach the model that operator_case_created means the
    // operator WAS notified, so on a Redis outage a guest with a real incident was
    // told a person is coming while no case, no panel SOS and no hub signal
    // existed (found 2026-08-22). The tool must report what actually happened.
    action: operatorCase ? "operator_case_created" : "escalation_failed",
    caseId: operatorCase?.id || null,
    operatorFlagged: flagged,
    queuedForChat: Boolean(operatorCase),
    escalationAvailable: Boolean(operatorCase),
    signaledToDle: false,
    signalId,
    mediaAttached: Boolean(media),
    sent: false,
    // The caller's own reply promises a human ("Шағымды админге жібердім, ол
    // тексеріп сізбен байланысады"). When the case could not be created that
    // promise is false, so an honest holding line is substituted instead - the
    // long-voice lane already did this by hand at whatsappWebhook.route.ts:832.
    customerReply: operatorCase
      ? (realFallbackIncident ? buildComplaintAckReply(ctx.language) : input.customerReply || buildComplaintAckReply(ctx.language))
      : buildEscalationUnavailableReply(ctx.language),
  };
}
