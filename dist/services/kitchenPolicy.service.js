import crypto from "node:crypto";
function asBool(value, fallback) {
  return typeof value === "boolean" ? value : fallback;
}
function formatKitchenWait(minutesValue, language) {
  const minutes = Math.max(0, Math.floor(Number(minutesValue) || 0));
  const hours = Math.floor(minutes / 60);
  const rest = minutes % 60;
  if (!hours) return `${minutes} \u043C\u0438\u043D\u0443\u0442`;
  if (!rest) return language === "kk" ? `${hours} \u0441\u0430\u0493\u0430\u0442` : `${hours} ${hours === 1 ? "\u0447\u0430\u0441" : hours < 5 ? "\u0447\u0430\u0441\u0430" : "\u0447\u0430\u0441\u043E\u0432"}`;
  return language === "kk" ? `${hours} \u0441\u0430\u0493\u0430\u0442 ${rest} \u043C\u0438\u043D\u0443\u0442` : `${hours} ${hours === 1 ? "\u0447\u0430\u0441" : hours < 5 ? "\u0447\u0430\u0441\u0430" : "\u0447\u0430\u0441\u043E\u0432"} ${rest} \u043C\u0438\u043D\u0443\u0442`;
}
function classifyKitchenSalesPolicy(runtime, nowMs = Date.now()) {
  const kitchen = runtime?.kitchen_status && typeof runtime.kitchen_status === "object" ? runtime.kitchen_status : {};
  const waitMinutes = Math.max(0, Math.floor(Number(runtime?.wait_time ?? kitchen.wait_time ?? 0) || 0));
  const delivery = asBool(runtime?.delivery ?? kitchen.delivery, true);
  const pickup = asBool(runtime?.pickup ?? kitchen.pickup, true);
  const isEmergency = asBool(runtime?.is_emergency ?? kitchen.is_emergency, false);
  const isAcceptingOrders = asBool(runtime?.is_accepting_orders, true);
  const withinWorkHours = asBool(runtime?.within_work_hours, true);
  const resetAt = Math.max(0, Math.floor(Number(runtime?.reset_at ?? kitchen.reset_at ?? 0) || 0));
  const nowSeconds = Math.floor(nowMs / 1e3);
  const remainingSeconds = resetAt > nowSeconds ? resetAt - nowSeconds : 0;
  const remainingDays = remainingSeconds > 0 ? Math.ceil(remainingSeconds / 86400) : 0;
  const globalStop = isEmergency || !isAcceptingOrders || !withinWorkHours || !delivery && !pickup;
  const activeRestriction = globalStop || waitMinutes > 40;
  let mode = "normal";
  if (activeRestriction && resetAt === 0) mode = "indefinite";
  else if (activeRestriction && remainingSeconds >= 86400) mode = "vacation";
  else if (globalStop || waitMinutes > 180) mode = "critical";
  else if (waitMinutes >= 41 && waitMinutes <= 180) mode = "busy";
  else if (delivery !== pickup) mode = "channel_limited";
  const blocksAllSales = mode === "critical" || mode === "vacation" || mode === "indefinite";
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
    fingerprint: crypto.createHash("sha256").update(fingerprintSource).digest("hex")
  };
}
function detectKitchenConsentAnswer(text = "") {
  const value = String(text || "").toLowerCase().replace(/[.,!?;:]+/g, " ").replace(/\s+/g, " ").trim();
  if (/(^|\s)(жоқ|жок|керек емес|күтпеймін|кутпеймин|нет|не надо|не буду ждать|отмена|рахмет жоқ|спасибо нет)(\s|$)/iu.test(value)) return "no";
  if (/(^|\s)(иә|ия|иа|жарайды|келісемін|келисемин|күте аламын|куте аламын|күтемін|кутемин|да|хорошо|согласен|согласна|подожду|буду ждать)(\s|$)/iu.test(value)) return "yes";
  return "unknown";
}
function detectRequestedServiceChannel(text = "") {
  const value = String(text || "");
  if (/(самовывоз|алып\s*кет|өзім\s*алам|озим\s*алам|pickup)/iu.test(value)) return "pickup";
  if (/(достав|жеткіз|жеткиз|курьер|delivery)/iu.test(value)) return "delivery";
  return "unknown";
}
export {
  classifyKitchenSalesPolicy,
  detectKitchenConsentAnswer,
  detectRequestedServiceChannel,
  formatKitchenWait
};
