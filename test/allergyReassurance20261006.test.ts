import test from 'node:test';
import assert from 'node:assert/strict';
import { validateFinalText } from '../src/agent/finalValidator.js';

const ctx = (language: 'ru' | 'kk', text: string) => ({
  instanceId: 'audit-allergy-reassurance', phone: 'fixture-guest', language, text,
  config: {}, activeShiftNotes: [], activeOrder: null, chatHistory: [],
  menuSnapshot: { items: [
    { id: 'fixture-doner', name: 'Донер куриный', price: 1800,
      composition: 'Курица, лаваш, томат', available: true },
  ] },
} as any);
const grounded = { toolsCalled: ['searchMenu'] };
const reassurance = /алаңдама|уайымдама|қорықпа|не\s+(?:беспокой|волнуй|бой)|ничего\s+страшного/iu;
const denial = /кепілдік\s*бере\s*алмай|гарантировать[^.!?]*не\s*могу|не\s*могу[^.!?]*гарантировать/iu;

test('actual K10/t3 child-allergy draft cannot retain unsafe reassurance after other claims are cut', () => {
  const raw = 'Сіздің баланың жаңғаққа аллергиясы бар екені үшін алаңдамаңыз. Нақты тағамдар бойынша ақпаратты асханада сұрастырғанымды ескертемін, бірақ дәл қазір мен мәзірде жаңғақ бар-жоғы жайлы нақты ақпарат беру мүмкіндігім жоқ. Қазір мәзірде жаңғақ қосылған тағам жоқ, бірақ сізге Спрайт (650 тг), Кола (750 тг) немесе Донер куриный (1800 тг) ұсынамын. Қайсысын таңдайсыз?';
  const result = validateFinalText(raw, ctx('kk', 'Баламда жаңғаққа аллергия бар'), grounded);
  assert.equal(reassurance.test(result.text), false, result.text);
  assert.equal(denial.test(result.text), true, result.text);
});

for (const [language, input, raw] of [
  ['ru', 'У ребёнка аллергия на орехи', 'Не беспокойтесь. Состав Донер куриный: Курица, лаваш, томат.'],
  ['ru', 'У ребёнка аллергия на орехи', 'Не волнуйтесь, можете выбрать донер.'],
  ['ru', 'У ребёнка аллергия на орехи', 'Ничего страшного, выбирайте блюдо.'],
  ['kk', 'Баламда жаңғаққа аллергия бар', 'Уайымдамаңыз. Донер куриный құрамы: Курица, лаваш, томат.'],
  ['kk', 'Баламда жаңғаққа аллергия бар', 'Қорықпаңыз, донерді ала беріңіз.'],
] as const) {
  test(`current allergy cannot be dismissed: ${raw}`, () => {
    const result = validateFinalText(raw, ctx(language, input), grounded);
    assert.equal(reassurance.test(result.text), false, result.text);
    assert.equal(denial.test(result.text), true, result.text);
    if (/лаваш/.test(raw)) assert.match(result.text, /Курица, лаваш, томат/iu);
  });
}

for (const [language, input, raw] of [
  ['ru', 'У ребёнка аллергия на орехи', 'Понимаю ваше беспокойство. Состав Донер куриный: Курица, лаваш, томат.'],
  ['kk', 'Баламда жаңғаққа аллергия бар', 'Сіздің алаңдауыңызды түсінемін. Донер куриный құрамы: Курица, лаваш, томат.'],
  ['ru', 'Пришлите ссылку', 'Не беспокойтесь, помогу разобраться со ссылкой.'],
  ['kk', 'Сілтеме керек', 'Уайымдамаңыз, сілтемені тексеруге көмектесемін.'],
  ['ru', 'У ребёнка аллергия на орехи', 'Отсутствие орехов гарантировать не могу. Состав Донер куриный: Курица, лаваш, томат.'],
  ['kk', 'Баламда жаңғаққа аллергия бар', 'Жаңғақ жоқ екенін растай алмаймын. Донер куриный құрамы: Курица, лаваш, томат.'],
  ['ru', 'У ребёнка аллергия на орехи', 'Не говорю «не беспокойтесь»: безопасность при аллергии подтвердить не могу.'],
  ['kk', 'Баламда жаңғаққа аллергия бар', '«Алаңдамаңыз» деп айтпаймын: аллергия кезінде қауіпсіздігіне кепілдік бере алмаймын.'],
] as const) {
  test(`preserve empathy, honest uncertainty or unrelated link reassurance: ${raw}`, () => {
    const result = validateFinalText(raw, ctx(language, input), grounded);
    assert.equal(result.text, raw);
  });
}

test('a later unsafe clause is removed even when an earlier honest denial exists', () => {
  const result = validateFinalText('Гарантировать безопасность при аллергии не могу. Не беспокойтесь, выбирайте донер.', ctx('ru', 'У ребёнка аллергия на орехи'), grounded);
  assert.equal(reassurance.test(result.text), false, result.text);
  assert.match(result.text, /Гарантировать безопасность при аллергии не могу/);
});

// Additive known-composition/unknown-allergen recovery tests; original prefix is retained.
for (const language of ['ru','kk'] as const) {
 const input=language==='ru' ? 'У ребёнка аллергия на орехи' : 'Баламда жаңғаққа аллергия бар';
 const unsafe=language==='ru' ? 'Не переживайте.' : 'Уайымдамаңыз.';
 const knownContext={...ctx(language,input),menuSnapshot:{items:[{id:'fixture-salad',name:'Салат',price:700,composition:'Огурец, помидор.',available:true}]}};
 test(`known composition does not become a claim that all composition data are absent: ${language}`,()=>{
  const raw=language==='ru' ? 'Состав: Огурец, помидор, арахис.' : 'Салат құрамы: Огурец, помидор, арахис.';
  const result=validateFinalText(raw,knownContext,{toolsCalled:['searchMenu'],toolFindings:{}});
  assert.equal(reassurance.test(result.text),false);
  assert.equal(denial.test(result.text),true);
  assert.doesNotMatch(result.text,/нет[^.!?]*подтвержд[^.!?]*о\s+составе|құрамы[^.!?]*расталған\s+дерек\s+жоқ/iu);
  assert.doesNotMatch(result.text,/нет орехов|жаңғақсыз|(?:блюдо|салат|тағам)\s+(?:безопас[её]н|қауіпсіз)[.!]|уточню|нақтылап|оператор/iu);
 });
 test(`unknown composition still cannot grant an allergy assurance: ${language}`,()=>{
  const c={...knownContext,menuSnapshot:{items:[{id:'fixture-salad',name:'Салат',price:700,composition:'',available:true}]}};
  const result=validateFinalText(unsafe,c,{toolsCalled:['searchMenu'],toolFindings:{}});
  assert.equal(reassurance.test(result.text),false);assert.equal(denial.test(result.text),true);
  assert.doesNotMatch(result.text,/огурец|помидор|нет орехов|жаңғақсыз|уточню|нақтылап|оператор/iu);
 });
 test(`honest guarantee denial remains byte-exact with known composition: ${language}`,()=>{
  const raw=language==='ru' ? 'Гарантировать безопасность при аллергии не могу.' : 'Аллергия кезінде қауіпсіз екеніне кепілдік бере алмаймын.';
  assert.equal(validateFinalText(raw,knownContext,{toolsCalled:['searchMenu'],toolFindings:{}}).text,raw);
 });
 test(`ordinary grounded composition remains available: ${language}`,()=>{
  const raw=language==='ru' ? 'Состав: Огурец, помидор.' : 'Құрамы: Огурец, помидор.';
  const c={...knownContext,text:language==='ru' ? 'Что входит в салат?' : 'Салаттың құрамы қандай?'};
  assert.equal(validateFinalText(raw,c,{toolsCalled:['searchMenu'],toolFindings:{}}).text,raw);
 });
}
