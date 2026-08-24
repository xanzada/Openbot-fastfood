import crypto from "node:crypto";

// "unknown" is not a kitchen state - it means we could not read one. It exists because
// classifyKitchenSalesPolicy(null) used to return "normal": every flag defaults to open,
// so a failed hub read was indistinguishable from a kitchen that had answered "we are
// open", and the bot kept selling through an emergency stop or outside work hours
// (reproduced 2026-08-23). The defaults are correct for a PARTIAL runtime - a hub object
// that omits a field means "not restricted", and toolPolicy relies on that - but wrong
// for no runtime at all.
export type KitchenSalesMode = "normal" | "busy" | "channel_limited" | "critical" | "vacation" | "indefinite" | "off_hours" | "unknown";

export type KitchenServiceChannel = "delivery" | "pickup";

export interface KitchenPolicyOptions {
  operatorWaitMinutes?: number;
  deliveryWaitMinutes?: number;
  pickupWaitMinutes?: number;
}

export interface OperatorWaitNotice {
  overall: number;
  delivery: number;
  pickup: number;
}

export interface KitchenConsentRequirement {
  kind: "none" | "delay" | "channel";
  channel?: KitchenServiceChannel;
}

function normalizedWait(value: unknown) {
  const minutes = Math.floor(Number(value) || 0);
  return Number.isFinite(minutes) && minutes > 0 && minutes <= 600 ? minutes : 0;
}

const DELIVERY_WORD_RE = /(достав|жеткіз|жеткиз|курьер|delivery)/iu;
const PICKUP_WORD_RE = /(самовывоз|алып\s*кет|өзім\s*алам|озим\s*алам|pickup|self[-\s]?pickup)/iu;
const WAIT_UNIT_RE = /(мин(?:ут)?|minutes?|час(?:а|ов)?|сағат|hours?)/iu;

// The panel's 60/120 presets arrive as ordinary notes. Parse them next to the
// policy so every deterministic gate sees the same delay as the prompt.
export function extractOperatorWaitNotice(notes: unknown): OperatorWaitNotice {
  const result: OperatorWaitNotice = { overall: 0, delivery: 0, pickup: 0 };
  for (const note of Array.isArray(notes) ? notes : []) {
    const text = String((note as any)?.text || "");
    if (!WAIT_UNIT_RE.test(text)) continue;
    // Attribution is per SENTENCE: "Доставка как обычно. Самовывоз - ожидание
    // 90 минут." must not let the word "Доставка" from the previous sentence
    // claim the pickup delay.
    const sentences = text.split(/(?<=[.!?\n])\s+/u).filter(Boolean);
    for (const sentence of sentences) {
      const delivery = DELIVERY_WORD_RE.test(sentence);
      const pickup = PICKUP_WORD_RE.test(sentence);
      for (const match of sentence.matchAll(/(\d{1,3}(?:\.\d+)?)\s*(мин(?:ут)?|minutes?|час(?:а|ов)?|сағат|hours?)/giu)) {
        const amount = Number(match[1]);
        const unit = String(match[2] || "").toLowerCase();
        const minutes = normalizedWait(/час|сағат|hour/.test(unit) ? amount * 60 : amount);
        if (!minutes) continue;
        if (delivery && !pickup) result.delivery = Math.max(result.delivery, minutes);
        else if (pickup && !delivery) result.pickup = Math.max(result.pickup, minutes);
        else result.overall = Math.max(result.overall, minutes);
      }
    }
  }
  return result;
}

export function kitchenPolicyOptionsFromNotes(notes: unknown): KitchenPolicyOptions {
  const notice = extractOperatorWaitNotice(notes);
  return {
    operatorWaitMinutes: notice.overall,
    deliveryWaitMinutes: notice.delivery,
    pickupWaitMinutes: notice.pickup,
  };
}

export function consentRequirement(policy: KitchenSalesPolicy, channel: KitchenServiceChannel | "unknown" = "unknown"): KitchenConsentRequirement {
  if (channel === "delivery") {
    if (policy.deliveryBlocksSales) return { kind: "channel", channel };
    return policy.requiresDeliveryConsent ? { kind: "delay", channel } : { kind: "none" };
  }
  if (channel === "pickup") {
    if (policy.pickupBlocksSales) return { kind: "channel", channel };
    return policy.requiresPickupConsent ? { kind: "delay", channel } : { kind: "none" };
  }
  const deliveryNeedsDecision = policy.deliveryBlocksSales || policy.requiresDeliveryConsent;
  const pickupNeedsDecision = policy.pickupBlocksSales || policy.requiresPickupConsent;
  if (deliveryNeedsDecision !== pickupNeedsDecision) return { kind: "channel" };
  if (policy.requiresDeliveryConsent && policy.requiresPickupConsent) {
    return policy.deliveryWaitMinutes === policy.pickupWaitMinutes ? { kind: "delay" } : { kind: "channel" };
  }
  return { kind: "none" };
}

export type KitchenConsentDecision =
  | { action: "pass" }
  | { action: "ask_channel" }
  | { action: "ask_delay"; channel: KitchenServiceChannel | "unknown" }
  | { action: "accept"; channel: KitchenServiceChannel | "unknown" }
  | { action: "decline" }
  | { action: "clarify" }
  | { action: "unavailable"; channel: KitchenServiceChannel };

export function decideKitchenConsent(options: {
  policy: KitchenSalesPolicy;
  text?: string;
  channel?: KitchenServiceChannel | "unknown";
  orderingIntent?: boolean;
  pendingKind?: "delay" | "channel" | "delay_and_channel" | null;
  pendingChannel?: KitchenServiceChannel | "unknown";
}): KitchenConsentDecision {
  const channel = options.channel || detectRequestedServiceChannel(options.text || "");
  if (options.pendingKind === "channel" && (options.pendingChannel || "unknown") === "unknown") {
    if (channel === "unknown") return { action: "ask_channel" };
    if (channel === "delivery" && options.policy.deliveryBlocksSales) return { action: "unavailable", channel };
    if (channel === "pickup" && options.policy.pickupBlocksSales) return { action: "unavailable", channel };
    return consentRequirement(options.policy, channel).kind === "delay"
      ? { action: "ask_delay", channel }
      : { action: "accept", channel };
  }
  if (options.pendingKind === "delay" || options.pendingKind === "delay_and_channel") {
    const answer = detectKitchenConsentAnswer(options.text || "");
    if (answer === "yes") return { action: "accept", channel: options.pendingChannel || channel };
    if (answer === "no") return { action: "decline" };
    return { action: "clarify" };
  }
  if (channel === "delivery" && options.policy.deliveryBlocksSales) return { action: "unavailable", channel };
  if (channel === "pickup" && options.policy.pickupBlocksSales) return { action: "unavailable", channel };
  if (!options.orderingIntent) return { action: "pass" };
  const requirement = consentRequirement(options.policy, channel);
  if (requirement.kind === "channel") return { action: "ask_channel" };
  if (requirement.kind === "delay") return { action: "ask_delay", channel };
  return { action: "pass" };
}

function asBool(value: unknown, fallback: boolean) {
  return typeof value === "boolean" ? value : fallback;
}

export interface KitchenSalesPolicy {
  mode: KitchenSalesMode;
  waitMinutes: number;
  deliveryWaitMinutes: number;
  pickupWaitMinutes: number;
  waitLabelKk: string;
  waitLabelRu: string;
  deliveryWaitLabelKk: string;
  deliveryWaitLabelRu: string;
  pickupWaitLabelKk: string;
  pickupWaitLabelRu: string;
  delivery: boolean;
  pickup: boolean;
  isEmergency: boolean;
  isAcceptingOrders: boolean;
  withinWorkHours: boolean;
  resetAt: number;
  remainingSeconds: number;
  remainingDays: number;
  requiresConsent: boolean;
  requiresDeliveryConsent: boolean;
  requiresPickupConsent: boolean;
  deliveryBlocksSales: boolean;
  pickupBlocksSales: boolean;
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

export function classifyKitchenSalesPolicy(
  runtime: Record<string, any> | null,
  nowMs = Date.now(),
  options: KitchenPolicyOptions = {},
): KitchenSalesPolicy {
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
  const runtimeWaitMinutes = Math.max(0, Math.floor(Number(runtime?.wait_time ?? kitchen.wait_time ?? 0) || 0));
  const overallWait = Math.max(runtimeWaitMinutes, normalizedWait(options.operatorWaitMinutes));
  const explicitDeliveryWait = normalizedWait(options.deliveryWaitMinutes);
  const explicitPickupWait = normalizedWait(options.pickupWaitMinutes);
  const deliveryWaitMinutes = explicitDeliveryWait || overallWait;
  const pickupWaitMinutes = explicitPickupWait || overallWait;
  const waitMinutes = Math.max(overallWait, deliveryWaitMinutes, pickupWaitMinutes);
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
  const deliveryBlocksSales = !delivery || deliveryWaitMinutes > 180;
  const pickupBlocksSales = !pickup || pickupWaitMinutes > 180;
  const requiresDeliveryConsent = stateKnown && !globalStop && delivery && !deliveryBlocksSales && deliveryWaitMinutes > 40;
  const requiresPickupConsent = stateKnown && !globalStop && pickup && !pickupBlocksSales && pickupWaitMinutes > 40;
  const requiresConsent = requiresDeliveryConsent || requiresPickupConsent;
  const reopeningKnown = resetAt > 0;
  const fingerprintSource = JSON.stringify({ mode, waitMinutes, deliveryWaitMinutes, pickupWaitMinutes, delivery, pickup, isEmergency, isAcceptingOrders, withinWorkHours, resetAt, stateKnown });

  return {
    mode,
    waitMinutes,
    deliveryWaitMinutes,
    pickupWaitMinutes,
    waitLabelKk: formatKitchenWait(waitMinutes, "kk"),
    waitLabelRu: formatKitchenWait(waitMinutes, "ru"),
    deliveryWaitLabelKk: formatKitchenWait(deliveryWaitMinutes, "kk"),
    deliveryWaitLabelRu: formatKitchenWait(deliveryWaitMinutes, "ru"),
    pickupWaitLabelKk: formatKitchenWait(pickupWaitMinutes, "kk"),
    pickupWaitLabelRu: formatKitchenWait(pickupWaitMinutes, "ru"),
    delivery,
    pickup,
    isEmergency,
    isAcceptingOrders,
    withinWorkHours,
    resetAt,
    remainingSeconds,
    remainingDays,
    requiresConsent,
    requiresDeliveryConsent,
    requiresPickupConsent,
    deliveryBlocksSales,
    pickupBlocksSales,
    blocksAllSales,
    reopeningKnown,
    stateKnown,
    closedReason,
    fingerprint: crypto.createHash("sha256").update(fingerprintSource).digest("hex"),
  };
}

export function classifyKitchenSalesPolicyForContext(
  runtime: Record<string, any> | null,
  notes: unknown,
  nowMs = Date.now(),
): KitchenSalesPolicy {
  return classifyKitchenSalesPolicy(runtime, nowMs, kitchenPolicyOptionsFromNotes(notes));
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
