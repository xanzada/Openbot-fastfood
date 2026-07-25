export type CustomerLanguage = "kk" | "ru";

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
