import crypto from "node:crypto";
import type { FastFoodContext } from "../context/types.js";
import { clearComplaintMedia, getComplaintMedia } from "./redis.service.js";
import { getRestaurantConfig } from "./nocodb.service.js";
import { sendWhatsProMessage } from "../transport/whatspro.client.js";
import { createOperatorCase, detectOperatorCaseKind } from "./operatorCase.service.js";
import { sendOperatorSosSignal } from "./dle.service.js";
import { auditError } from "./auditLogger.service.js";

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
  /(шағым|жалоб|претензи|волос|шаш|гряз|лас|суық|суык|холодн|испорч|бұзыл|бузыл|улан|отрав|не тот заказ|басқа тапсырыс|қате тапсырыс|не привезли|жетпей|не хватает|сапа|качест)/iu;

function normalizePhone(value = "") {
  return String(value || "").replace(/\D/g, "");
}

function cleanLine(value: unknown, max = 700) {
  return String(value || "")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, max);
}

function getAdminPhone(config: Record<string, any> = {}) {
  return normalizePhone(
    config.admin_phone ||
      config.admin ||
      config.manager_phone ||
      config.operator_phone ||
      config.complaint_phone ||
      process.env.ADMIN_PHONE ||
      ""
  );
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
  return COMPLAINT_RE.test(String(text || ""));
}

export function isLikelyOperatorRequestText(text = "") {
  return Boolean(detectOperatorCaseKind(text));
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
  const liveConfig = (await getRestaurantConfig(ctx.instanceId).catch(() => null)) || {};
  const adminPhone = getAdminPhone(liveConfig);
  const savedMedia = await getComplaintMedia(ctx.instanceId, ctx.phone).catch(() => null);
  const media = toWhatsProMedia(input.media || (savedMedia as ComplaintMediaPayload | null));
  const summary = cleanLine(input.summary || input.customerText || ctx.text || "Customer complaint requires review.");
  const customerText = cleanLine(input.customerText || ctx.text || "", 900);
  const urgency = input.urgency || "normal";
  const detectedKind = detectOperatorCaseKind(input.customerText || ctx.text);
  const kind = input.source === "long_voice" ? "long_voice" : detectedKind || "complaint";
  const signalId = `sos_${Date.now()}_${crypto.randomBytes(4).toString("hex")}`;
  const domain = cleanLine(liveConfig.domain || ctx.config?.domain || "", 255);
  const [chatSignal, dleSignal] = await Promise.allSettled([
    createOperatorCase({
      instanceId: ctx.instanceId, phone: ctx.phone, kind, summary, source: input.source, urgency,
      orderNumber: getOrderLabel(ctx), hasMedia: Boolean(media), signalId,
    }),
    domain
      ? sendOperatorSosSignal({ instanceId: ctx.instanceId, phone: ctx.phone, domain, signalId, kind, summary, urgency, source: input.source })
      : Promise.reject(new Error("DLE_DOMAIN_NOT_CONFIGURED")),
  ]);
  const operatorCase = chatSignal.status === "fulfilled" ? chatSignal.value : null;
  const dleNotified = dleSignal.status === "fulfilled";
  if (chatSignal.status === "rejected") auditError("WhatsPro SOS signal failed", chatSignal.reason, { instanceId: ctx.instanceId, signalId, kind });
  if (dleSignal.status === "rejected") auditError("DLE operator SOS signal failed", dleSignal.reason, { instanceId: ctx.instanceId, signalId, kind });

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

  let sent: any = null;
  if (adminPhone) {
    sent = await sendWhatsProMessage({ instanceId: ctx.instanceId, phone: adminPhone, text: adminText, media }).catch(() => null);
    if (savedMedia?.base64) {
      await clearComplaintMedia(ctx.instanceId, ctx.phone).catch(() => undefined);
    }
  }

  return {
    action: "operator_case_created",
    caseId: operatorCase?.id || null,
    queuedForChat: Boolean(operatorCase),
    escalationAvailable: Boolean(operatorCase || dleNotified || adminPhone),
    signaledToDle: dleNotified,
    signalId,
    mediaAttached: Boolean(media),
    sent: Boolean(sent?.acknowledged),
    customerReply: input.customerReply || buildComplaintAckReply(ctx.language),
  };
}
