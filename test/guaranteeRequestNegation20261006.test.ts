import test from "node:test";
import assert from "node:assert/strict";
import { validateFinalText } from "../src/agent/finalValidator.js";

const ctx = (language: "ru" | "kk", text: string) => ({
  instanceId: "audit-guarantee-negation",
  phone: "77000000004",
  language,
  text,
  config: {},
  activeShiftNotes: [],
  menuSnapshot: { items: [] },
  activeOrder: null,
} as any);

const requests: ["ru" | "kk", string][] = [
  ["ru", "Гарантируете отсутствие орехов?"],
  ["ru", "Не прошу оператора, гарантируете отсутствие орехов?"],
  ["ru", "Гарантия не нужна, но гарантируете отсутствие орехов?"],
  ["kk", "Жаңғақ жоқ екеніне кепілдік бере аласыз ба?"],
  ["kk", "Кепілдік керек емес, бірақ жаңғақ жоқ екеніне кепілдік бере аласыз ба?"],
  ["ru", "Не прошу оператора. Гарантируете отсутствие орехов?"],
  ["ru", "Не прошу оператора: гарантируете отсутствие орехов?"],
  ["ru", "Не требую гарантии. Но можете гарантировать отсутствие арахиса?"],
  ["ru", "Можете гарантировать, что это блюдо безопасно при аллергии на орехи?"],
  ["ru", "Гарантируете отсутствие орехов? Не прошу оператора."],
  ["kk", "Оператор сұрамаймын, жаңғақ жоқ екеніне кепілдік бере аласыз ба?"],
  ["kk", "Кепілдік қажет емес. Бірақ жаңғақ жоқ екеніне кепілдік бере аласыз ба?"],
  ["kk", "Жаңғақ жоқ екеніне кепілдік бере аласыз ба? Оператор сұрамаймын."],
];

const refusals: ["ru" | "kk", string][] = [
  ["ru", "У ребёнка аллергия на орехи, гарантия не нужна."],
  ["kk", "Жаңғаққа аллергия бар, кепілдік керек емес."],
  ["ru", "Гарантируете отсутствие орехов? Гарантия не нужна."],
  ["kk", "Жаңғақ жоқ екеніне кепілдік бере аласыз ба? Кепілдік керек емес."],
  ["ru", "Гарантируете отсутствие орехов, но не прошу гарантии."],
  ["kk", "Жаңғақ жоқ екеніне кепілдік бере аласыз ба, бірақ кепілдік сұрамаймын."],
  ["ru", "Можете гарантировать отсутствие орехов? Нет, гарантия не нужна, скажите только состав."],
  ["ru", "Не требую гарантировать безопасность при аллергии, нужен состав."],
  ["kk", "Жаңғаққа аллергия бар, құрамын ғана айтыңыз."],
  ["ru", "У ребёнка аллергия на орехи. Только состав, без гарантии."],
  ["ru", "«Гарантируете отсутствие орехов?» — это цитата, гарантия не нужна."],
  ["kk", "«Жаңғақ жоқ екеніне кепілдік бере аласыз ба?» деген сөзді аударыңыз."],
];

for (const [language, text] of requests) {
  test(`a current guarantee question survives independent refusal: ${text}`, () => {
    const raw = language === "ru"
      ? "Вы можете уточнить состав у оператора."
      : "Құрамын оператордан нақтылай аласыз.";
    const result = validateFinalText(raw, ctx(language, text), { toolsCalled: [], toolFindings: {} });
    assert.ok(result.warnings.includes("missing_allergy_guarantee_denial_added"), JSON.stringify(result));
    assert.match(result.text, language === "ru" ? /гарант.*не могу/iu : /кепілдік.*алмай/iu);
    assert.equal(result.hasLink, false);
    assert.doesNotMatch(result.text, /уведомл[её]н|передал|проверю|тексеремін|тіркелді|хабар бердім/iu);
  });
}

for (const [language, text] of refusals) {
  test(`a locally refused guarantee remains optional: ${text}`, () => {
    const raw = language === "ru"
      ? "Вы можете уточнить состав у оператора."
      : "Құрамын оператордан нақтылай аласыз.";
    const result = validateFinalText(raw, ctx(language, text), { toolsCalled: [], toolFindings: {} });
    assert.equal(result.text, raw);
    assert.ok(!result.warnings.includes("missing_allergy_guarantee_denial_added"));
    assert.equal(result.hasLink, false);
  });
}

for (const [language, raw] of [
  ["ru", "Не могу гарантировать, что это блюдо безопасно для аллергии."],
  ["ru", "Гарантировать безопасность при аллергии не могу."],
  ["kk", "Кешіріңіз, бірақ жаңғақсыз тағамдардың қауіпсіздігі туралы нақты кепілдік бере алмаймын."],
] as const) {
  test(`an already honest guarantee denial is preserved: ${language} ${raw}`, () => {
    const text = language === "ru"
      ? "Не прошу оператора, гарантируете отсутствие орехов?"
      : "Кепілдік керек емес, бірақ жаңғақ жоқ екеніне кепілдік бере аласыз ба?";
    const result = validateFinalText(raw, ctx(language, text), { toolsCalled: [], toolFindings: {} });
    assert.equal(result.text, raw);
    assert.ok(!result.warnings.includes("missing_allergy_guarantee_denial_added"));
  });
}
