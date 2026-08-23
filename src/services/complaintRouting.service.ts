import crypto from "node:crypto";
import type { FastFoodContext } from "../context/types.js";
import {
  clearComplaintMedia,
  getComplaintMedia,
  markComplaintClarificationPending,
  saveCaseMedia,
  takeComplaintClarification,
} from "./redis.service.js";
import { bumpOperatorCaseSignal, createOperatorCase, detectOperatorCaseKind, getActiveOperatorCaseId } from "./operatorCase.service.js";
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
  /(шағым|жалоб|претензи|волос|шаш(?!л)|гряз|лас(?!с)|суық|суык|холодн|испорч|бұзыл|бузыл|улан|отрав|не тот заказ|чужой заказ|басқа (?:тапсырыс|заказ)|қате (?:тапсырыс|заказ)|не привезли|жетпей|не хватает|дөрек|груб|сапа|качест)/iu;
const ACTIONABLE_SERVICE_INCIDENT_RE =
  /(заказ|тапсырыс).{0,40}(опозд|задерж|кешік|кешіг|не\s+(?:приехал|доставлен|привезли)|келмед|жеткізілмед)/iu;
const CONCRETE_COMPLAINT_DETAIL_RE =
  /(волос|шаш(?!л)|гряз|лас(?!с)|суық|суык|холодн|испорч|бұзыл|бузыл|улан|отрав|не тот заказ|чужой заказ|басқа (?:тапсырыс|заказ)|қате (?:тапсырыс|заказ)|не привезли|жетпей|не хватает|курьер.{0,30}(?:дөрек|груб)|(?:дөрек|груб).{0,30}курьер)/iu;

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

function getOrderLabel(ctx: FastFoodContext) {
  return cleanLine(ctx.activeOrder?.order_id || ctx.activeOrder?.id || ctx.activeOrder?.orderId || "not_found", 80);
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

export function isLikelyComplaintText(text = "") {
  const value = String(text || "");
  return intentMatches(COMPLAINT_RE, value) || intentMatches(ACTIONABLE_SERVICE_INCIDENT_RE, value);
}

export function isLikelyOperatorRequestText(text = "") {
  return Boolean(detectOperatorCaseKind(text));
}

// "Шағым бар" tells an operator nothing. A complaint that already names what
// went wrong goes straight through; a bare one earns a single question first,
// so the case that reaches the operator is worth reading.
export function complaintHasActionableDetail(text = "") {
  const clean = String(text || "").replace(/\s+/g, " ").trim();
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

// SOS is the last resort, not the opening move: a bare "оператор шақыр", a courier-number
// ask or an unexplained complaint earns ONE clarifying question first. The case
// is created from the guest's answer, from a message that already carries the
// story, or from photo evidence - never from a bare demand (2026-08-20).
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

export async function routeComplaintToAdmin(ctx: FastFoodContext, input: ComplaintRoutingInput) {
  const savedMedia = await getComplaintMedia(ctx.instanceId, ctx.phone).catch(() => null);
  const media = toWhatsProMedia(input.media || (savedMedia as ComplaintMediaPayload | null));

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
  const menuSkipApplies = !media
    && !savedMedia?.base64
    && input.source !== "cancel_request"
    && input.source !== "media_analysis"
    && input.source !== "long_voice"
    // A payment shortfall is a measured amount, not a sentence to classify. The
    // guest's caption on the receipt photo often mentions a dish, and reading that
    // as a menu question would silently drop an underpayment (found 2026-08-23).
    && input.source !== "payment_shortfall";
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
      customerReply: input.customerReply || "",
    };
  }
  // 2026-08-21 live defect: the AI tool lane opened a case - and fired SOS to
  // the panel and the site - on the model's first impulse. A bare
  // "оператормен сөйлесейін" in the middle of smalltalk became a red SOS whose
  // summary literally read "мақсат=smalltalk" (case oc_1787323244566). The
  // webhook lane has had the clarify-first gate since 2026-08-20, but the tool
  // calls this function directly, before that gate runs. The gate now lives at
  // the choke point too: a bare demand earns ONE clarifying question, and only
  // the guest's answer, a message that already carries the story, or photo
  // evidence creates the case. The other lanes (webhook text lane, cancel
  // flow, media analysis, long voice) keep their own sources and never match
  // this one, so nobody is gated twice. An already-open case is never
  // re-questioned: the guest is mid-escalation, not a new bare demand.
  if (input.source === "ai_tool_escalate_to_admin") {
    const guestText = input.customerText || ctx.text || "";
    const clarifyKind = detectOperatorCaseKind(guestText);
    const hasActionableStory = complaintHasActionableDetail(guestText);
    if (!hasActionableStory && !media && clarifyKind !== "cancel_request") {
      const openCaseId = await getActiveOperatorCaseId(ctx.instanceId, ctx.phone).catch(() => null);
      if (!openCaseId) {
        const firstDemand = await takeComplaintClarification(ctx.instanceId, ctx.phone).catch(() => null);
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
        // The guest answered the clarifying question (or insists on a human):
        // fold the original bare demand into the story the operator reads, the
        // same way the webhook lane does, and open the case now.
        input = { ...input, summary: [firstDemand, input.summary].filter(Boolean).join(" — ") };
      }
    }
  }
  const summary = cleanLine(input.summary || input.customerText || ctx.text || "Customer complaint requires review.");
  const urgency = input.urgency || "normal";
  const detectedKind = detectOperatorCaseKind(input.customerText || ctx.text);
  const kind = input.source === "long_voice" ? "long_voice" : detectedKind || "complaint";
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
  const flagged = operatorCase
    ? await bumpOperatorCaseSignal(ctx.instanceId, ctx.phone).catch((error) => {
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
      ? (input.customerReply || buildComplaintAckReply(ctx.language))
      : buildEscalationUnavailableReply(ctx.language),
  };
}
