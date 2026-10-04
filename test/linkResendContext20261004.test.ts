import test from "node:test";
import assert from "node:assert/strict";
import { isContextualLinkResendRequest, hasExplicitMenuLinkIntent } from "../src/utils/magicLink.js";

const sent = { alreadySent: true, recentHistory: [] as string[] };

test("colloquial Kazakh/Russian resend requests count when a link is already in the chat", () => {
  for (const text of ["Кері жібересіз бе", "Кері жіберші", "кери жибер", "keri zhiber", "қайта жібер", "тағы жіберші", "скинь ещё раз", "повтори ссылку", "не вижу ссылку", "продублируйте", "сілтеме көрінбейді"]) {
    assert.equal(isContextualLinkResendRequest(text, sent), true, text);
  }
});

test("a link mentioned in recent history is enough context", () => {
  assert.equal(isContextualLinkResendRequest("Кері жіберші", { alreadySent: false, recentHistory: ["Міне, жеке сілтемеңіз: https://x.kz/?phone=77001234567&hash=ab"] }), true);
});

test("no link in context - no resend (no spam on ordinary chat)", () => {
  assert.equal(isContextualLinkResendRequest("Кері жіберші", { alreadySent: false, recentHistory: ["Сәлем! Не көмек керек?"] }), false);
  assert.equal(isContextualLinkResendRequest("скинь ещё раз", {}), false);
});

test("resend of something else is not a link request", () => {
  for (const text of ["ақшаны кері жіберіңіз", "чекті қайта жібер", "тағы бір донер жібер", "фото еще раз скиньте", "Kaspi номерді қайта жіберші", "деньги верните, отправьте заново"]) {
    assert.equal(isContextualLinkResendRequest(text, sent), false, text);
  }
});

test("ordinary questions are not resend requests", () => {
  for (const text of ["донердің құрамы қандай?", "сағат нешеге дейін жұмыс істейсіздер?", "рахмет", "жақсы"]) {
    assert.equal(isContextualLinkResendRequest(text, sent), false, text);
  }
});

test("explicit link words with the new Kazakh resend verbs are explicit intent", () => {
  assert.equal(hasExplicitMenuLinkIntent("сілтемені кері жіберші"), true);
  assert.equal(hasExplicitMenuLinkIntent("не вижу ссылку"), true);
});

test("validator cuts «scroll up» sentences when the link was requested or granted", async () => {
  const { validateFinalText } = await import("../src/agent/finalValidator.js");
  const base = { config: {}, hardRealtimeContext: {}, runtimeStatus: {}, activeShiftNotes: [], chatHistory: [], activeOrder: null } as any;
  const granted = validateFinalText("Сілтеме чатымызда сәл жоғарыда тұр, өтініш қарап көріңізші.", { ...base, language: "kk", magicLink: "https://x.kz/?phone=77001234567&hash=ab", magicLinkGranted: true, magicLinkAlreadySent: true, explicitMenuLinkIntent: true }, { toolsCalled: ["sendMenuLink"] } as any);
  assert.equal(granted.text, "Әрине, мінекей сілтеме, мархабат!");
  const mixed = validateFinalText("Конечно! Ссылка уже была отправлена выше в чате. Донер стоит 1000 ₸.", { ...base, language: "ru", magicLinkGranted: true, magicLinkAlreadySent: true, explicitMenuLinkIntent: true }, { toolsCalled: ["sendMenuLink", "searchMenu"] } as any);
  assert.doesNotMatch(mixed.text, /выше|уже была отправлена/);
  assert.match(mixed.text, /Конечно!/);
  const untouched = validateFinalText("Меню выше по ценам не изменилось.", { ...base, language: "ru" }, { toolsCalled: [] } as any);
  assert.ok(!untouched.warnings.includes("link_scroll_up_removed"));
});

test("outside a resend the robotic opener is still dropped", async () => {
  const { validateFinalText } = await import("../src/agent/finalValidator.js");
  const out = validateFinalText("Конечно, донер есть в меню, напишите сколько штук.", { language: "ru", config: {}, hardRealtimeContext: {}, runtimeStatus: {}, activeShiftNotes: [], chatHistory: [], activeOrder: null } as any, { toolsCalled: [] } as any);
  assert.doesNotMatch(out.text, /^Конечно/);
});
