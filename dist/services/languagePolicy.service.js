export function shouldSwitchLockedLanguage(lockedLanguage, previousCustomerLanguage, currentCustomerLanguage) {
    return currentCustomerLanguage !== lockedLanguage && previousCustomerLanguage === currentCustomerLanguage;
}
export function normalizeSiteLanguage(value) {
    const normalized = String(value || "").trim().toLowerCase();
    if (normalized === "ru")
        return "ru";
    if (normalized === "kk" || normalized === "kz")
        return "kk";
    return null;
}
export function resolveSiteOutboundLanguage(lockedLanguage, payloadLanguage, siteLanguageHint) {
    return lockedLanguage || payloadLanguage || siteLanguageHint || "kk";
}
