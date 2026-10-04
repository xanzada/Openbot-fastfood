import type { FastFoodContext } from "../context/types.js";

/**
 * Greeting calibration (owner live test, 2026-10-04).
 *
 * «Сәлем» got a bare «Осындамын…», then - once that was fixed - «Сәлем» / «Салам» /
 * «Сәлеметсіз бе» were all answered «Қайырлы күн!» (the time-of-day hint beat the
 * guest's own words) and «Здравствуйте» once got «Чем могу помочь?». A person
 * answers a greeting in the form it came in, so the reply mirrors it.
 */
type Lang = "kk" | "ru";
type Form = { re: RegExp; reply: string; lang: Lang | "any" };

// Order matters: the longer form first («сәлеметсіз бе» before «сәлем»).
const FORMS: Form[] = [
  { re: /^(?:ассалау?м?а?ғ?а?л[еа]йкум|ассаламу?\s*[аә]?л[еа]йкум|ас-салам|салам\s*[аә]л[еа]йкум|салемалейкум|саламалейкум)/u, reply: "Уағалейкум ассалам!", lang: "any" },
  { re: /^(?:уа?ғ?алейкум|ва\s*алейкум)/u, reply: "Уағалейкум ассалам!", lang: "any" },
  { re: /^с[әа]л[еe]м[еe]тс[іи]з(?:дер)?(?:\s*[бпм][еа])?/u, reply: "Сәлеметсіз бе!", lang: "kk" },
  { re: /^с[әа]л[еe]м(?:дер)?(?=\s|$)/u, reply: "Сәлем!", lang: "kk" },
  { re: /^салам(?=\s|$)/u, reply: "Салам!", lang: "any" },
  { re: /^[қк]айырлы\s+та[ңн]/u, reply: "Қайырлы таң!", lang: "kk" },
  { re: /^[қк]айырлы\s+к[үу]н/u, reply: "Қайырлы күн!", lang: "kk" },
  { re: /^[қк]айырлы\s+кеш/u, reply: "Қайырлы кеш!", lang: "kk" },
  { re: /^здра[вс]?ствуй(?:те)?/u, reply: "Здравствуйте!", lang: "ru" },
  { re: /^добр(?:ый|ого)\s+(?:день|дня)/u, reply: "Добрый день!", lang: "ru" },
  { re: /^добр(?:ый|ого)\s+вечер/u, reply: "Добрый вечер!", lang: "ru" },
  { re: /^добр(?:ое|ого)\s+утр[оа]?/u, reply: "Доброе утро!", lang: "ru" },
  { re: /^приветствую/u, reply: "Приветствую!", lang: "ru" },
  { re: /^привет(?:ик)?(?=\s|$)/u, reply: "Привет!", lang: "ru" },
  { re: /^(?:hi|hello|salem|salam)(?=\s|$)/u, reply: "", lang: "any" },
];

// Small talk that rides along with a greeting without turning it into a request.
const FILLER_RE =
  /^(?:бе|ба|ма|ме|па|пе|всем|вам|ребята|друзья|жігіттер|жигиттер|достар|апа|аға|ага|қалайсыз(?:дар)?|калайсыз(?:дар)?|қалайсың(?:дар)?|калайсын(?:дар)?|как|дела|делишки|жақсы|жаксы|ма|рахмет|ассалам|ассаламу|алейкум|ағалейкум|агалейкум|уа|ва|ас|ал|саламатсыз|ба|день|вечер|утро|дня|таң|тан|күн|кун|кеш)$/u;

// Informal "how are you / what's up" openers that are greetings too, but questions:
// they get a greeting back, not a mirrored echo.
const CHECK_IN_RE =
  /^(?:нест[еі]?[вп]?ат(?:ы?р)?сы[нң](?:дар|ыз|ыздар)?|не\s+[іи]ст[еі]п\s+жат|[қк]алайсы[зң]|[қк]алай\s+жа[ғг]дай|как\s+дела|как\s+вы|как\s+жизнь)/u;

function normalize(text: string) {
  return String(text || "")
    .toLowerCase()
    .replace(/ё/g, "е")
    .replace(/[\p{Extended_Pictographic}\uFE0F\u200d]/gu, " ")
    .replace(/[!?.,;:()\-–—"«»'`*~]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

const fold = (value: string) =>
  normalize(value).replace(/[әғқңөұүһі]/g, (c) => ({ "ә": "а", "ғ": "г", "қ": "к", "ң": "н", "ө": "о", "ұ": "у", "ү": "у", "һ": "х", "і": "и" } as Record<string, string>)[c]);

export type GuestGreeting = { kind: "greeting" | "check_in"; mirror: string; mirrorLang: Lang | "any"; pure: boolean };

/** What kind of greeting the guest's message opens with, and whether it is ONLY that. */
export function readGuestGreeting(text: string): GuestGreeting | null {
  const norm = normalize(text);
  if (!norm) return null;
  for (const form of FORMS) {
    const match = norm.match(form.re);
    if (!match) continue;
    const rest = norm.slice(match[0].length).trim();
    const restWords = rest ? rest.split(" ") : [];
    const pure = restWords.length <= 4 && restWords.every((word) => FILLER_RE.test(word) || CHECK_IN_RE.test(word));
    return { kind: "greeting", mirror: form.reply, mirrorLang: form.lang, pure };
  }
  if (CHECK_IN_RE.test(norm)) {
    const words = norm.split(" ");
    return { kind: "check_in", mirror: "", mirrorLang: "any", pure: words.length <= 4 };
  }
  return null;
}

const DEFAULT_GREETING: Record<Lang, string> = { kk: "Сәлем!", ru: "Здравствуйте!" };
const INVITE: Record<Lang, string> = {
  kk: "Осындамын — не көмек керек, жаза беріңіз.",
  ru: "Я на связи — напишите, чем помочь.",
};

function lang(ctx: FastFoodContext): Lang {
  return ctx.language === "kk" ? "kk" : "ru";
}

/** The greeting this guest should hear back, in their own form when it fits the reply language. */
export function greetingFor(ctx: FastFoodContext): string {
  const l = lang(ctx);
  const guest = readGuestGreeting(String(ctx.text || ""));
  if (guest?.mirror && (guest.mirrorLang === "any" || guest.mirrorLang === l)) return guest.mirror;
  return DEFAULT_GREETING[l];
}

export function greetingReply(ctx: FastFoodContext): string {
  return `${greetingFor(ctx)} 😊 ${INVITE[lang(ctx)]}`;
}

/**
 * Fallback when the model's text could not be used. Greets when the guest greeted or
 * the bot has not spoken yet; mid-dialog it does not re-greet.
 */
export function fallbackReply(ctx: FastFoodContext) {
  const history = Array.isArray(ctx.chatHistory) ? ctx.chatHistory : [];
  const botSpoke = history.some((entry: any) => ["assistant", "model", "bot"].includes(String(entry?.role || "")));
  const greeted = Boolean(readGuestGreeting(String(ctx.text || "")));
  return greeted || !botSpoke ? greetingReply(ctx) : INVITE[lang(ctx)];
}

// Robotic service stamps that make a greeting sound like a call-centre IVR.
const STAMP_RE =
  /(чем\s+(?:я\s+)?(?:ещ[её]\s+)?могу\s+(?:вам\s+)?(?:быть\s+полез|помочь)|(?:сізге\s+)?қалай\s+көмектесе\s+аламын|көмектесуге\s+дайынмын|^\s*(?:конечно|разумеется|әрине)\s*[!,.]|рад[аы]?\s+(?:вам\s+)?помочь|рад[аы]?\s+быть\s+на\s+связи)/iu;

// Any greeting the model might open with, to be swapped for the mirrored one.
const OPENER_RE =
  /^\s*(?:с[әа]леметсіз\s+бе|с[әа]лем(?:етсіз)?|салам|уа?ғалейкум\s+[аә]сс?[аә]л[аә]м|ва\s+алейкум\s+ассалам|қайырлы\s+(?:таң|күн|кеш)|здравствуйте|добр(?:ый|ое)\s+(?:день|вечер|утро)|приветствую|привет)(?:\s*[!,.])?/iu;

/**
 * Only for a turn that is nothing but a greeting: the reply opens with the guest's own
 * greeting (when it opens with one) and carries no robotic stamp. Anything else passes through untouched.
 */
export function alignGreetingReply(text: string, ctx: FastFoodContext): { text: string; changed: string | null } {
  const guest = readGuestGreeting(String(ctx.text || ""));
  if (!guest?.pure || !text) return { text, changed: null };
  if (STAMP_RE.test(text)) return { text: greetingReply(ctx), changed: "greeting_stamp_replaced" };
  // «Нестеватсындар?» is answered, not echoed.
  if (guest.kind === "check_in") return { text, changed: null };
  const want = greetingFor(ctx);
  const opener = text.match(OPENER_RE);
  if (opener) {
    if (fold(opener[0]) === fold(want)) return { text, changed: null };
    const rest = text.slice(opener[0].length).replace(/^\s+/, "");
    return { text: `${want} ${rest}`.trim(), changed: "greeting_mirrored" };
  }
  // A reply that does not open with a greeting is left as the model wrote it: the prompt
  // asks for the greeting, and gluing one onto arbitrary text reads worse than none.
  return { text, changed: null };
}

// «Конечно, отправил ссылку повторно» (owner's phone, 2026-10-04): the prompt bans these
// openers, the model still reaches for them. Dropping the opener keeps the real answer.
const ROBOTIC_OPENER_RE = /^\s*(?:конечно|разумеется|отличный вопрос|әрине|тамаша сұрақ)\s*[!,.]+\s*/iu;

export function stripRoboticOpener(text: string): { text: string; changed: string | null } {
  const match = String(text || "").match(ROBOTIC_OPENER_RE);
  if (!match) return { text, changed: null };
  const rest = text.slice(match[0].length);
  if (rest.trim().length < 8) return { text, changed: null };
  return { text: rest.charAt(0).toLocaleUpperCase("ru") + rest.slice(1), changed: "robotic_opener_removed" };
}
