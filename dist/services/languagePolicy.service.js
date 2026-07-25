function normalizeSiteLanguage(value) {
  const normalized = String(value || "").trim().toLowerCase();
  if (normalized === "ru") return "ru";
  if (normalized === "kk" || normalized === "kz") return "kk";
  return null;
}
function resolveSiteOutboundLanguage(lockedLanguage, payloadLanguage, siteLanguageHint) {
  return lockedLanguage || payloadLanguage || siteLanguageHint || "kk";
}
export {
  normalizeSiteLanguage,
  resolveSiteOutboundLanguage
};
