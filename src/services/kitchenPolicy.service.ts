import crypto from "node:crypto";

export type KitchenSalesMode = "normal" | "busy" | "channel_limited" | "critical" | "vacation" | "indefinite" | "off_hours";

export interface KitchenSalesPolicy {
  mode: KitchenSalesMode;
  waitMinutes: number;
  waitLabelKk: string;
  waitLabelRu: string;
  delivery: boolean;
  pickup: boolean;
  isEmergency: boolean;
  isAcceptingOrders: boolean;
  withinWorkHours: boolean;
  resetAt: number;
  remainingSeconds: number;
  remainingDays: number;
  requiresConsent: boolean;
  blocksAllSales: boolean;
  reopeningKnown: boolean;
  fingerprint: string;
}

function asBool(value: unknown, fallback: boolean) {
  return typeof value === "boolean" ? value : fallback;
}

export function formatKitchenWait(minutesValue: unknown, language: "kk" | "ru") {
  const minutes = Math.max(0, Math.floor(Number(minutesValue) || 0));
  const hours = Math.floor(minutes / 60);
  const rest = minutes % 60;
  if (!hours) return `${minutes} минут`;
  if (!rest) return language === "kk" ? `${hours} сағат` : `${hours} ${hours === 1 ? "час" : hours < 5 ? "часа" : "часов"}`;
  return language === "kk"
    ? `${hours} сағат ${rest} минут`
    : `${hours} ${hours === 1 ? "час" : hours < 5 ? "часа" : "часов"} ${rest} минут`;
}

export function classifyKitchenSalesPolicy(runtime: Record<string, any> | null, nowMs = Date.now()): KitchenSalesPolicy {
  const kitchen = runtime?.kitchen_status && typeof runtime.kitchen_status === "object" ? runtime.kitchen_status : {};
  const waitMinutes = Math.max(0, Math.floor(Number(runtime?.wait_time ?? kitchen.wait_time ?? 0) || 0));
  const delivery = asBool(runtime?.delivery ?? kitchen.delivery, true);
  const pickup = asBool(runtime?.pickup ?? kitchen.pickup, true);
  const isEmergency = asBool(runtime?.is_emergency ?? kitchen.is_emergency, false);
  const isAcceptingOrders = asBool(runtime?.is_accepting_orders, true);
  const withinWorkHours = asBool(runtime?.within_work_hours, true);
  const resetAt = Math.max(0, Math.floor(Number(runtime?.reset_at ?? kitchen.reset_at ?? 0) || 0));
  const nowSeconds = Math.floor(nowMs / 1000);
  const remainingSeconds = resetAt > nowSeconds ? resetAt - nowSeconds : 0;
  const remainingDays = remainingSeconds > 0 ? Math.ceil(remainingSeconds / 86400) : 0;
  const globalStop = isEmergency || !isAcceptingOrders || !withinWorkHours || (!delivery && !pickup);

  // indefinite and vacation describe a closed restaurant, not a slow one. A long
  // queue is something the guest can decide about, so it stays sellable and asks
  // for consent whether or not a reopening time was entered -- reset_at defaults
  // to 0, and treating that as a shutdown silently killed sales at 41 minutes.
  // Past 180 the wait stops being a queue at all, so it blocks like before.
  let mode: KitchenSalesMode = "normal";
  // Being closed for the night is not a fault, and every closed state used to
  // share one reply that blamed "a technical reason" - a guest writing at 03:00
  // was told the restaurant was broken (audit, 2026-08-12). Off-hours is its own
  // mode so the honest sentence can be said. A closure longer than a day is still
  // a vacation, whichever side of the clock it starts on.
  if (globalStop && remainingSeconds >= 86400) mode = "vacation";
  else if (!withinWorkHours) mode = "off_hours";
  else if (globalStop && resetAt === 0) mode = "indefinite";
  else if (globalStop || waitMinutes > 180) mode = "critical";
  else if (waitMinutes > 40) mode = "busy";
  else if (delivery !== pickup) mode = "channel_limited";

  const blocksAllSales = mode === "critical" || mode === "vacation" || mode === "indefinite" || mode === "off_hours";
  const requiresConsent = mode === "busy";
  const reopeningKnown = resetAt > 0;
  const fingerprintSource = JSON.stringify({ mode, waitMinutes, delivery, pickup, isEmergency, isAcceptingOrders, withinWorkHours, resetAt });

  return {
    mode,
    waitMinutes,
    waitLabelKk: formatKitchenWait(waitMinutes, "kk"),
    waitLabelRu: formatKitchenWait(waitMinutes, "ru"),
    delivery,
    pickup,
    isEmergency,
    isAcceptingOrders,
    withinWorkHours,
    resetAt,
    remainingSeconds,
    remainingDays,
    requiresConsent,
    blocksAllSales,
    reopeningKnown,
    fingerprint: crypto.createHash("sha256").update(fingerprintSource).digest("hex"),
  };
}

export function detectKitchenConsentAnswer(text = ""): "yes" | "no" | "unknown" {
  const value = String(text || "").toLowerCase().replace(/[.,!?;:]+/g, " ").replace(/\s+/g, " ").trim();
  if (/(^|\s)(жоқ|жок|керек емес|күтпеймін|кутпеймин|нет|не надо|не буду ждать|отмена|рахмет жоқ|спасибо нет)(\s|$)/iu.test(value)) return "no";
  if (/(^|\s)(иә|ия|иа|жарайды|келісемін|келисемин|күте аламын|куте аламын|күтемін|кутемин|да|хорошо|согласен|согласна|подожду|буду ждать|мхм|м-м|угу|ага|мм+)(\s|$)/iu.test(value)) return "yes";
  return "unknown";
}

export function detectRequestedServiceChannel(text = ""): "delivery" | "pickup" | "unknown" {
  const value = String(text || "");
  if (/(самовывоз|алып\s*кет|өзім\s*алам|озим\s*алам|pickup)/iu.test(value)) return "pickup";
  if (/(достав|жеткіз|жеткиз|курьер|delivery)/iu.test(value)) return "delivery";
  return "unknown";
}
