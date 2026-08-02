import crypto from "node:crypto";
import type { FastFoodContext } from "../context/types.js";
import { clearComplaintMedia, getComplaintMedia } from "./redis.service.js";
import { createOperatorCase, detectOperatorCaseKind } from "./operatorCase.service.js";
import { auditError } from "./auditLogger.service.js";
import { intentMatches } from "../utils/intentText.js";

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
  /(шағым|жалоб|претензи|волос|шаш|гряз|лас|суық|суык|холодн|испорч|бұзыл|бузыл|улан|отрав|не тот заказ|чужой заказ|басқа (?:тапсырыс|заказ)|қате (?:тапсырыс|заказ)|не привезли|жетпей|не хватает|дөрек|груб|сапа|качест)/iu;
const ACTIONABLE_SERVICE_INCIDENT_RE =
  /(заказ|тапсырыс).{0,40}(опозд|задерж|кешік|кешіг|не\s+(?:приехал|доставлен|привезли)|келмед|жеткізілмед)/iu;
const CONCRETE_COMPLAINT_DETAIL_RE =
  /(волос|шаш|гряз|лас|суық|суык|холодн|испорч|бұзыл|бузыл|улан|отрав|не тот заказ|чужой заказ|басқа (?:тапсырыс|заказ)|қате (?:тапсырыс|заказ)|не привезли|жетпей|не хватает|курьер.{0,30}(?:дөрек|груб)|(?:дөрек|груб).{0,30}курьер)/iu;

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

export async function hasPendingComplaintMedia(instanceId: string, phone: string): Promise<boolean> {
  const media = await getComplaintMedia(instanceId, phone).catch(() => null);
  return Boolean(media?.base64);
}

export async function routeComplaintToAdmin(ctx: FastFoodContext, input: ComplaintRoutingInput) {
  const savedMedia = await getComplaintMedia(ctx.instanceId, ctx.phone).catch(() => null);
  const media = toWhatsProMedia(input.media || (savedMedia as ComplaintMediaPayload | null));
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

  if (savedMedia?.base64 && operatorCase) {
    await clearComplaintMedia(ctx.instanceId, ctx.phone).catch(() => undefined);
  }

  return {
    action: "operator_case_created",
    caseId: operatorCase?.id || null,
    queuedForChat: Boolean(operatorCase),
    escalationAvailable: Boolean(operatorCase),
    signaledToDle: false,
    signalId,
    mediaAttached: Boolean(media),
    sent: false,
    customerReply: input.customerReply || buildComplaintAckReply(ctx.language),
  };
}
