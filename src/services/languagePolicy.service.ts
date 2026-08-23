export type CustomerLanguage = "kk" | "ru";

// Letters and words that only one of the two languages uses. A message carrying
// them is not a guess, so making the guest repeat themselves before being
// answered in their own language would be rude.
const DECISIVE_KAZAKH = /[әғқңөұүһі]/u;
const DECISIVE_RUSSIAN = /(?:здравствуй|привет|пожалуйста|спасибо|хочу|можно|сколько|доставка|заказыва|давайте|ещё|еще раз)/iu;

export function textCarriesDecisiveLanguageSignal(text: unknown, language: CustomerLanguage) {
  const value = String(text || "").toLowerCase();
  if (!value.trim()) return false;
  if (language === "kk") return DECISIVE_KAZAKH.test(value);
  return !DECISIVE_KAZAKH.test(value) && DECISIVE_RUSSIAN.test(value);
}

export function shouldSwitchLockedLanguage(
  lockedLanguage: CustomerLanguage,
  previousCustomerLanguage: CustomerLanguage | null,
  currentCustomerLanguage: CustomerLanguage,
  currentTextIsDecisive = false
) {
  if (currentCustomerLanguage === lockedLanguage) return false;
  // One unmistakable message is enough; anything weaker still waits for a second
  // message in the same language so a single foreign word cannot flip the lock.
  if (currentTextIsDecisive) return true;
  return previousCustomerLanguage === currentCustomerLanguage;
}

export function normalizeSiteLanguage(value: unknown): CustomerLanguage | null {
  const normalized = String(value || "").trim().toLowerCase();
  if (normalized === "ru") return "ru";
  if (normalized === "kk" || normalized === "kz") return "kk";
  return null;
}

export function resolveSiteOutboundLanguage(
  lockedLanguage: CustomerLanguage | null | undefined,
  payloadLanguage: CustomerLanguage | null | undefined,
  siteLanguageHint: CustomerLanguage | null | undefined
): CustomerLanguage {
  return lockedLanguage || payloadLanguage || siteLanguageHint || "kk";
}

// Kazakh and Russian given names carry a reliable language signal, and for a
// guest who arrives straight on WhatsApp with a two-word message the contact
// name is often the only signal available. Only unambiguous markers count;
// anything else returns null so a weaker signal can decide instead.
const KAZAKH_NAME_RE =
  /[\u04d9\u0493\u049b\u04a3\u04e9\u04b1\u04af\u04bb\u0456]|(?:\u0431\u0435\u043a|\u0436\u0430\u043d|\u0433\u0443\u043b|\u0433\u04af\u043b|\u0431\u0430\u0439|\u0445\u0430\u043d|\u0442\u0430\u0439|\u043d\u0443\u0440|\u043d\u04b1\u0440|\u0430\u0439|\u0435\u0440|\u0436\u04b1\u043c|\u0441\u0435\u0440\u0456\u043a|bek|zhan|jan|gul|nur|ai|yer|bay)(?![\p{L}])/iu;
const RUSSIAN_NAME_RE =
  /(?:\u043e\u0432|\u0435\u0432|\u0438\u043d|\u0441\u043a\u0438\u0439|\u0441\u043a\u0430\u044f|\u043e\u0432\u043d\u0430|\u043e\u0432\u0438\u0447)(?![\p{L}])|^(?:\u0430\u043b\u0435\u043a\u0441\u0430\u043d\u0434\u0440|\u0441\u0435\u0440\u0433\u0435\u0439|\u0430\u043d\u0434\u0440\u0435\u0439|\u0434\u043c\u0438\u0442\u0440|\u0435\u043b\u0435\u043d|\u043e\u043b\u044c\u0433|\u043d\u0430\u0442\u0430\u043b|\u0438\u0440\u0438\u043d|\u0442\u0430\u0442\u044c\u044f\u043d|\u0441\u0432\u0435\u0442\u043b|\u0432\u043b\u0430\u0434\u0438\u043c|\u043c\u0430\u043a\u0441\u0438\u043c|\u043d\u0438\u043a\u043e\u043b|\u043f\u0430\u0432\u0435\u043b|\u0430\u043d\u043d|\u043c\u0430\u0440\u0438|\u044e\u043b\u0438|\u0432\u0430\u0434\u0438\u043c|\u0435\u0433\u043e\u0440|\u0430\u0440\u0442\u0435\u043c|\u0430\u0440\u0442\u0451\u043c)/iu;

export function detectNameLanguage(name: unknown): CustomerLanguage | null {
  const clean = String(name || "").trim().toLowerCase();
  if (clean.length < 3 || !/[\p{L}]/u.test(clean)) return null;
  if (KAZAKH_NAME_RE.test(clean)) return "kk";
  if (RUSSIAN_NAME_RE.test(clean)) return "ru";
  return null;
}

// A guest who never came through the site has no saved language: the 24-hour
// lock belongs to site-originated conversations only. Every other turn is
// decided again, strongest signal first, so switching language mid-dialog works
// immediately and a returning guest still keeps the language they always used.
//
// ...but "strongest signal first" used to mean the current message ALWAYS outranked the
// conversation, so one weak detection flipped a ten-message Kazakh dialogue to Russian.
// The locked path has required a decisive signal or a second confirming message since
// 2026-08-12 (shouldSwitchLockedLanguage); the organic path - every WhatsApp-native
// guest, which is most of them - never got the same restraint (owner report, reproduced
// 2026-08-23: a Kazakh dialogue answered "ok" and was answered in Russian).
//
// A detection that CONFIRMS the dialogue still wins instantly, and so does a decisive
// one - Kazakh-specific letters or unmistakably Russian wording. Only a weak detection
// that CONTRADICTS an established dialogue yields to the language the guest has actually
// been using. That keeps a genuine mid-conversation switch immediate while a shrug stops
// being a language decision.
export function resolveOrganicLanguage(input: {
  detected: CustomerLanguage | null;
  priorLanguage: CustomerLanguage | null;
  contactName?: unknown;
  siteLanguageHint?: CustomerLanguage | null;
  /**
   * Whether the current message carries an unmistakable signal for `detected`
   * (textCarriesDecisiveLanguageSignal). Absent means "not decisive", which keeps older
   * callers on the safe side of the change rather than the previous behaviour.
   */
  detectedIsDecisive?: boolean;
}): { language: CustomerLanguage; source: "message" | "history" | "contact_name" | "site_hint" | "default" } {
  if (input.detected) {
    const contradictsDialogue = Boolean(input.priorLanguage) && input.detected !== input.priorLanguage;
    if (!contradictsDialogue || input.detectedIsDecisive) {
      return { language: input.detected, source: "message" };
    }
    // The guest has been speaking one language and this message only weakly suggests the
    // other. Answering the dialogue is right far more often than answering the token.
    return { language: input.priorLanguage as CustomerLanguage, source: "history" };
  }
  if (input.priorLanguage) return { language: input.priorLanguage, source: "history" };
  const nameLanguage = detectNameLanguage(input.contactName);
  if (nameLanguage) return { language: nameLanguage, source: "contact_name" };
  if (input.siteLanguageHint) return { language: input.siteLanguageHint, source: "site_hint" };
  return { language: "kk", source: "default" };
}
