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


// Renderer boundary only: successful callback IO below is synthetic. Operational
// grant decisions are checked separately with recover's unchanged real predicates.
async function genericOrderRenderer(language: 'ru' | 'kk', state: any, succeeds = true, throws = false) {
  const text = language === 'ru' ? 'Хочу заказать' : 'Тапсырыс берейін';
  const current = makeContext(text, { language, runtimeStatus: state, hardRealtimeContext: state });
  let grants = 0; let routes = 0; let searches = 0;
  const result = await answerAgentFailure(current, Error('SYNTHETIC_RENDERER_OUTAGE'),
    (async () => { routes++; return { action: 'skipped' }; }) as any,
    (async () => { grants++; if (throws) throw Error('SYNTHETIC_ISSUER_FAILURE');
      if (succeeds) { current.magicLinkGranted = true; current.magicLink = 'https://fixture.invalid/access/renderer'; }
      return succeeds; }) as any,
    (async () => { searches++; return { items: menu }; }) as any,
    (async () => ({ state: 'not_found' })) as any);
  assert.equal(grants, 1); assert.equal(routes, 0); assert.equal(searches, 0);
  assert.doesNotMatch(result, /\d+\s*₸|позиции нет|қолжетімсіз|принят|қабылданды|оператор/iu);
  return result;
}
for (const language of ['ru', 'kk'] as const) {
  test('successful generic current order keeps its ordering path with known open kitchen: ' + language, async () => {
    const reply = await genericOrderRenderer(language, runtime);
    assert.match(reply, language === 'ru' ? /оформить заказ.*по ссылке ниже/iu : /тапсырыс.*төмендегі сілтеме/iu);
  });
  test('successful standalone link with unknown runtime is a neutral menu path: ' + language, async () => {
    const reply = await genericOrderRenderer(language, null);
    assert.match(reply, language === 'ru' ? /меню.*по ссылке ниже/iu : /мәзір.*төмендегі сілтеме/iu);
    assert.doesNotMatch(reply, /можно.*(?:оформить|заказать)|оформить заказ можно|сразу оформить|тапсырыс.*(?:бере аласыз|рәсімдей аласыз)|принимаем|қабылдаймыз/iu);
  });
  for (const [name, state] of [
    ['off-hours', { ...runtime, within_work_hours: false }],
    ['hard-closed', { ...runtime, is_accepting_orders: false }],
    ['emergency', { ...runtime, is_emergency: true }],
    ['wait-without-consent', { ...runtime, wait_time: 60 }],
  ] as const) {
    test('successful synthetic grant does not invent current ordering ability for ' + name + ': ' + language, async () => {
      const reply = await genericOrderRenderer(language, state);
      assert.match(reply, language === 'ru' ? /меню.*по ссылке ниже/iu : /мәзір.*төмендегі сілтеме/iu);
      assert.doesNotMatch(reply, /оформить заказ можно|можно.*(?:оформить|заказать)|сразу оформить|тапсырыс.*(?:бере аласыз|рәсімдей аласыз)|принимаем|қабылдаймыз|после открытия|ашылғанда/iu);
    });
  }
  test('a failed generic order grant never promises a successful link: ' + language, async () => {
    const reply = await genericOrderRenderer(language, runtime, false);
    assert.match(reply, language === 'ru' ? /не удалось отправить ссылку/iu : /жіберу мүмкін болмады/iu);
    assert.doesNotMatch(reply, /по ссылке ниже|ссылку.*отправил|төмендегі сілтеме|төменге жібердім|оформить заказ можно/iu);
  });
}
test('a throwing generic order issuer keeps the honest failure path', async () => {
  const reply = await genericOrderRenderer('ru', runtime, false, true);
  assert.match(reply, /не удалось отправить ссылку/iu); assert.doesNotMatch(reply, /по ссылке ниже/iu);
});
for (const text of ['Где посмотреть меню?', 'Пришлите ссылку повторно', 'Мәзірді қайдан қараймын?', 'Сілтемені қайта жіберші']) {
  test('a browse or resend grant keeps viewing purpose without ordering ability: ' + text, async () => {
    const out = await recover(text); assert.equal(out.issued, 1); assert.equal(out.routed, 0);
    assert.match(out.result, /меню|мәзір/iu);
    assert.doesNotMatch(out.result, /оформить заказ можно|сразу оформить|тапсырыс.*(?:бере аласыз|рәсімдей аласыз)/iu);
  });
}
for (const [name, state, expectedIssued] of [
  ['normal', runtime, 1],
  ['off-hours', { ...runtime, within_work_hours: false }, 1],
  ['closed', { ...runtime, is_accepting_orders: false }, 0],
  ['unknown', null, 0],
  ['unaccepted-wait', { ...runtime, wait_time: 60 }, 0],
] as const) {
  test('generic order renderer preserves the existing operational grant outcome: ' + name, async () => {
    const out = await recover('Хочу заказать', { runtimeStatus: state, hardRealtimeContext: state });
    assert.equal(out.issued, expectedIssued); assert.equal(out.routed, 0);
    assert.equal(out.calls.filter(x => x === 'searchMenu').length, 0);
    if (!expectedIssued) assert.doesNotMatch(out.result, /по ссылке ниже|ссылку.*отправил|оформить заказ можно/iu);
    else if (name === 'normal') assert.match(out.result, /оформить заказ.*по ссылке ниже/iu);
    else { assert.match(out.result, /меню/iu); assert.doesNotMatch(out.result, /оформить заказ можно|после открытия/iu); }
  });
}
for (const text of ['Хочу колу', 'Кола алайын']) {
  test('named choice still gets fresh grounded content before its successful ordering link: ' + text, async () => {
    const out = await recover(text); assert.equal(out.calls[0], 'searchMenu'); assert.equal(out.issued, 1);
    assert.match(out.result, /Кола — 800/iu); assert.equal(out.routed, 0);
  });
}


// Actual production source, with ONLY issuer/Redis/menu/order/route IO replaced.
// CommonJS transpilation avoids requiring experimental VM flags in the full suite.
const sourceFixtureFs = await import('node:fs');
const sourceFixtureVm = await import('node:vm');
const sourceFixtureTs = await import('typescript');
async function productionSourceWithIO(relative: string, replacements: Map<string, any>) {
  const url = new URL('../src/' + relative, import.meta.url);
  const code = sourceFixtureTs.transpileModule(sourceFixtureFs.readFileSync(url, 'utf8'), {
    compilerOptions: { target: sourceFixtureTs.ScriptTarget.ES2022, module: sourceFixtureTs.ModuleKind.CommonJS },
  }).outputText;
  const specs = new Set<string>();
  const visit = (node: any) => {
    if (sourceFixtureTs.isCallExpression(node) && sourceFixtureTs.isIdentifier(node.expression)
      && node.expression.text === 'require' && sourceFixtureTs.isStringLiteral(node.arguments[0])) specs.add(node.arguments[0].text);
    sourceFixtureTs.forEachChild(node, visit);
  };
  visit(sourceFixtureTs.createSourceFile('source-fixture.cjs', code, sourceFixtureTs.ScriptTarget.ES2022, true));
  const dependencies: Record<string, any> = {};
  for (const spec of specs) {
    const resolved = new URL(spec, url);
    dependencies[spec] = replacements.has(resolved.pathname) ? replacements.get(resolved.pathname) : await import(resolved.href);
  }
  const exports: any = {};
  sourceFixtureVm.runInNewContext(code, { exports, module: { exports }, require: (spec: string) => {
    assert.ok(Object.hasOwn(dependencies, spec), 'unexpected source import ' + spec); return dependencies[spec];
  }, console, process, Date, Buffer, setTimeout, clearTimeout }, { filename: url.pathname, timeout: 1000 });
  return exports;
}
async function pricedOrderingSource(text: string, language: 'ru' | 'kk', state: any, accepted = false, issuerSucceeds = true) {
  const ctx = makeContext(text, { language, runtimeStatus: state, hardRealtimeContext: state ?? { runtime_available: false },
    fetchedSettings: { wait_time: state?.wait_time ?? 0 }, menuSnapshot: { items: [{ id: 'cola', name: 'Кола', price: 600, available: true }] } });
  const policy = classifyKitchenSalesPolicyForContext(state, ctx.activeShiftNotes);
  let minted = 0; let marked = 0; let routed = 0; const calls: string[] = []; const issuerOutcomes: any[] = [];
  const replacements = new Map<string, any>();
  const redis = await import('../src/services/redis.service.js');
  replacements.set(new URL('../src/services/redis.service.js', import.meta.url).pathname, { ...redis,
    getKitchenCheckoutFingerprint: async () => accepted ? policy.fingerprint : null,
    markKitchenCheckoutStarted: async () => { marked++; }, markMagicLinkSent: async () => { marked++; },
  });
  replacements.set(new URL('../src/services/checkoutIntent.service.js', import.meta.url).pathname, {
    ensureCustomerAccessLink: async (current: any) => { if (!issuerSucceeds) return null; minted++;
      current.magicLink = 'https://fixture.invalid/access/ordering-method'; return current.magicLink; },
  });
  const promise = await productionSourceWithIO('agent/linkPromise.ts', replacements);
  replacements.set(new URL('../src/agent/linkPromise.js', import.meta.url).pathname, promise);
  const toolPolicy = await productionSourceWithIO('agent/toolPolicy.ts', replacements);
  replacements.set(new URL('../src/agent/toolPolicy.js', import.meta.url).pathname, toolPolicy);
  const safety = await productionSourceWithIO('services/turnSafetyNet.service.ts', replacements);
  const reply = await safety.answerAgentFailure(ctx, Error('SYNTHETIC_ORDERING_METHOD_OUTAGE'),
    async () => { routed++; return { action: 'skipped' }; },
    async (current: any) => { calls.push('realPromiseGate'); const result = await promise.honorMenuLinkPromise(current, 'Отправлю ссылку.');
      issuerOutcomes.push(result); return result.action === 'granted' || Boolean(current.magicLinkGranted && current.magicLink); },
    async (_instance: any, _domain: any, _language: any, options: any) => {
      assert.equal(options?.forceFresh, true); calls.push('freshSearch');
      return { items: [{ id: 'cola', name: 'Кола', price: 700, available: true }], source: 'EXPLICIT_SYNTHETIC_FRESH_CATALOG' };
    }, async () => ({ state: 'not_found' }));
  assert.equal(routed, 0); assert.equal(calls[0], 'freshSearch');
  assert.match(reply, /Кола — 700/iu); assert.doesNotMatch(reply, /Кола — 600/iu);
  return { reply, ctx, policy, minted, marked, calls, issuerOutcomes };
}
const methodStates = [
  { name: 'normal', state: runtime, accepted: false, expectedMint: 1 },
  { name: 'off-hours', state: { ...runtime, is_accepting_orders: false, within_work_hours: false }, accepted: false, expectedMint: 1 },
  { name: 'closed', state: { ...runtime, is_accepting_orders: false }, accepted: false, expectedMint: 0 },
  { name: 'unknown', state: null, accepted: false, expectedMint: 0 },
  { name: 'unconfirmed-wait', state: { ...runtime, wait_time: 60 }, accepted: false, expectedMint: 0 },
  { name: 'accepted-wait', state: { ...runtime, wait_time: 60 }, accepted: true, expectedMint: 1 },
];
for (const language of ['ru', 'kk'] as const) {
  const text = language === 'ru' ? 'Если хочу колу, можно заказать?' : 'Колаға тапсырыс берейін';
  for (const item of methodStates) {
    test('fresh priced ordering answer respects actual current kitchen source: ' + item.name + ': ' + language, async () => {
      const out = await pricedOrderingSource(text, language, item.state, item.accepted);
      assert.equal(out.minted, item.expectedMint); assert.equal(out.marked, item.expectedMint * 2);
      if (item.name === 'normal' || item.name === 'accepted-wait') {
        assert.match(out.reply, language === 'ru' ? /оформить заказ.*ссылке ниже/iu : /тапсырыс беру сілтемесін/iu);
      } else if (item.name === 'off-hours') {
        assert.match(out.reply, language === 'ru' ? /после открытия/iu : /ашылғанда/iu);
        assert.match(out.reply, language === 'ru' ? /для просмотра меню/iu : /мәзірді қарау/iu);
        assert.doesNotMatch(out.reply, /Оформить заказ можно по ссылке ниже|Тапсырыс беру сілтемесін/iu);
      } else if (item.name === 'closed') {
        assert.match(out.reply, language === 'ru' ? /заказы не принимаем/iu : /тапсырыс қабылдай алмаймыз/iu);
      } else if (item.name === 'unknown') {
        assert.match(out.reply, language === 'ru' ? /не могу.*подтвердить/iu : /растай алмаймын/iu);
        assert.doesNotMatch(out.reply, /заказы не принимаем|тапсырыс қабылдай алмаймыз|закрыт|жабық/iu);
      } else {
        assert.match(out.reply, /60|1\s*(?:час|сағат)/iu); assert.match(out.reply, language === 'ru' ? /готовы подождать\?/iu : /келісесіз бе\?/iu);
      }
      if (!item.expectedMint) assert.doesNotMatch(out.reply, /по ссылке ниже|сілтемесін төменге жібердім|ссылку.*отправил/iu);
    });
  }
  const browse = language === 'ru' ? 'Кола есть? Пришлите ссылку для просмотра меню.' : 'Кола бар ма? Сілтемені жіберіңіз.';
  for (const item of methodStates.filter(x => ['normal', 'off-hours', 'unconfirmed-wait'].includes(x.name))) {
    test('priced explicit browse preserves view purpose and actual grant gates: ' + item.name + ': ' + language, async () => {
      const out = await pricedOrderingSource(browse, language, item.state);
      assert.equal(out.minted, item.name === 'unconfirmed-wait' ? 0 : 1);
      assert.doesNotMatch(out.reply, /Оформить заказ можно по ссылке ниже|Тапсырыс беру сілтемесін/iu);
      if (out.minted) assert.match(out.reply, language === 'ru' ? /для просмотра меню/iu : /мәзірді қарау/iu);
    });
  }
  for (const item of methodStates.filter(x => ['off-hours', 'unknown', 'unconfirmed-wait'].includes(x.name))) {
    test('ordinary price question is not turned into an order by kitchen mode: ' + item.name + ': ' + language, async () => {
      const out = await pricedOrderingSource(language === 'ru' ? 'Сколько стоит кола?' : 'Кола қанша тұрады?', language, item.state);
      assert.equal(out.minted, 0); assert.doesNotMatch(out.reply, /оформить заказ|заказы не принимаем|готовы подождать|тапсырыс қабылдай|келісесіз бе|ссылке ниже|сілтемесін/iu);
    });
  }
  test('priced current order issuer failure keeps facts without a successful link promise: ' + language, async () => {
    const out = await pricedOrderingSource(text, language, runtime, false, false);
    assert.equal(out.minted, 0); assert.doesNotMatch(out.reply, /ссылке ниже|сілтемесін төменге жібердім/iu);
    assert.ok(out.issuerOutcomes.some(x => x.reason === 'link_issue_failed'));
  });
}
for (const text of ['«Хочу колу». Сколько стоит кола?', 'Хочу колу. Не хочу колу. Сколько стоит кола?']) {
  test('a quote or withdrawn choice plus price is not an operational ordering decision: ' + text, async () => {
    const out = await pricedOrderingSource(text, 'ru', { ...runtime, is_accepting_orders: false });
    assert.equal(out.minted, 0); assert.doesNotMatch(out.reply, /заказы не принимаем|готовы подождать|ссылке ниже/iu);
  });
}
for (const text of ['Кола есть? Пришлите ссылку повторно.', 'Кола. Ссылка не открывается.']) {
  test('priced resend and broken-link recovery keep view purpose off hours: ' + text, async () => {
    const out = await pricedOrderingSource(text, 'ru', { ...runtime, is_accepting_orders: false, within_work_hours: false });
    assert.equal(out.minted, 1); assert.match(out.reply, /для просмотра меню/iu); assert.doesNotMatch(out.reply, /Оформить заказ можно/iu);
  });
}


// Exact seven independent synthetic contexts. Original expected-false permission
// assertions remain untouched in their separate immutable scripts.
const requestedLinkFailureCases: any[] = [{"id":"priced_link__closed","input":"Пришлите ссылку на меню: Кола.","state":"closed","context":{"instanceId":"independent-wave5-pair-priced_link__closed","phone":"synthetic-customer","text":"Пришлите ссылку на меню: Кола.","language":"ru","config":{"domain":"https://fixture.invalid"},"runtimeStatus":{"runtime_available":true,"is_accepting_orders":false,"within_work_hours":true,"is_emergency":false,"wait_time":0},"hardRealtimeContext":{"runtime_available":true,"is_accepting_orders":false,"within_work_hours":true,"is_emergency":false,"wait_time":0},"activeOrder":null,"chatHistory":[],"activeShiftNotes":[],"menuSnapshot":{"items":[{"id":"fixture-cola","name":"Кола","category_name":"Напитки","price":700,"composition":"Вода, сахар","available":true},{"id":"fixture-sprite","name":"Спрайт","category_name":"Напитки","price":650,"composition":"Вода, сахар","available":true},{"id":"fixture-doner","name":"Донер куриный","category_name":"Донеры","price":1800,"composition":"Курица, лаваш, томат","available":true},{"id":"fixture-caesar","name":"Цезарь","category_name":"Салаты","price":2200,"composition":"Курица, салат","available":true}],"source":"R44-v2"},"explicitMenuLinkIntent":true,"magicLink":null,"magicLinkGranted":false,"mediaContext":null,"fetchedSettings":{"wait_time":0}},"freshMenu":{"items":[{"id":"fixture-cola","name":"Кола","category_name":"Напитки","price":700,"composition":"Вода, сахар","available":true},{"id":"fixture-sprite","name":"Спрайт","category_name":"Напитки","price":650,"composition":"Вода, сахар","available":true},{"id":"fixture-doner","name":"Донер куриный","category_name":"Донеры","price":1800,"composition":"Курица, лаваш, томат","available":true},{"id":"fixture-caesar","name":"Цезарь","category_name":"Салаты","price":2200,"composition":"Курица, салат","available":true}],"source":"R44-v2"},"issuerSucceeds":true},{"id":"priced_link__unknown_runtime","input":"Пришлите ссылку на меню: Кола.","state":"unknown_runtime","context":{"instanceId":"independent-wave5-pair-priced_link__unknown_runtime","phone":"synthetic-customer","text":"Пришлите ссылку на меню: Кола.","language":"ru","config":{"domain":"https://fixture.invalid"},"runtimeStatus":null,"hardRealtimeContext":{"runtime_available":false,"is_accepting_orders":true,"within_work_hours":true,"is_emergency":false,"wait_time":0},"activeOrder":null,"chatHistory":[],"activeShiftNotes":[],"menuSnapshot":{"items":[{"id":"fixture-cola","name":"Кола","category_name":"Напитки","price":700,"composition":"Вода, сахар","available":true},{"id":"fixture-sprite","name":"Спрайт","category_name":"Напитки","price":650,"composition":"Вода, сахар","available":true},{"id":"fixture-doner","name":"Донер куриный","category_name":"Донеры","price":1800,"composition":"Курица, лаваш, томат","available":true},{"id":"fixture-caesar","name":"Цезарь","category_name":"Салаты","price":2200,"composition":"Курица, салат","available":true}],"source":"R44-v2"},"explicitMenuLinkIntent":true,"magicLink":null,"magicLinkGranted":false,"mediaContext":null,"fetchedSettings":{"wait_time":0}},"freshMenu":{"items":[{"id":"fixture-cola","name":"Кола","category_name":"Напитки","price":700,"composition":"Вода, сахар","available":true},{"id":"fixture-sprite","name":"Спрайт","category_name":"Напитки","price":650,"composition":"Вода, сахар","available":true},{"id":"fixture-doner","name":"Донер куриный","category_name":"Донеры","price":1800,"composition":"Курица, лаваш, томат","available":true},{"id":"fixture-caesar","name":"Цезарь","category_name":"Салаты","price":2200,"composition":"Курица, салат","available":true}],"source":"R44-v2"},"issuerSucceeds":true},{"id":"priced_link__unconfirmed_wait","input":"Пришлите ссылку на меню: Кола.","state":"unconfirmed_wait","context":{"instanceId":"independent-wave5-pair-priced_link__unconfirmed_wait","phone":"synthetic-customer","text":"Пришлите ссылку на меню: Кола.","language":"ru","config":{"domain":"https://fixture.invalid"},"runtimeStatus":{"runtime_available":true,"is_accepting_orders":true,"within_work_hours":true,"is_emergency":false,"wait_time":60},"hardRealtimeContext":{"runtime_available":true,"is_accepting_orders":true,"within_work_hours":true,"is_emergency":false,"wait_time":60},"activeOrder":null,"chatHistory":[],"activeShiftNotes":[],"menuSnapshot":{"items":[{"id":"fixture-cola","name":"Кола","category_name":"Напитки","price":700,"composition":"Вода, сахар","available":true},{"id":"fixture-sprite","name":"Спрайт","category_name":"Напитки","price":650,"composition":"Вода, сахар","available":true},{"id":"fixture-doner","name":"Донер куриный","category_name":"Донеры","price":1800,"composition":"Курица, лаваш, томат","available":true},{"id":"fixture-caesar","name":"Цезарь","category_name":"Салаты","price":2200,"composition":"Курица, салат","available":true}],"source":"R44-v2"},"explicitMenuLinkIntent":true,"magicLink":null,"magicLinkGranted":false,"mediaContext":null,"fetchedSettings":{"wait_time":60}},"freshMenu":{"items":[{"id":"fixture-cola","name":"Кола","category_name":"Напитки","price":700,"composition":"Вода, сахар","available":true},{"id":"fixture-sprite","name":"Спрайт","category_name":"Напитки","price":650,"composition":"Вода, сахар","available":true},{"id":"fixture-doner","name":"Донер куриный","category_name":"Донеры","price":1800,"composition":"Курица, лаваш, томат","available":true},{"id":"fixture-caesar","name":"Цезарь","category_name":"Салаты","price":2200,"composition":"Курица, салат","available":true}],"source":"R44-v2"},"issuerSucceeds":true},{"id":"priced_resend__closed","input":"Отправьте ссылку снова: Кола.","state":"closed","context":{"instanceId":"independent-wave5-pair-priced_resend__closed","phone":"synthetic-customer","text":"Отправьте ссылку снова: Кола.","language":"ru","config":{"domain":"https://fixture.invalid"},"runtimeStatus":{"runtime_available":true,"is_accepting_orders":false,"within_work_hours":true,"is_emergency":false,"wait_time":0},"hardRealtimeContext":{"runtime_available":true,"is_accepting_orders":false,"within_work_hours":true,"is_emergency":false,"wait_time":0},"activeOrder":null,"chatHistory":[],"activeShiftNotes":[],"menuSnapshot":{"items":[{"id":"fixture-cola","name":"Кола","category_name":"Напитки","price":700,"composition":"Вода, сахар","available":true},{"id":"fixture-sprite","name":"Спрайт","category_name":"Напитки","price":650,"composition":"Вода, сахар","available":true},{"id":"fixture-doner","name":"Донер куриный","category_name":"Донеры","price":1800,"composition":"Курица, лаваш, томат","available":true},{"id":"fixture-caesar","name":"Цезарь","category_name":"Салаты","price":2200,"composition":"Курица, салат","available":true}],"source":"R44-v2"},"explicitMenuLinkIntent":true,"magicLink":null,"magicLinkGranted":false,"mediaContext":null,"fetchedSettings":{"wait_time":0}},"freshMenu":{"items":[{"id":"fixture-cola","name":"Кола","category_name":"Напитки","price":700,"composition":"Вода, сахар","available":true},{"id":"fixture-sprite","name":"Спрайт","category_name":"Напитки","price":650,"composition":"Вода, сахар","available":true},{"id":"fixture-doner","name":"Донер куриный","category_name":"Донеры","price":1800,"composition":"Курица, лаваш, томат","available":true},{"id":"fixture-caesar","name":"Цезарь","category_name":"Салаты","price":2200,"composition":"Курица, салат","available":true}],"source":"R44-v2"},"issuerSucceeds":true},{"id":"priced_resend__unknown_runtime","input":"Отправьте ссылку снова: Кола.","state":"unknown_runtime","context":{"instanceId":"independent-wave5-pair-priced_resend__unknown_runtime","phone":"synthetic-customer","text":"Отправьте ссылку снова: Кола.","language":"ru","config":{"domain":"https://fixture.invalid"},"runtimeStatus":null,"hardRealtimeContext":{"runtime_available":false,"is_accepting_orders":true,"within_work_hours":true,"is_emergency":false,"wait_time":0},"activeOrder":null,"chatHistory":[],"activeShiftNotes":[],"menuSnapshot":{"items":[{"id":"fixture-cola","name":"Кола","category_name":"Напитки","price":700,"composition":"Вода, сахар","available":true},{"id":"fixture-sprite","name":"Спрайт","category_name":"Напитки","price":650,"composition":"Вода, сахар","available":true},{"id":"fixture-doner","name":"Донер куриный","category_name":"Донеры","price":1800,"composition":"Курица, лаваш, томат","available":true},{"id":"fixture-caesar","name":"Цезарь","category_name":"Салаты","price":2200,"composition":"Курица, салат","available":true}],"source":"R44-v2"},"explicitMenuLinkIntent":true,"magicLink":null,"magicLinkGranted":false,"mediaContext":null,"fetchedSettings":{"wait_time":0}},"freshMenu":{"items":[{"id":"fixture-cola","name":"Кола","category_name":"Напитки","price":700,"composition":"Вода, сахар","available":true},{"id":"fixture-sprite","name":"Спрайт","category_name":"Напитки","price":650,"composition":"Вода, сахар","available":true},{"id":"fixture-doner","name":"Донер куриный","category_name":"Донеры","price":1800,"composition":"Курица, лаваш, томат","available":true},{"id":"fixture-caesar","name":"Цезарь","category_name":"Салаты","price":2200,"composition":"Курица, салат","available":true}],"source":"R44-v2"},"issuerSucceeds":true},{"id":"priced_resend__unconfirmed_wait","input":"Отправьте ссылку снова: Кола.","state":"unconfirmed_wait","context":{"instanceId":"independent-wave5-pair-priced_resend__unconfirmed_wait","phone":"synthetic-customer","text":"Отправьте ссылку снова: Кола.","language":"ru","config":{"domain":"https://fixture.invalid"},"runtimeStatus":{"runtime_available":true,"is_accepting_orders":true,"within_work_hours":true,"is_emergency":false,"wait_time":60},"hardRealtimeContext":{"runtime_available":true,"is_accepting_orders":true,"within_work_hours":true,"is_emergency":false,"wait_time":60},"activeOrder":null,"chatHistory":[],"activeShiftNotes":[],"menuSnapshot":{"items":[{"id":"fixture-cola","name":"Кола","category_name":"Напитки","price":700,"composition":"Вода, сахар","available":true},{"id":"fixture-sprite","name":"Спрайт","category_name":"Напитки","price":650,"composition":"Вода, сахар","available":true},{"id":"fixture-doner","name":"Донер куриный","category_name":"Донеры","price":1800,"composition":"Курица, лаваш, томат","available":true},{"id":"fixture-caesar","name":"Цезарь","category_name":"Салаты","price":2200,"composition":"Курица, салат","available":true}],"source":"R44-v2"},"explicitMenuLinkIntent":true,"magicLink":null,"magicLinkGranted":false,"mediaContext":null,"fetchedSettings":{"wait_time":60}},"freshMenu":{"items":[{"id":"fixture-cola","name":"Кола","category_name":"Напитки","price":700,"composition":"Вода, сахар","available":true},{"id":"fixture-sprite","name":"Спрайт","category_name":"Напитки","price":650,"composition":"Вода, сахар","available":true},{"id":"fixture-doner","name":"Донер куриный","category_name":"Донеры","price":1800,"composition":"Курица, лаваш, томат","available":true},{"id":"fixture-caesar","name":"Цезарь","category_name":"Салаты","price":2200,"composition":"Курица, салат","available":true}],"source":"R44-v2"},"issuerSucceeds":true},{"id":"conditional_method__normal_issue_failure","input":"Если хочу колу, можно заказать?","state":"normal","context":{"instanceId":"independent-wave5-pair-conditional_method__normal_issue_failure","phone":"synthetic-customer","text":"Если хочу колу, можно заказать?","language":"ru","config":{"domain":"https://fixture.invalid"},"runtimeStatus":{"runtime_available":true,"is_accepting_orders":true,"within_work_hours":true,"is_emergency":false,"wait_time":0},"hardRealtimeContext":{"runtime_available":true,"is_accepting_orders":true,"within_work_hours":true,"is_emergency":false,"wait_time":0},"activeOrder":null,"chatHistory":[],"activeShiftNotes":[],"menuSnapshot":{"items":[{"id":"fixture-cola","name":"Кола","category_name":"Напитки","price":700,"composition":"Вода, сахар","available":true},{"id":"fixture-sprite","name":"Спрайт","category_name":"Напитки","price":650,"composition":"Вода, сахар","available":true},{"id":"fixture-doner","name":"Донер куриный","category_name":"Донеры","price":1800,"composition":"Курица, лаваш, томат","available":true},{"id":"fixture-caesar","name":"Цезарь","category_name":"Салаты","price":2200,"composition":"Курица, салат","available":true}],"source":"R44-v2"},"explicitMenuLinkIntent":true,"magicLink":null,"magicLinkGranted":false,"mediaContext":null,"fetchedSettings":{"wait_time":0}},"freshMenu":{"items":[{"id":"fixture-cola","name":"Кола","category_name":"Напитки","price":700,"composition":"Вода, сахар","available":true},{"id":"fixture-sprite","name":"Спрайт","category_name":"Напитки","price":650,"composition":"Вода, сахар","available":true},{"id":"fixture-doner","name":"Донер куриный","category_name":"Донеры","price":1800,"composition":"Курица, лаваш, томат","available":true},{"id":"fixture-caesar","name":"Цезарь","category_name":"Салаты","price":2200,"composition":"Курица, салат","available":true}],"source":"R44-v2"},"issuerSucceeds":false}];

async function requestedLinkFailureSource(row: any, changes: any = {}) {
  const ctx = structuredClone(row.context);
  if (changes.text !== undefined) ctx.text = changes.text;
  if (changes.language !== undefined) ctx.language = changes.language;
  if (Object.hasOwn(changes, 'state')) {
    ctx.runtimeStatus = changes.state; ctx.hardRealtimeContext = changes.state ?? { runtime_available: false };
    ctx.fetchedSettings = { ...ctx.fetchedSettings, wait_time: changes.state?.wait_time ?? 0 };
  }
  ctx.explicitMenuLinkIntent = hasExplicitMenuLinkIntent(ctx.text);
  const policy = classifyKitchenSalesPolicyForContext(ctx.runtimeStatus || ctx.hardRealtimeContext, ctx.activeShiftNotes);
  const issuerSucceeds = changes.issuerSucceeds ?? row.issuerSucceeds;
  const replacements = new Map<string, any>(); const redis = await import('../src/services/redis.service.js');
  let minted = 0; let marked = 0; let routed = 0; const calls: string[] = []; const outcomes: any[] = [];
  replacements.set(new URL('../src/services/redis.service.js', import.meta.url).pathname, { ...redis,
    getKitchenCheckoutFingerprint: async () => changes.accepted ? policy.fingerprint : null,
    markKitchenCheckoutStarted: async () => { marked++; }, markMagicLinkSent: async () => { marked++; },
  });
  replacements.set(new URL('../src/services/checkoutIntent.service.js', import.meta.url).pathname, {
    ensureCustomerAccessLink: async (current: any) => { if (!issuerSucceeds) return null; minted++;
      current.magicLink = 'https://fixture.invalid/access/failure-boundary'; return current.magicLink; },
  });
  const promise = await productionSourceWithIO('agent/linkPromise.ts', replacements);
  replacements.set(new URL('../src/agent/linkPromise.js', import.meta.url).pathname, promise);
  const plan = await productionSourceWithIO('agent/toolPolicy.ts', replacements);
  replacements.set(new URL('../src/agent/toolPolicy.js', import.meta.url).pathname, plan);
  const safety = await productionSourceWithIO('services/turnSafetyNet.service.ts', replacements);
  const reply = await safety.answerAgentFailure(ctx, Error('SYNTHETIC_REQUESTED_LINK_FAILURE'),
    async () => { routed++; return { action: 'skipped' }; },
    async (current: any) => { calls.push('actualPromiseGate'); const result = await promise.honorMenuLinkPromise(current, 'Отправлю ссылку.');
      outcomes.push(result); return result.action === 'granted' || Boolean(current.magicLinkGranted && current.magicLink); },
    async (_instance: any, _domain: any, _language: any, options: any) => {
      assert.equal(options?.forceFresh, true); calls.push('freshSearch'); return structuredClone(row.freshMenu);
    }, async () => ({ state: 'not_found' }));
  assert.equal(routed, 0); assert.equal(calls[0], 'freshSearch'); assert.equal(calls.filter(x => x === 'freshSearch').length, 1);
  assert.match(reply, /Кола — 700/iu); return { reply, ctx, minted, marked, calls, outcomes, policy };
}
for (const row of requestedLinkFailureCases) {
  test('the exact requested-link failure explains its current action without losing fresh prices: ' + row.id, async () => {
    const out = await requestedLinkFailureSource(row);
    assert.equal(out.minted, 0); assert.equal(out.marked, 0);
    assert.doesNotMatch(out.reply, /Оформить заказ можно по ссылке ниже|Ссылку.*отправил|сілтемесін төменге жібердім/iu);
    if (row.state === 'closed') {
      assert.match(out.reply, /заказы не принимаем/iu); assert.match(out.reply, /ссылк.*не отправля/iu); assert.match(out.reply, /меню.*здесь/iu);
    } else if (row.state === 'unknown_runtime') {
      assert.match(out.reply, /не могу.*подтвердить/iu); assert.match(out.reply, /ссылк.*не отправля/iu); assert.match(out.reply, /позже/iu);
      assert.doesNotMatch(out.reply, /заказы не принимаем|закрыт/iu);
    } else if (row.state === 'unconfirmed_wait') {
      assert.match(out.reply, /1 час|60/iu); assert.match(out.reply, /готовы подождать\?/iu); assert.match(out.reply, /ссылк.*не отправля/iu);
    } else {
      assert.match(out.reply, /не удалось отправить ссылку/iu); assert.match(out.reply, /попробуйте.*позже/iu);
      assert.ok(out.outcomes.some(x => x.reason === 'link_issue_failed'));
    }
  });
}
const failureSiblingTexts = [
  'Сколько стоит кола?',
  '«Пришлите ссылку на меню: Кола». Сколько стоит кола?',
  'Пришлите ссылку на меню: Кола. Ссылку не присылайте.',
  'Хочу колу. Не хочу колу. Сколько стоит кола?',
];
for (const row of requestedLinkFailureCases.filter(x => x.id.startsWith('priced_link__'))) {
  for (const text of failureSiblingTexts) {
    test('a nonrequest sibling retains fresh price without forced link failure: ' + row.state + ': ' + text, async () => {
      const out = await requestedLinkFailureSource(row, { text });
      assert.equal(out.minted, 0); assert.equal(out.marked, 0);
      assert.doesNotMatch(out.reply, /не удалось отправить|ссылк.*не отправля|состояние кухни|готовы подождать|заказы не принимаем|попробуйте.*позже/iu);
    });
  }
}
for (const row of requestedLinkFailureCases.filter(x => ['priced_link__closed', 'priced_resend__closed'].includes(x.id))) {
  for (const [name, state, accepted] of [
    ['normal', runtime, false],
    ['off-hours', { ...runtime, is_accepting_orders: false, within_work_hours: false }, false],
    ['accepted-wait', { ...runtime, wait_time: 60 }, true],
  ] as const) {
    test('a successful current link retains its view purpose and grant count: ' + row.id + ': ' + name, async () => {
      const out = await requestedLinkFailureSource(row, { state, accepted });
      assert.equal(out.minted, 1); assert.equal(out.marked, 2); assert.match(out.reply, /для просмотра меню/iu);
      assert.doesNotMatch(out.reply, /не удалось|не отправля|готовы подождать|Оформить заказ можно по ссылке ниже/iu);
    });
  }
}
for (const row of requestedLinkFailureCases.filter(x => x.id.startsWith('priced_link__'))) {
  test('the same blocked link explanation follows current Kazakh reply language: ' + row.state, async () => {
    const out = await requestedLinkFailureSource(row, { text: 'Сілтемені жіберіңіз. Кола.', language: 'kk' });
    assert.equal(out.minted, 0); assert.match(out.reply, /сілтеме.*жібермеймін/iu);
    if (row.state === 'closed') { assert.match(out.reply, /тапсырыс қабылдамаймыз/iu); assert.match(out.reply, /осында/iu); }
    else if (row.state === 'unknown_runtime') { assert.match(out.reply, /растай алмаймын/iu); assert.match(out.reply, /кейін/iu); assert.doesNotMatch(out.reply, /қабылдамаймыз|жабық/iu); }
    else { assert.match(out.reply, /1 сағат|60/iu); assert.match(out.reply, /келісесіз бе\?/iu); }
  });
}
test('a Kazakh normal issuer failure is explained without a phantom link', async () => {
  const row = requestedLinkFailureCases.find(x => x.id === 'conditional_method__normal_issue_failure');
  const out = await requestedLinkFailureSource(row, { text: 'Колаға тапсырыс берейін', language: 'kk' });
  assert.equal(out.minted, 0); assert.match(out.reply, /сілтемені жіберу мүмкін болмады/iu); assert.match(out.reply, /кейін/iu);
});
for (const [name, state, accepted] of [
  ['off-hours', { ...runtime, is_accepting_orders: false, within_work_hours: false }, false],
  ['accepted-wait', { ...runtime, wait_time: 60 }, true],
] as const) {
  test('an allowed view-link issuer failure remains an issue failure rather than a closure: ' + name, async () => {
    const row = requestedLinkFailureCases.find(x => x.id === 'priced_link__closed');
    const out = await requestedLinkFailureSource(row, { state, accepted, issuerSucceeds: false });
    assert.equal(out.minted, 0); assert.match(out.reply, /не удалось отправить ссылку/iu); assert.match(out.reply, /позже/iu);
    assert.doesNotMatch(out.reply, /заказы не принимаем|готовы подождать|ссылку.*отправил/iu);
    assert.ok(out.outcomes.some(x => x.reason === 'link_issue_failed'));
  });
}
