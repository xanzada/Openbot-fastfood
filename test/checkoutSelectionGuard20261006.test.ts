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
