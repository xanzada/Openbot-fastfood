import test from 'node:test';
import assert from 'node:assert/strict';

// Source fixtures only. The external issuer/route are spies after real permission
// and kitchen predicates; no provider, token issuance, transport or human ACK.
process.env.REDIS_URL = 'redis://127.0.0.1:1';
process.env.REDIS_CONNECT_TIMEOUT_MS = '500';
process.env.REDIS_OPERATION_TIMEOUT_MS = '500';
const { redisClient } = await import('../src/services/redis.service.js');
const { answerAgentFailure } = await import('../src/services/turnSafetyNet.service.js');
const { hasCustomerCheckoutIntent, hasDirectOrderIntent } = await import('../src/utils/orderIntent.js');
const { hasExplicitMenuLinkIntent } = await import('../src/utils/magicLink.js');
const { resolveAgentToolPlan } = await import('../src/agent/toolPolicy.js');
const { classifyKitchenSalesPolicyForContext } = await import('../src/services/kitchenPolicy.service.js');
test.after(() => { if (redisClient.isOpen) redisClient.destroy(); });
const runtime = { runtime_available: true, is_accepting_orders: true, within_work_hours: true, is_emergency: false, wait_time: 0 };
const menu = [
  { id: 'cola', name: 'Кола', category_name: 'Напитки', price: 800, available: true },
  { id: 'doner', name: 'Донер куриный', category_name: 'Донеры', price: 1800, available: true },
];
const makeContext = (text: string, extra: any = {}) => ({
  instanceId: 'fallback-link-source', phone: 'fixture-guest', text,
  language: /[әғқңөұүі]|Сылтемени/iu.test(text) ? 'kk' : 'ru', config: { domain: 'https://fixture.invalid' },
  runtimeStatus: runtime, hardRealtimeContext: runtime, fetchedSettings: { wait_time: 0 },
  activeOrder: null, chatHistory: [], menuSnapshot: { items: menu.map(x => ({ ...x, price: x.price - 100 })) },
  activeShiftNotes: [], activeShiftNotesFingerprint: '', mediaContext: null,
  explicitMenuLinkIntent: hasExplicitMenuLinkIntent(text), magicLinkAlreadySent: false, magicLink: null,
  ...extra,
} as any);
async function recover(text: string, extra: any = {}, issuerSucceeds = true, freshMenu = menu) {
  const ctx = makeContext(text, extra);
  const calls: string[] = []; let issued = 0; let routed = 0;
  const readMenu: any = async (_instance: any, _domain: any, _language: any, options: any) => {
    assert.equal(options?.forceFresh, true); calls.push('searchMenu'); return { items: freshMenu, source: 'fresh-source-fixture' };
  };
  const grant: any = async (current: any) => {
    calls.push('grantAttempt');
    const policy = classifyKitchenSalesPolicyForContext(current.runtimeStatus, current.activeShiftNotes);
    if (!hasCustomerCheckoutIntent(current.text) || current.runtimeStatus?.runtime_available !== true
      || (policy.blocksAllSales && policy.mode !== 'off_hours') || policy.requiresConsent || !issuerSucceeds) return false;
    issued++; current.magicLink = 'https://fixture.invalid/access/source'; current.magicLinkGranted = true; return true;
  };
  const route: any = async () => { routed++; return { action: 'operator_case_created', caseId: 'fixture' }; };
  const result = await answerAgentFailure(ctx, Error('SYNTHETIC_ALL_PROVIDERS_UNAVAILABLE'), route, grant, readMenu,
    (async () => ({ state: 'not_found' })) as any);
  return { result, ctx, calls, issued, routed };
}
for (const text of ['Мәзірді қайдан қараймын?', 'Где посмотреть меню?']) {
  test(`fallback honors the menu-browse link after a fresh lookup: ${text}`, async () => {
    const out = await recover(text);
    assert.ok(resolveAgentToolPlan(makeContext(text)).requiredTools.includes('sendMenuLink'));
    assert.deepEqual(out.calls, ['searchMenu', 'grantAttempt']); assert.equal(out.issued, 1); assert.equal(out.routed, 0);
    assert.doesNotMatch(out.result, /қолжетімсіз|позиции нет|нет в доступном меню/iu);
  });
}
for (const text of ['Сілтемені қайта жіберші', 'Пришлите ссылку повторно', 'Сілтеме ашылмайды', 'Ссылка не открывается']) {
  test(`fallback executes the current planned resend or broken-link request: ${text}`, async () => {
    const out = await recover(text, { magicLinkAlreadySent: true, chatHistory: [{ role: 'assistant', text: 'Ссылка https://fixture.invalid/access/old', linkGranted: true }] });
    assert.equal(out.issued, 1); assert.equal(out.routed, 0); assert.equal(out.ctx.magicLink, 'https://fixture.invalid/access/source');
  });
}
for (const text of ['Сылтемени жиберш', 'Скинь сылку', 'Мн колу пж']) {
  test(`the finite current request has shared permission and a fallback link: ${text}`, async () => {
    assert.equal(hasCustomerCheckoutIntent(text), true);
    if (text === 'Мн колу пж') assert.equal(hasDirectOrderIntent(text), true);
    else assert.equal(hasExplicitMenuLinkIntent(text), true);
    const out = await recover(text); assert.equal(out.issued, 1); assert.equal(out.routed, 0);
    if (text === 'Мн колу пж') { assert.equal(out.calls[0], 'searchMenu'); assert.match(out.result, /Кола — 800/iu); }
  });
}
for (const text of [
  'Не скинь сылку', 'Сылтемени жиберме', 'Сылтемени керек емес',
  'Скинь сылку. Ссылку не присылай.', 'Сылтемени жиберш. Сілтеме керек емес.',
  '«Скинь сылку»', '«Сылтемени жиберш»', '«Мн колу пж»',
  'Мн колу пж, сколько стоит?', 'Мн колу пж? Цена какая?', 'Сколько стоит кола?',
  'Меню напишите здесь, ссылку не присылайте.',
]) {
  test(`a refusal, quote, price question or inline menu does not authorize issuance: ${text}`, async () => {
    assert.equal(hasCustomerCheckoutIntent(text), false);
    const out = await recover(text); assert.equal(out.issued, 0); assert.equal(out.ctx.magicLinkGranted, undefined);
  });
}
for (const state of [
  { ...runtime, is_accepting_orders: false },
  { ...runtime, is_emergency: true },
  { ...runtime, runtime_available: false },
  { ...runtime, wait_time: 60 },
]) {
  test(`planned-link fallback preserves a current operational gate: ${JSON.stringify(state)}`, async () => {
    const out = await recover('Хочу взять колу', { runtimeStatus: state, hardRealtimeContext: state, fetchedSettings: { wait_time: state.wait_time } });
    assert.equal(out.issued, 0);
  });
}
test('off-hours menu browsing keeps its current link after a fresh lookup', async () => {
  const state = { ...runtime, within_work_hours: false };
  const out = await recover('Мәзірді қайдан қараймын?', { runtimeStatus: state, hardRealtimeContext: state });
  assert.deepEqual(out.calls, ['searchMenu', 'grantAttempt']); assert.equal(out.issued, 1); assert.equal(out.routed, 0);
});
for (const text of ['Где посмотреть меню?', 'Пришлите ссылку повторно']) {
  test(`issuer failure does not fabricate a delivered link: ${text}`, async () => {
    const out = await recover(text, {}, false); assert.equal(out.issued, 0);
    assert.doesNotMatch(out.result, /отправил|жібердім|по ссылке ниже/iu);
  });
}
test('a direct missing-product request does not become availability or issuance', async () => {
  const out = await recover('Хочу взять донер', {}, true, [menu[0]]);
  assert.equal(out.issued, 0); assert.doesNotMatch(out.result, /Донер куриный — 1800/iu);
});

// New spelling aliases must not introduce an explicit-link flag from a quote.
for (const text of ['«Скинь сылку»', '«Сылтемени жиберш»']) {
  test(`quoted-typo stays outside current explicit-link recognition: ${text}`, () => {
    assert.equal(hasExplicitMenuLinkIntent(text), false);
    assert.equal(hasCustomerCheckoutIntent(text), false);
  });
}

// Additive current-choice / current-arrival controls; the original 31 are unchanged.
const complaintBoundary = await import('../src/services/complaintRouting.service.js');
for (const text of ['Хочу колу', 'Я хочу пиццу', 'Хочу спрайт', 'Хочу донер куриный']) {
  test('an affirmative current food object grants shared checkout permission: ' + text, () => {
    assert.equal(hasDirectOrderIntent(text), true);
    assert.equal(hasCustomerCheckoutIntent(text), true);
  });
}
test('bare current cola desire reads fresh availability before one authorized fallback URL', async () => {
  const out = await recover('Хочу колу');
  assert.deepEqual(out.calls, ['searchMenu', 'grantAttempt']);
  assert.equal(out.issued, 1); assert.equal(out.routed, 0);
  assert.match(out.result, /Кола — 800/iu);
});
for (const text of [
  'Не хочу колу', 'Хочу узнать цену колы', 'Хочу колу?', 'Если хочу колу, что делать?',
  'Я хочу колу только если она есть', '«Хочу колу»', '"Я хочу пиццу"',
  'Вчера я сказал, что хочу колу', 'Хочу колу, ссылку не присылайте.',
]) {
  test('an informational, denied, conditional or reported desire grants no URL: ' + text, async () => {
    assert.equal(hasCustomerCheckoutIntent(text), false);
    const out = await recover(text); assert.equal(out.issued, 0);
  });
}
for (const text of ['Заказ не пришел 60 минут', 'Мой заказ не пришёл уже 60 минут']) {
  test('a current asserted missing arrival reaches shared complaint and incident evidence: ' + text, () => {
    assert.equal(complaintBoundary.isLikelyComplaintText(text), true);
    assert.equal(complaintBoundary.complaintHasActionableDetail(text), true);
    assert.equal(complaintBoundary.hasConfirmedCustomerIncident(makeContext(text)), true);
  });
}
for (const text of [
  '«Заказ не пришел 60 минут»', 'Если заказ не пришёл 60 минут, то что делать?',
  'Заказ не пришёл?', 'Вчера заказ не пришёл 60 минут. Сегодня всё хорошо.',
  'Заказ пришёл 60 минут назад.', 'Неправда, что заказ не пришёл 60 минут.',
  'Заказ не пришёл 60 минут, но сейчас заказ пришёл.', 'Согласен ждать 60 минут',
]) {
  test('a non-current or non-assertive arrival statement proves no incident: ' + text, () => {
    assert.equal(complaintBoundary.hasConfirmedCustomerIncident(makeContext(text)), false);
  });
}
test('declining an operator does not erase an independently asserted missing arrival', () => {
  const text = 'Заказ не пришёл 60 минут. Оператор не нужен.';
  assert.equal(complaintBoundary.hasConfirmedCustomerIncident(makeContext(text)), true);
});

// Same arrival-evidence boundary: a follow-up question or unrelated past clause
// must not erase the current assertion, while a reported/conditional subject is not it.
for (const text of [
  'Заказ не пришёл 60 минут, что делать?',
  'Вчера доставка была вовремя, но сегодня заказ не пришёл 60 минут.',
]) {
  test('a current missing arrival remains evidence beside another clause: ' + text, () => {
    assert.equal(complaintBoundary.isLikelyComplaintText(text), true);
    assert.equal(complaintBoundary.hasConfirmedCustomerIncident(makeContext(text)), true);
  });
}
for (const text of [
  'Он говорит: заказ не пришёл 60 минут.',
  'Если пройдёт час, заказ не пришёл 60 минут.',
  'Оператор сказал, что заказ не пришёл 60 минут.',
]) {
  test('a reported or conditional arrival subject is not a current customer assertion: ' + text, () => {
    assert.equal(complaintBoundary.hasConfirmedCustomerIncident(makeContext(text)), false);
  });
}
test('a similarly spelled non-food noun grants no checkout permission', () => {
  assert.equal(hasCustomerCheckoutIntent('Хочу колыбель'), false);
});

for (const text of ['Заказ не пришёл бы за 60 минут.', 'Заказ не пришёл вчера. Сегодня всё хорошо.']) {
  test('a conditional or historical modifier governs the arrival predicate itself: ' + text, () => {
    assert.equal(complaintBoundary.isLikelyComplaintText(text), false);
    assert.equal(complaintBoundary.hasConfirmedCustomerIncident(makeContext(text)), false);
  });
}
test('a current day modifier remains a current asserted arrival incident', () => {
  const text = 'Заказ не пришёл сегодня уже 60 минут.';
  assert.equal(complaintBoundary.isLikelyComplaintText(text), true);
  assert.equal(complaintBoundary.hasConfirmedCustomerIncident(makeContext(text)), true);
});

// Ordered current choice and attributed arrival companions; original 65 remain exact.
for (const text of [
  'Хочу колу. Не хочу колу.', 'Хочу колу, но не хочу колу.',
  'Хочу колу. Не хочу колы.', 'Хочу колу. Не хочу колу. Хочу колу. Не хочу колу.',
]) {
  test('later withdrawal of the same food family removes bare-choice permission: ' + text, async () => {
    assert.equal(hasDirectOrderIntent(text), false);
    assert.equal(hasCustomerCheckoutIntent(text), false);
    const out = await recover(text); assert.equal(out.issued, 0);
  });
}
for (const text of [
  'Не хочу колу, но хочу колу.',
  'Хочу колу. Хочу донер. Не хочу колу.',
  'Хочу колу. Не хочу донер.',
  'Хочу колу. «Не хочу колу».',
]) {
  test('restored or independently retained current food choice remains permission: ' + text, () => {
    assert.equal(hasDirectOrderIntent(text), true);
    assert.equal(hasCustomerCheckoutIntent(text), true);
  });
}
test('a separate explicit URL request remains permission after food withdrawal', () => {
  assert.equal(hasCustomerCheckoutIntent('Пришлите ссылку. Хочу колу. Не хочу колу.'), true);
});
test('a later link refusal clears independently selected foods as well', () => {
  assert.equal(hasCustomerCheckoutIntent('Хочу колу. Хочу донер. Ссылку не присылайте.'), false);
});
for (const text of [
  'Друг говорит, заказ не пришёл 60 минут.',
  'Оператор сообщает, заказ не пришёл 60 минут.',
]) {
  test('the reporting governor carries across its dependent comma clause: ' + text, () => {
    assert.equal(complaintBoundary.isLikelyComplaintText(text), false);
    assert.equal(complaintBoundary.hasConfirmedCustomerIncident(makeContext(text)), false);
  });
}
for (const text of [
  'Друг говорит, заказ не пришёл 60 минут. Сегодня мой заказ не пришёл 60 минут.',
  'Друг говорит, заказ не пришёл 60 минут, но сегодня мой заказ не пришёл 60 минут.',
  'Я говорю, заказ не пришёл 60 минут.',
]) {
  test('an independent current customer assertion is not erased by attribution: ' + text, () => {
    assert.equal(complaintBoundary.isLikelyComplaintText(text), true);
    assert.equal(complaintBoundary.hasConfirmedCustomerIncident(makeContext(text)), true);
  });
}

for (const text of ['Хочу колу, не хочу колу.', 'Хочу колу и не хочу колу.']) {
  test('adjacent current choice actions retain their chronological object binding: ' + text, () => {
    assert.equal(hasDirectOrderIntent(text), false);
    assert.equal(hasCustomerCheckoutIntent(text), false);
  });
}
test('coordinated food choices retain the independently selected object', () => {
  const text = 'Хочу колу и хочу донер. Не хочу колу.';
  assert.equal(hasDirectOrderIntent(text), true);
  assert.equal(hasCustomerCheckoutIntent(text), true);
});
test('an intervening report cannot turn its negative desire into the customer withdrawal', () => {
  const text = 'Хочу колу, друг говорит, не хочу колу.';
  assert.equal(hasDirectOrderIntent(text), true);
  assert.equal(hasCustomerCheckoutIntent(text), true);
});
