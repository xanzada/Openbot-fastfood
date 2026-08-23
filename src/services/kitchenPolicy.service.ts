import crypto from "node:crypto";

// "unknown" is not a kitchen state - it means we could not read one. It exists because
// classifyKitchenSalesPolicy(null) used to return "normal": every flag defaults to open,
// so a failed hub read was indistinguishable from a kitchen that had answered "we are
// open", and the bot kept selling through an emergency stop or outside work hours
// (reproduced 2026-08-23). The defaults are correct for a PARTIAL runtime - a hub object
// that omits a field means "not restricted", and toolPolicy relies on that - but wrong
// for no runtime at all.
export type KitchenSalesMode = "normal" | "busy" | "channel_limited" | "critical" | "vacation" | "indefinite" | "off_hours" | "unknown";

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
  // False only when there was no runtime object at all. Callers that must not act on a
  // guess - the checkout gate, the facts prompt - read this instead of inferring
  // openness from the defaulted flags.
  stateKnown: boolean;
  // Why the kitchen is closed, straight from the hub (service_channels_disabled,
  // outside_work_hours, emergency_stop, ...). dle.service has always normalised this and
  // the Redis fallback derives it, but the policy used to drop it - so every closed state
  // was answered with "по важной технической причине", which is false for all of them
  // except an emergency stop, and tells the guest nothing to do (found 2026-08-23).
  closedReason: string;
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

// The reason can arrive at the top level or nested under kitchen_status, exactly like
// every other field here.
function kitchenSource(runtime: Record<string, any> | null) {
  const nested = runtime?.kitchen_status;
  return nested && typeof nested === "object" ? nested : null;
}

export function classifyKitchenSalesPolicy(runtime: Record<string, any> | null, nowMs = Date.now()): KitchenSalesPolicy {
  // The absence of an answer is not an answer of "open". Two shapes mean "we could not
  // read the kitchen": no object at all (buildFactsPrompt passes ctx.runtimeStatus,
  // which preloadContext sets to null when the hub read fails), and an object that says
  // so - hardRealtimeContext is always built, and carries
  // runtime_available: Boolean(runtimeStatus) for exactly this reason.
  const stateKnown = Boolean(runtime && typeof runtime === "object")
    && (runtime as Record<string, any>).runtime_available !== false;
  const closedReason = String(
    runtime?.closed_reason ?? kitchenSource(runtime)?.closed_reason ?? ""
  ).trim().slice(0, 120);
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

  // Deliberately NOT blocking on an unknown state. Telling guests a working kitchen is
  // closed because one hub read timed out would trade a rare wrong sale for a constant
  // wrong refusal - the earlier "reset_at defaults to 0" fix learned that at 41 minutes.
  // What changes is that "unknown" is reported as unknown, so the facts prompt tells the
  // model to confirm with getKitchenStatus before it commits to an order, instead of
  // being handed "normal" as a fact.
  if (!stateKnown) mode = "unknown";
  const blocksAllSales = mode === "critical" || mode === "vacation" || mode === "indefinite" || mode === "off_hours";
  const requiresConsent = mode === "busy";
  const reopeningKnown = resetAt > 0;
  const fingerprintSource = JSON.stringify({ mode, waitMinutes, delivery, pickup, isEmergency, isAcceptingOrders, withinWorkHours, resetAt, stateKnown });

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
    stateKnown,
    closedReason,
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
