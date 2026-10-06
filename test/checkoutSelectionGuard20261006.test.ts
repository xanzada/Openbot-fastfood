import test from 'node:test';
import assert from 'node:assert/strict';
import { validateFinalText } from '../src/agent/finalValidator.js';

const items = [
  { id: 'cola', name: 'Кола', price: 850, available: true },
  { id: 'sprite', name: 'Спрайт', price: 650, available: true },
  { id: 'doner', name: 'Донер куриный', price: 1800, available: true },
  { id: 'caesar', name: 'Цезарь', price: 2200, available: true },
  { id: 'burger', name: 'Бургер', price: 2000, available: true },
  { id: 'sushi', name: 'Суши', price: 2500, available: true },
];
const base: any = {
  instanceId: 'audit-checkout-selection', phone: 'fixture-guest', config: {},
  language: 'kk', text: 'Маған кола керек', chatHistory: [], activeOrder: null,
  activeShiftNotes: [], runtimeStatus: { runtime_available: true, is_accepting_orders: true, within_work_hours: true },
  hardRealtimeContext: { runtime_available: true, is_accepting_orders: true, within_work_hours: true },
  fetchedSettings: { wait_time: 0 }, menuSnapshot: { items }, menuGrounding: { menu_lookup: 'ok' },
  shporContext: [], magicLink: 'https://fixture.invalid/order/selection',
  magicLinkGranted: true, magicLinkAlreadySent: false, explicitMenuLinkIntent: true,
};
const source = { toolsCalled: ['searchMenu', 'sendMenuLink'], toolFindings: {} };
const check = (raw: string, changes: any = {}) => validateFinalText(raw, { ...base, ...changes }, source);

for (const [id, language, input, raw, wrong] of [
  ['actual-KK-cola-vs-doner', 'kk', base.text, 'Донерді сатып алуға сілтеме міне, мархабат! Сіз оны пайдаланып, қалағаныңызды таңдай аласыз.', /донер/iu],
  ['RU-cola-vs-doner', 'ru', 'Мне нужна кола', 'Вот ссылка для покупки донера. Вы можете выбрать желаемое.', /донер/iu],
  ['RU-cola-vs-caesar', 'ru', 'Возьму колу', 'Ссылка для заказа Цезаря.', /цезар/iu],
  ['KK-cola-inflection-vs-sprite', 'kk', 'Маған коланы беріңіз', 'Спрайтті сатып алу үшін сілтеме.', /спрайт/iu],
  ['RU-cola-vs-sprite-inflection', 'ru', 'Мне колу', 'Ссылка на покупку спрайта.', /спрайт/iu],
  ['catalog-derived-unrelated-burger-vs-sushi', 'ru', 'Хочу бургер', 'Вот ссылка для заказа суши.', /суши/iu],
  ['KK-current-negation-new-choice', 'kk', 'Кола емес, донер алайын', 'Коланы сатып алу үшін сілтеме.', /кола/iu],
  ['RU-current-negation-new-choice', 'ru', 'Колу не хочу. Возьму донер', 'Ссылка для покупки колы.', /кол[ауы]/iu],
] as const) test(id, () => {
  const result = check(raw, { language, text: input });
  assert.doesNotMatch(result.text, wrong);
  assert.match(result.text, /сілтеме|ссылк/iu);
  assert.ok(result.warnings.includes('checkout_selection_mismatch_removed'));
  assert.doesNotMatch(result.text, /заказ принят|тапсырыс қабылдан/iu);
});

for (const [id, language, input, raw] of [
  ['correct-KK-current-cola', 'kk', base.text, 'Коланы осы сілтеме арқылы таңдай аласыз.'],
  ['correct-RU-current-cola', 'ru', 'Мне нужна кола', 'Колу можно выбрать по ссылке.'],
  ['generic-KK-storefront', 'kk', base.text, 'Сілтеме арқылы қалағаныңызды таңдай аласыз.'],
  ['generic-RU-storefront', 'ru', 'Мне нужна кола', 'Вы можете выбрать желаемое по ссылке.'],
  ['current-switch-to-doner', 'kk', 'Донер алайын', 'Донерді осы сілтеме арқылы таңдай аласыз.'],
  ['both-current-selected-products', 'ru', 'Два донера и колу', 'Донер и колу можно выбрать по ссылке.'],
  ['quoted-rejected-alternative', 'kk', base.text, '«Донерді сатып ал» деп ұсынбаймын. Коланы таңдауға болады.'],
  ['negated-wrong-object', 'ru', 'Мне нужна кола', 'Эта ссылка не для покупки донера. Колу можно выбрать на сайте.'],
  ['current-only-quoted-choice', 'ru', 'Он написал «Хочу колу». Покажите меню.', 'Донер можно выбрать по ссылке.'],
  ['earlier-choice-does-not-override-current', 'ru', 'Возьму донер', 'Донер можно выбрать по ссылке.'],
  ['menu-inquiry-preserved', 'ru', 'Что есть из напитков?', 'Спрайт можно выбрать по ссылке.'],
  ['budget-inquiry-preserved', 'ru', 'У меня 2000 тенге, посоветуйте еду', 'Донер можно выбрать по ссылке.'],
  ['comparison-preserved', 'ru', 'Мне нужна кола', 'Донер дороже колы. Колу можно выбрать по ссылке.'],
  ['explicit-alternative-preserved', 'ru', 'Мне нужна кола', 'Как альтернативу можно выбрать спрайт по ссылке.'],
  ['conditional-alternative-preserved', 'kk', base.text, 'Қаласаңыз, спрайтті сілтеме арқылы таңдай аласыз.'],
] as const) test(id, () => {
  const result = check(raw, { language, text: input });
  assert.ok(!result.warnings.includes('checkout_selection_mismatch_removed'));
  if (id !== 'budget-inquiry-preserved') assert.equal(result.text, raw);
});

test('existing URL survives while wrong checkout purpose is removed', () => {
  const result = check('Донерді сатып алу үшін сілтеме: https://fixture.invalid/order/selection');
  assert.doesNotMatch(result.text, /донер/iu);
  assert.ok(result.warnings.includes('checkout_selection_mismatch_removed'));
  // The core validator owns URL authorization and may dispatch it separately.
  assert.ok(result.text.includes('https://fixture.invalid/order/selection') || !result.hasLink);
});

test('truthful safety and diet qualification survive a separate wrong checkout sentence', () => {
  const raw = 'Ссылка для покупки донера. Соответствие диете и отсутствие аллергенов подтвердить не могу.';
  const result = check(raw, { language: 'ru', text: 'Мне нужна кола' });
  assert.doesNotMatch(result.text, /донер/iu);
  assert.match(result.text, /Соответствие диете и отсутствие аллергенов подтвердить не могу/);
});

test('stale user/assistant history cannot change the current explicit selection', () => {
  const result = check('Вот ссылка для покупки донера.', {
    language: 'ru', text: 'Мне нужна кола', chatHistory: [
      { role: 'user', content: 'Возьму донер' }, { role: 'assistant', content: 'Донер можно выбрать по ссылке.' },
    ],
  });
  assert.doesNotMatch(result.text, /донер/iu);
});

test('unknown current name without catalog match stays outside guard', () => {
  const raw = 'Выбрать донер можно по ссылке.';
  assert.equal(check(raw, { language: 'ru', text: 'Хочу неизвестную позицию' }).text, raw);
});

test('an ungiven link does not gain a generic link promise', () => {
  const result = check('Донер можно выбрать по ссылке.', { language: 'ru', text: 'Мне нужна кола', magicLink: null, magicLinkGranted: false });
  assert.ok(!result.warnings.includes('checkout_selection_mismatch_removed'));
});

test('a link question does not erase the explicit current cola choice', () => {
  const result = check('Вот ссылка для покупки донера.', { language: 'ru', text: 'Хочу колу, можно ссылку?' });
  assert.doesNotMatch(result.text, /донер/iu);
  assert.ok(result.warnings.includes('checkout_selection_mismatch_removed'));
});

test('truthful same-sentence safety qualification survives the wrong purpose clause', () => {
  const result = check('Вот ссылка для покупки донера, соответствие диете подтвердить не могу.', { language: 'ru', text: 'Мне нужна кола' });
  assert.doesNotMatch(result.text, /донер/iu);
  assert.match(result.text, /соответствие диете подтвердить не могу/);
});

test('an unpunctuated safety conjunction remains after the wrong object is cut', () => {
  const result = check('Вот ссылка для покупки донера и соответствие диете подтвердить не могу.', { language: 'ru', text: 'Мне нужна кола' });
  assert.doesNotMatch(result.text, /донер/iu);
  assert.match(result.text, /соответствие диете подтвердить не могу/);
});

test('a Kazakh safety contrast remains after the wrong object is cut', () => {
  const result = check('Донерді сатып алуға сілтеме бірақ диетаға сәйкестігін растай алмаймын.');
  assert.doesNotMatch(result.text, /донер/iu);
  assert.match(result.text, /диетаға сәйкестігін растай алмаймын/);
});

test('an extra unchosen product in a purchase purpose is neutralized', () => {
  const result = check('Ссылка для покупки донера и колы.', { language: 'ru', text: 'Мне нужна кола' });
  assert.doesNotMatch(result.text, /донер/iu);
  assert.ok(result.warnings.includes('checkout_selection_mismatch_removed'));
});

test('a trailing generic Russian question invitation cannot excuse a wrong checkout object', () => {
  const result = check('Ссылка для покупки донера, если есть вопросы, напишите.', { language: 'ru', text: 'Мне нужна кола' });
  assert.doesNotMatch(result.text, /донер/iu);
  assert.match(result.text, /если есть вопросы/iu);
});

test('a trailing generic Kazakh question invitation cannot excuse a wrong checkout object', () => {
  const result = check('Донерді сатып алу үшін сілтеме, егер сұрақ болса, жазыңыз.');
  assert.doesNotMatch(result.text, /донер/iu);
  assert.match(result.text, /егер сұрақ болса/iu);
});

test('an unrelated honest allergy condition cannot excuse a wrong checkout object', () => {
  const result = check('Ссылка для покупки донера, если у вас аллергия, безопасность подтвердить не могу.', { language: 'ru', text: 'Мне нужна кола' });
  assert.doesNotMatch(result.text, /донер/iu);
  assert.match(result.text, /безопасность подтвердить не могу/iu);
});

test('an explicit current two-product order keeps both checkout objects', () => {
  const raw = 'Ссылка для покупки донера и колы.';
  const result = check(raw, { language: 'ru', text: 'Два донера и колу' });
  assert.equal(result.text, raw);
  assert.ok(!result.warnings.includes('checkout_selection_mismatch_removed'));
});

test('an explicit product alternative stays preserved across a conditional prefix', () => {
  const raw = 'Если хотите, спрайт можно выбрать по ссылке.';
  const result = check(raw, { language: 'ru', text: 'Мне нужна кола' });
  assert.equal(result.text, raw);
  assert.ok(!result.warnings.includes('checkout_selection_mismatch_removed'));
});

test('a named conditional alternative stays preserved', () => {
  const raw = 'Егер спрайт керек болса, спрайтті сілтеме арқылы таңдай аласыз.';
  assert.equal(check(raw).text, raw);
});

test('a condition about cola does not excuse a primary checkout purpose for doner', () => {
  const result = check('Если нужна кола, вот ссылка для покупки донера.', { language: 'ru', text: 'Мне нужна кола' });
  assert.doesNotMatch(result.text, /донер/iu);
});

test('a separate RU price question does not erase the current explicit cola choice', () => {
  const result = check('Вот ссылка для покупки донера.', { language: 'ru', text: 'Мне нужна кола, сколько стоит донер?' });
  assert.doesNotMatch(result.text, /донер/iu);
  assert.ok(result.warnings.includes('checkout_selection_mismatch_removed'));
});

test('a separate KK availability question does not erase the current explicit cola choice', () => {
  const result = check('Донерді сатып алуға сілтеме.', { text: 'Кола алайын, донер бар ма?' });
  assert.doesNotMatch(result.text, /донер/iu);
  assert.ok(result.warnings.includes('checkout_selection_mismatch_removed'));
});

test('an exact immediately preceding alternative prefix remains a legitimate product option', () => {
  const raw = 'Как вариант, вот ссылка для покупки донера.';
  const result = check(raw, { language: 'ru', text: 'Мне нужна кола' });
  assert.equal(result.text, raw);
  assert.ok(!result.warnings.includes('checkout_selection_mismatch_removed'));
});

test('a mixed choice and inquiry still preserves a correct catalog price answer', () => {
  const raw = 'Донер куриный стоит 1800 тг.';
  const result = check(raw, { language: 'ru', text: 'Мне нужна кола, сколько стоит донер?' });
  assert.equal(result.text, raw);
  assert.ok(!result.warnings.includes('checkout_selection_mismatch_removed'));
});

test('a mixed choice and inquiry still preserves a correct availability answer without checkout', () => {
  const raw = 'Донер куриный бар.';
  const result = check(raw, { text: 'Кола алайын, донер бар ма?' });
  assert.equal(result.text, raw);
  assert.ok(!result.warnings.includes('checkout_selection_mismatch_removed'));
});

test('a pure comparison inquiry does not become a selected-product restriction', () => {
  const raw = 'Донер можно выбрать по ссылке.';
  assert.equal(check(raw, { language: 'ru', text: 'Что лучше, кола или донер?' }).text, raw);
});

test('an informational price request is not an explicit cola purchase choice', () => {
  const raw = 'Донер можно выбрать по ссылке.';
  assert.equal(check(raw, { language: 'ru', text: 'Мне нужна цена колы, покажите меню' }).text, raw);
});

for (const [id, language, input, raw, wrong] of [
  ['RU-conjoined-choice-query', 'ru', 'Мне нужна кола и сколько стоит донер?', 'Вот ссылка для покупки донера.', /донер/iu],
  ['KK-conjoined-choice-query', 'kk', 'Кола алайын және донер бар ма?', 'Донерді сатып алуға сілтеме.', /донер/iu],
  ['RU-explicit-withdrawal', 'ru', 'Хочу колу, кола не нужна, хочу донер', 'Вот ссылка для покупки колы.', /кол[ауы]/iu],
  ['KK-explicit-withdrawal', 'kk', 'Кола алайын, кола керек емес, донер алайын', 'Коланы сатып алуға сілтеме.', /кола/iu],
  ['foreign-refusal-cannot-erase-current-choice', 'ru', 'Хочу колу и донер не нужен', 'Вот ссылка для покупки донера.', /донер/iu],
] as const) test(id, () => {
  const result = check(raw, { language, text: input });
  assert.doesNotMatch(result.text, wrong);
  assert.ok(result.warnings.includes('checkout_selection_mismatch_removed'));
});

for (const [id, language, input, raw] of [
  ['RU-final-choice-after-withdrawal', 'ru', 'Хочу колу, кола не нужна, хочу донер', 'Вот ссылка для покупки донера.'],
  ['KK-final-choice-after-withdrawal', 'kk', 'Кола алайын, кола керек емес, донер алайын', 'Донерді сатып алуға сілтеме.'],
  ['explicit-additive-two-item-choice', 'ru', 'Хочу колу и донер', 'Вот ссылка для покупки колы и донера.'],
  ['quantity-additive-two-item-choice', 'ru', 'Два донера и колу', 'Вот ссылка для покупки колы и донера.'],
  ['quoted-refusal-does-not-withdraw', 'ru', 'Хочу колу, «кола не нужна» не говорил', 'Вот ссылка для покупки колы.'],
  ['foreign-refusal-keeps-cola', 'ru', 'Хочу колу и донер не нужен', 'Вот ссылка для покупки колы.'],
  ['pure-conjoined-price-query', 'ru', 'Сколько стоит кола и донер?', 'Донер куриный стоит 1800 тг. Кола стоит 850 тг.'],
] as const) test(id, () => {
  const result = check(raw, { language, text: input });
  assert.equal(result.text, raw);
  assert.ok(!result.warnings.includes('checkout_selection_mismatch_removed'));
});

for (const [id, input] of [
  ['negated-refusal-future-retains-cola', 'Хочу колу, не буду отказываться от колы'],
  ['negated-refusal-desire-retains-cola', 'Хочу колу, не хочу отказываться от колы'],
  ['comparison-refusal-retains-cola', 'Хочу колу, не буду сравнивать колу'],
  ['information-refusal-retains-cola', 'Хочу колу, не буду читать про колу'],
] as const) test(id, () => {
  const result = check('Вот ссылка для покупки донера.', { language: 'ru', text: input });
  assert.doesNotMatch(result.text, /донер/iu);
  assert.ok(result.warnings.includes('checkout_selection_mismatch_removed'));
});

test('genuine future purchase refusal removes cola and keeps final doner choice', () => {
  const ctx = { language: 'ru', text: 'Хочу колу, не буду покупать колу, хочу донер' };
  assert.doesNotMatch(check('Вот ссылка для покупки колы.', ctx).text, /кол[ауы]/iu);
  assert.equal(check('Вот ссылка для покупки донера.', ctx).text, 'Вот ссылка для покупки донера.');
});

test('a negated refusal still preserves the actual selected cola purpose', () => {
  const raw = 'Вот ссылка для покупки колы.';
  assert.equal(check(raw, { language: 'ru', text: 'Хочу колу, не буду отказываться от колы' }).text, raw);
});

for (const [id, language, raw, qualifier] of [
  ['RU-medical-dash', 'ru', 'Вот ссылка для покупки донера — не могу гарантировать отсутствие орехов.', 'не могу гарантировать отсутствие орехов'],
  ['KK-medical-dash', 'kk', 'Донерді сатып алуға сілтеме — жаңғақ жоқ екеніне кепілдік бере алмаймын.', 'жаңғақ жоқ екеніне кепілдік бере алмаймын'],
  ['RU-medical-without-guarantee', 'ru', 'Вот ссылка для покупки донера без гарантии безопасности.', 'без гарантии безопасности'],
  ['RU-link-does-not-imply-guarantee', 'ru', 'Ссылка для покупки донера не означает гарантии безопасности.', 'не означает гарантии безопасности'],
] as const) test(id, () => {
  const result = check(raw, { language });
  assert.doesNotMatch(result.text, /донер/iu);
  assert.ok(result.text.includes(qualifier));
  assert.ok(result.warnings.includes('checkout_selection_mismatch_removed'));
});

test('an explicit denial of the wrong checkout purpose is preserved', () => {
  const raw = 'Я не предлагаю ссылку для покупки донера.';
  assert.equal(check(raw, { language: 'ru' }).text, raw);
});

test('the correct cola purpose retains its truthful medical qualification', () => {
  const raw = 'Вот ссылка для покупки колы — не могу гарантировать отсутствие орехов.';
  assert.equal(check(raw, { language: 'ru' }).text, raw);
});

for (const [id, language, raw, unsafe] of [
  ['honest-prefix-comma-then-unsafe-absence', 'ru', 'Не могу гарантировать отсутствие орехов, но донер без орехов.', /донер\s+без\s+орехов/iu],
  ['honest-prefix-dash-then-unsafe-safety', 'ru', 'Не могу гарантировать отсутствие орехов — донер безопасен при аллергии.', /донер\s+безопасен/iu],
  ['no-guarantee-link-conjunction-then-unsafe-absence', 'ru', 'Вот ссылка для покупки колы без гарантии безопасности и донер без орехов.', /донер\s+без\s+орехов/iu],
  ['relation-denial-comma-then-unsafe-safety', 'ru', 'Ссылка для покупки колы не означает гарантии безопасности, но донер безопасен при аллергии.', /донер\s+безопасен/iu],
  ['KK-denial-dash-then-unsafe-absence', 'kk', 'Жаңғақ жоқ екеніне кепілдік бере алмаймын — донер жаңғақсыз, қорықпай таңдаңыз.', /донер\s+жаңғақсыз|қорықпай/iu],
] as const) test(id, () => {
  const result = check(raw, { language, text: language === 'ru' ? 'Мне нужна кола, у меня аллергия на орехи' : 'Кола алайын, жаңғаққа аллергиям бар' });
  assert.doesNotMatch(result.text, unsafe);
});

for (const [id, language, raw] of [
  ['bare-catalog-safety-predicate', 'ru', 'Донер безопасен.'],
  ['catalog-safety-predicate-after-honest-denial', 'ru', 'Не могу гарантировать отсутствие орехов, но донер безопасен.'],
  ['different-catalog-family-safety-predicate', 'ru', 'Цезарь безопасен.'],
  ['KK-bare-catalog-safety-predicate', 'kk', 'Донер қауіпсіз.'],
] as const) test(id, () => {
  const result = check(raw, {
    language, text: language === 'ru' ? 'У ребёнка аллергия на орехи. Хочу колу.' : 'Баламда жаңғаққа аллергия бар. Кола алайын.',
    menuSnapshot: { items: items.map(item => ({ ...item, composition: '' })) },
    magicLinkGranted: false, magicLink: null, explicitMenuLinkIntent: false,
  });
  assert.doesNotMatch(result.text, /(?:донер|цезарь)\s+(?:безопасен|қауіпсіз)/iu);
  assert.match(result.text, /не\s+могу|кепілдік|растай\s+алмай/iu);
});

for (const [id, raw] of [
  ['honest-catalog-predicate-verification-denial', 'Не могу подтвердить, что донер безопасен.'],
  ['quoted-catalog-predicate-denial', 'Фразу «донер безопасен» сказать не могу.'],
  ['technical-link-safety-subject', 'Ссылка для покупки донера безопасна.'],
] as const) test(id, () => {
  const result = check(raw, { language: 'ru', text: 'У ребёнка аллергия на орехи. Хочу донер.' });
  assert.equal(result.text, raw);
});

test('prior allergy alone does not turn unrelated technical safety into food assurance', () => {
  const raw = 'Ссылка безопасна.';
  const result = check(raw, { language: 'ru', text: 'Помогите со ссылкой', chatHistory: [{ role: 'user', content: 'У ребёнка аллергия на орехи' }] });
  assert.equal(result.text, raw);
});

test('a current catalog-food continuation retains the nearest customer allergy context', () => {
  const result = check('Цезарь безопасен.', {
    language: 'ru', text: 'А Цезарь?', chatHistory: [{ role: 'user', content: 'У ребёнка аллергия на орехи' }],
    magicLinkGranted: false, magicLink: null, explicitMenuLinkIntent: false,
  });
  assert.doesNotMatch(result.text, /цезарь\s+безопасен/iu);
});

for (const [id, language, raw] of [
  ['neutral-sentence-before-RU-safety', 'ru', 'Вот меню. Донер безопасен.'],
  ['question-before-RU-safety', 'ru', 'Что выберете? Донер безопасен.'],
  ['neutral-sentence-before-KK-safety', 'kk', 'Мәзір осында. Донер қауіпсіз.'],
  ['question-before-KK-safety', 'kk', 'Қайсысын таңдайсыз? Донер қауіпсіз.'],
  ['honest-denial-sentence-before-safety', 'ru', 'Не могу гарантировать отсутствие орехов. Донер безопасен.'],
  ['quoted-denial-sentence-before-safety', 'ru', 'Я не утверждаю «пицца безопасна». Донер безопасен.'],
  ['conditional-neutral-sentence-before-safety', 'ru', 'Если вам нужна ссылка, напишите. Донер безопасен.'],
] as const) test(id, () => {
  const result = check(raw, { language, text: language === 'ru' ? 'У ребёнка аллергия на орехи. Можно донер?' : 'Баламда жаңғаққа аллергия бар. Донер жеуге бола ма?', magicLink: null, magicLinkGranted: false, explicitMenuLinkIntent: false });
  assert.doesNotMatch(result.text, /донер\s+(?:безопасен|қауіпсіз)/iu);
});

for (const [id, language, raw] of [
  ['genuine-KK-negative-safety-predicate', 'kk', 'Донер қауіпсіз емес.'],
  ['genuine-KK-coordinated-dependent-safety-denial', 'kk', 'Донер қауіпсіз екенін және пицца қауіпсіз екенін растай алмаймын.'],
  ['pure-RU-food-safety-question', 'ru', 'Донер безопасен?'],
  ['pure-KK-food-safety-question', 'kk', 'Донер қауіпсіз бе?'],
] as const) test(id, () => {
  const result = check(raw, {
    language, text: language === 'ru' ? 'У ребёнка аллергия на орехи. Можно донер?' : 'Баламда жаңғаққа аллергия бар. Донер жеуге бола ма?',
    menuSnapshot: { items: [...items, { id: 'pizza', name: 'Пицца', price: 2500, composition: '', available: true }] },
    magicLink: null, magicLinkGranted: false, explicitMenuLinkIntent: false,
  });
  assert.equal(result.text, raw);
});

test('a later independent safety assertion is cut after a coordinated KK verification denial', () => {
  const result = check('Донер қауіпсіз екенін және пицца қауіпсіз екенін растай алмаймын. Пицца қауіпсіз.', {
    text: 'Баламда жаңғаққа аллергия бар. Донер жеуге бола ма?',
    menuSnapshot: { items: [...items, { id: 'pizza', name: 'Пицца', price: 2500, composition: '', available: true }] },
    magicLink: null, magicLinkGranted: false, explicitMenuLinkIntent: false,
  });
  assert.doesNotMatch(result.text, /Пицца\s+қауіпсіз\./u);
});

for (const [id, language, raw, unsafe] of [
  ['coordinated-catalog-food-safety', 'ru', 'Донер и пицца безопасны.', /донер\s+и\s+пицца\s+безопасны/iu],
  ['catalog-food-child-qualified-safety', 'ru', 'Донер для ребёнка безопасен.', /донер\s+для\s+ребёнка\s+безопасен/iu],
  ['catalog-food-future-safety', 'ru', 'Донер будет безопасен.', /донер\s+будет\s+безопасен/iu],
  ['catalog-food-parenthetic-safety', 'ru', 'Донер, безусловно, безопасен.', /донер,\s+безусловно,\s+безопасен/iu],
  ['catalog-food-adjective-safety', 'ru', 'Безопасный донер можно выбрать.', /безопасный\s+донер/iu],
  ['KK-coordinated-catalog-food-safety', 'kk', 'Донер де, пицца да қауіпсіз.', /пицца\s+да\s+қауіпсіз/iu],
] as const) test(id, () => {
  const result = check(raw, {
    language, text: language === 'ru' ? 'У ребёнка аллергия на орехи. Можно донер?' : 'Баламда жаңғаққа аллергия бар. Донер жеуге бола ма?',
    menuSnapshot: { items: [...items, { id: 'pizza', name: 'Пицца', price: 2500, composition: '', available: true }] },
    magicLink: null, magicLinkGranted: false, explicitMenuLinkIntent: false,
  });
  assert.doesNotMatch(result.text, unsafe);
});

for (const [id, raw] of [
  ['technical-future-link-subject', 'Ссылка на донер будет безопасна.'],
  ['direct-declined-safety-assertion', 'Не утверждаю, что донер безопасен.'],
  ['direct-declined-safety-confirmation', 'Не подтверждаю, что донер безопасен.'],
  ['coordinated-catalog-safety-question', 'Донер и пицца безопасны?'],
] as const) test(id, () => {
  const result = check(raw, {
    language: 'ru', text: 'У ребёнка аллергия на орехи. Можно донер?',
    menuSnapshot: { items: [...items, { id: 'pizza', name: 'Пицца', price: 2500, composition: '', available: true }] },
    magicLink: null, magicLinkGranted: false, explicitMenuLinkIntent: false,
  });
  assert.equal(result.text, raw);
});

test('an independent medical predicate after additive unrelated verification denial is cut', () => {
  const result = check('Не могу подтвердить это и донер безопасен.', {
    language: 'ru', text: 'У ребёнка аллергия на орехи. Можно донер?',
    magicLink: null, magicLinkGranted: false, explicitMenuLinkIntent: false,
  });
  assert.doesNotMatch(result.text, /донер\s+безопасен/iu);
});

test('a RU coordinated complement remains governed by its denied verification', () => {
  const raw = 'Не могу подтвердить, что донер безопасен и пицца безопасна.';
  const result = check(raw, {
    language: 'ru', text: 'У ребёнка аллергия на орехи. Можно донер?',
    menuSnapshot: { items: [...items, { id: 'pizza', name: 'Пицца', price: 2500, composition: '', available: true }] },
    magicLink: null, magicLinkGranted: false, explicitMenuLinkIntent: false,
  });
  assert.equal(result.text, raw);
});

test('a KK coordinated complement for different catalog families stays under final denied verification', () => {
  const raw = 'Цезарь қауіпсіз екенін және пицца қауіпсіз екенін растай алмаймын.';
  const result = check(raw, {
    text: 'Баламда жаңғаққа аллергия бар. Цезарь жеуге бола ма?',
    menuSnapshot: { items: [...items, { id: 'pizza', name: 'Пицца', price: 2500, composition: '', available: true }] },
    magicLink: null, magicLinkGranted: false, explicitMenuLinkIntent: false,
  });
  assert.equal(result.text, raw);
});

test('a fresh speaker guarantee remains independent after a denied RU complement', () => {
  const result = check('Не могу подтвердить, что донер безопасен и я гарантирую, что пицца безопасна.', {
    language: 'ru', text: 'У ребёнка аллергия на орехи. Можно донер?',
    menuSnapshot: { items: [...items, { id: 'pizza', name: 'Пицца', price: 2500, composition: '', available: true }] },
    magicLink: null, magicLinkGranted: false, explicitMenuLinkIntent: false,
  });
  assert.doesNotMatch(result.text, /пицца\s+безопасна/iu);
});
