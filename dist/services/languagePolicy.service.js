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
// Kazakh and Russian given names carry a reliable language signal, and for a
// guest who arrives straight on WhatsApp with a two-word message the contact
// name is often the only signal available. Only unambiguous markers count;
// anything else returns null so a weaker signal can decide instead.
const KAZAKH_NAME_RE = /[\u04d9\u0493\u049b\u04a3\u04e9\u04b1\u04af\u04bb\u0456]|(?:\u0431\u0435\u043a|\u0436\u0430\u043d|\u0433\u0443\u043b|\u0433\u04af\u043b|\u0431\u0430\u0439|\u0445\u0430\u043d|\u0442\u0430\u0439|\u043d\u0443\u0440|\u043d\u04b1\u0440|\u0430\u0439|\u0435\u0440|\u0436\u04b1\u043c|\u0441\u0435\u0440\u0456\u043a|bek|zhan|jan|gul|nur|ai|yer|bay)(?![\p{L}])/iu;
const RUSSIAN_NAME_RE = /(?:\u043e\u0432|\u0435\u0432|\u0438\u043d|\u0441\u043a\u0438\u0439|\u0441\u043a\u0430\u044f|\u043e\u0432\u043d\u0430|\u043e\u0432\u0438\u0447)(?![\p{L}])|^(?:\u0430\u043b\u0435\u043a\u0441\u0430\u043d\u0434\u0440|\u0441\u0435\u0440\u0433\u0435\u0439|\u0430\u043d\u0434\u0440\u0435\u0439|\u0434\u043c\u0438\u0442\u0440|\u0435\u043b\u0435\u043d|\u043e\u043b\u044c\u0433|\u043d\u0430\u0442\u0430\u043b|\u0438\u0440\u0438\u043d|\u0442\u0430\u0442\u044c\u044f\u043d|\u0441\u0432\u0435\u0442\u043b|\u0432\u043b\u0430\u0434\u0438\u043c|\u043c\u0430\u043a\u0441\u0438\u043c|\u043d\u0438\u043a\u043e\u043b|\u043f\u0430\u0432\u0435\u043b|\u0430\u043d\u043d|\u043c\u0430\u0440\u0438|\u044e\u043b\u0438|\u0432\u0430\u0434\u0438\u043c|\u0435\u0433\u043e\u0440|\u0430\u0440\u0442\u0435\u043c|\u0430\u0440\u0442\u0451\u043c)/iu;
export function detectNameLanguage(name) {
    const clean = String(name || "").trim().toLowerCase();
    if (clean.length < 3 || !/[\p{L}]/u.test(clean))
        return null;
    if (KAZAKH_NAME_RE.test(clean))
        return "kk";
    if (RUSSIAN_NAME_RE.test(clean))
        return "ru";
    return null;
}
// A guest who never came through the site has no saved language: the 24-hour
// lock belongs to site-originated conversations only. Every other turn is
// decided again, strongest signal first, so switching language mid-dialog works
// immediately and a returning guest still keeps the language they always used.
export function resolveOrganicLanguage(input) {
    if (input.detected)
        return { language: input.detected, source: "message" };
    if (input.priorLanguage)
        return { language: input.priorLanguage, source: "history" };
    const nameLanguage = detectNameLanguage(input.contactName);
    if (nameLanguage)
        return { language: nameLanguage, source: "contact_name" };
    if (input.siteLanguageHint)
        return { language: input.siteLanguageHint, source: "site_hint" };
    return { language: "kk", source: "default" };
}
