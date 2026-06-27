const KAZAKH_RE =
  /[әғқңөұүһі]|(сәлем|қалай|дайындалып|жатырма|қашан|барма|жоқпа|жокпа|керек|қайда|тапсырыс|жеткізу|алып кету|мәзір|меню|реквизит|төлем)/iu;

export function detectLang(text: string, storedLang?: string | null): "kk" | "ru" {
  if (storedLang === "kk" || storedLang === "ru") return storedLang;
  return KAZAKH_RE.test(text || "") ? "kk" : "ru";
}
