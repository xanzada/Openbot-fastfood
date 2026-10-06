import test from 'node:test';
import assert from 'node:assert/strict';
process.env.REDIS_URL='redis://127.0.0.1:1';
process.env.REDIS_CONNECT_TIMEOUT_MS='100';
process.env.REDIS_OPERATION_TIMEOUT_MS='100';
const {resolveAgentToolPlan}=await import('../src/agent/toolPolicy.js');
const {validateFinalText}=await import('../src/agent/finalValidator.js');
const {redisClient}=await import('../src/services/redis.service.js');
test.after(()=>{if(redisClient.isOpen)redisClient.destroy();});
const open={runtime_available:true,is_accepting_orders:true,within_work_hours:true,is_emergency:false,wait_time:0};
const closed={...open,is_accepting_orders:false,is_emergency:true};
const busy={...open,wait_time:60};
const ctx=(text:string,extra:any={})=>({instanceId:'browse-scope-fixture',phone:'fixture-guest',language:'kk',text,config:{},fetchedSettings:{wait_time:0},activeShiftNotes:[],activeOrder:null,menuSnapshot:{items:[{id:'cola',name:'Кола',price:850,composition:'Вода, сахар',available:true}]},menuGrounding:{menu_lookup:'ok'},runtimeStatus:open,hardRealtimeContext:open,chatHistory:[],magicLink:null,magicLinkGranted:false,magicLinkAlreadySent:false,explicitMenuLinkIntent:false,...extra} as any);
for(const [name,runtime] of [['closed',closed],['wait-without-consent',busy]] as const){
  for(const text of ['Мәзірді ғана қараймын','Мәзірді ғана қарап шығайын','Мазирди гана караймын','Просто посмотрю меню','Хочу посмотреть меню','Сілтеме керек емес, мәзірді қараймын']){
    test(`${name}: current unquoted menu browsing requires fresh catalog: ${text}`,()=>{
      const plan=resolveAgentToolPlan(ctx(text,{runtimeStatus:runtime,hardRealtimeContext:runtime}));
      assert.ok(plan.requiredTools.includes('searchMenu'));
      assert.equal(plan.requiredTools.includes('sendMenuLink'),false);
    });
  }
}
for(const text of ['Мәзірде не бар?','Мәзірді осында жазып жіберіңіз','Напишите меню здесь','Кола алайын','Құрамы қандай?']){
  test(`existing menu/product lookup remains available during closure: ${text}`,()=>assert.ok(resolveAgentToolPlan(ctx(text,{runtimeStatus:closed})).requiredTools.includes('searchMenu')));
}
for(const text of ['Сәлем','Мәзірді қарамаймын','Меню не нужно','Не хочу смотреть меню','Клиент «Мәзірді ғана қараймын» деп жазды','Клиент написал "Хочу посмотреть меню"','Тапсырысты тоқтатыңыз','Как оплатить?']){
  test(`a greeting/refusal/quote/other task does not become new menu browsing: ${text}`,()=>assert.equal(resolveAgentToolPlan(ctx(text)).requiredTools.includes('searchMenu'),false));
}
test('prior browsing alone does not pin a new greeting lookup',()=>assert.equal(resolveAgentToolPlan(ctx('Сәлем',{chatHistory:[{role:'user',content:'Мәзірді ғана қараймын'}]})).requiredTools.includes('searchMenu'),false));
test('an explicit link request keeps its existing route when open',()=>assert.deepEqual(resolveAgentToolPlan(ctx('Сілтемені жіберіңіз')).requiredTools,['sendMenuLink']));
test('an explicit link request remains blocked during closure',()=>assert.equal(resolveAgentToolPlan(ctx('Сілтемені жіберіңіз',{runtimeStatus:closed})).requiredTools.includes('sendMenuLink'),false));
const link='https://fixture.invalid/order/current';
const linkCtx=(extra:any={})=>ctx('Маған кола керек',{magicLink:link,magicLinkGranted:true,explicitMenuLinkIntent:true,...extra});
const source={toolsCalled:['searchMenu','sendMenuLink'],toolFindings:{}};
for(const [name,language,reply,keep] of [
  ['actual flattened country and month','kk','Кола 850 теңге тұрады. Сатып алу үшін мына сілтемені пайдаланыңыз: Тапсырыс беру Қазақстан бойынша 1 ай бойы жарамды.',/1 ай бойы жарамды/],
  ['markdown country and month','kk',`Кола 850 теңге тұрады. Сатып алу үшін сілтеме: [Тапсырыс беру](${link})\n\nҚазақстан бойынша 1 ай бойы жарамды.`,/1 ай бойы жарамды/],
  ['RU country and supported month','ru','Кола стоит 850 тенге. Ссылка действительна по всему Казахстану в течение месяца.',/в течение месяца/],
] as const){
  test(`unsupported granted-link geography is removed without erasing supported facts: ${name}`,()=>{
    const result=validateFinalText(reply,linkCtx({language}),source);
    assert.doesNotMatch(result.text,/Қазақстан\s+бойынша|по\s+всему\s+Казахстану/iu);
    assert.match(result.text,/850/);assert.match(result.text,keep);
    if(reply.includes(link))assert.ok(result.text.includes(link));
  });
}
for(const [language,text,reply] of [
  ['kk','Сілтеме қанша уақыт жарамды?','Сілтеме бір ай жарамды.'],
  ['ru','Сколько действует ссылка?','Ссылка действительна один месяц.'],
  ['kk','Маған кола керек','Қазақстан бойынша жарамдылығын растай алмаймын. Сілтемені пайдаланыңыз.'],
  ['kk','Маған кола керек','«Қазақстан бойынша жарамды» деп айтпаймын. Сілтемені пайдаланыңыз.'],
  ['ru','Мне нужна кола','Не могу подтвердить, что ссылка действует по всему Казахстану.'],
  ['ru','Мне нужна кола','Ссылка действует по всему Казахстану? Этого не могу подтвердить.'],
  ['kk','Маған кола керек',`Кола 850 теңге тұрады. Сілтемені пайдаланыңыз:\n${link}`],
  ['ru','Мне нужна кола','Доставка по всему Казахстану доступна. Ссылка действительна один месяц.'],
] as const){
  test(`supported duration, truthful scope uncertainty, questions and separate delivery facts survive: ${reply}`,()=>assert.equal(validateFinalText(reply,linkCtx({language,text}),source).text,reply));
}
test('customer territory is no authority for granted-link geography',()=>{
  const result=validateFinalText('Ссылка действительна по всему Казахстану один месяц.',linkCtx({language:'ru',text:'Живу в Казахстане. Мне нужна кола'}),source);
  assert.doesNotMatch(result.text,/по всему Казахстану/iu);assert.match(result.text,/один месяц/);
});
const closing='Қосымша сұрағыңыз болса, жазыңыз!';
const prior=[{role:'assistant',content:`Кола туралы жауап. ${closing}`}];
for(const [name,reply,expected] of [
  ['flattened link label',`Сатып алу үшін сілтеме: Тапсырыс беру ${closing}`,'Сатып алу үшін сілтеме: Тапсырыс беру'],
  ['emoji after punctuation',`Кола туралы жауап. 😊 ${closing}`,'Кола туралы жауап. 😊'],
  ['known invitation with optional if',`Кола туралы жауап! 🙂 Егер қосымша сұрағыңыз болса, жазыңыз!`,'Кола туралы жауап! 🙂'],
] as const){
  test(`repeated known closing after a real answer is removed: ${name}`,()=>assert.equal(validateFinalText(reply,linkCtx({chatHistory:prior}),source).text,expected));
}
for(const reply of [closing,`Кола туралы жауап. 😊 ${closing}`,`Сіз «${closing}» деп жаздыңыз.`,`Сілтеме: ${link}\nҚай мөлшердегі кола керек?`]){
  test(`first helpful closing, quotations and genuine questions are preserved: ${reply}`,()=>assert.equal(validateFinalText(reply,linkCtx(),source).text,reply));
}
test('repeated closing removal retains the exact granted URL and safety disclaimer',()=>{
  const reply=`Сілтеме: ${link}. Жаңғақ жоқ екеніне кепілдік бере алмаймын. 😊 ${closing}`;
  const result=validateFinalText(reply,linkCtx({chatHistory:prior}),source);
  assert.ok(result.text.includes(link));assert.match(result.text,/кепілдік бере алмаймын/);assert.doesNotMatch(result.text,/Қосымша сұрағыңыз/);
});
test('old closing outside the last six total messages does not suppress a first current closing',()=>{
  const chatHistory=[...prior,...Array.from({length:6},(_,i)=>({role:i%2?'assistant':'user',content:'Басқа жауап.'}))];
  const reply=`Кола туралы жауап. 😊 ${closing}`;
  assert.equal(validateFinalText(reply,linkCtx({chatHistory}),source).text,reply);
});
for(const text of ['Меню смотреть не буду','Меню смотреть не хочу','Меню посмотрю. Нет, меню мне не нужно.','Мәзірді қараймын. Жоқ, мәзір керек емес.']){
  test(`current menu browsing is withdrawn by its own later/postposed refusal: ${text}`,()=>{
    const plan=resolveAgentToolPlan(ctx(text,{runtimeStatus:closed,menuSnapshot:{items:[]}}));
    assert.equal(plan.requiredTools.includes('searchMenu'),false);
    assert.equal(plan.requiredTools.includes('sendMenuLink'),false);
  });
}
for(const text of ['Меню смотреть не буду. Но сейчас меню хочу посмотреть.','Оператора не надо, меню посмотрю.']){
  test(`actual later browsing restoration or unrelated refusal retains catalog lookup: ${text}`,()=>{
    const plan=resolveAgentToolPlan(ctx(text,{runtimeStatus:closed,menuSnapshot:{items:[]}}));
    assert.ok(plan.requiredTools.includes('searchMenu'));
    assert.equal(plan.requiredTools.includes('sendMenuLink'),false);
  });
}
test('an independent honest medical denial does not authorize a later link-country assertion',()=>{
  const result=validateFinalText('Не могу подтвердить безопасность блюда, ссылка действует по всему Казахстану.',linkCtx({language:'ru',text:'Мне нужна кола'}),source);
  assert.doesNotMatch(result.text,/по всему Казахстану/iu);
  assert.match(result.text,/Не могу подтвердить безопасность блюда/iu);
  assert.match(result.text,/ссылка действует/iu);
});
for(const [language,reply] of [
  ['ru','Ссылка действительна один месяц, доставка по всему Казахстану доступна.'],
  ['kk','Сілтеме бір ай жарамды; Қазақстан бойынша жеткізу қолжетімді.'],
] as const){
  test(`a separate supported delivery predicate retains its territory beside link validity: ${reply}`,()=>{
    assert.equal(validateFinalText(reply,linkCtx({language,businessInfo:{delivery_region:'Казахстан'},syntheticCurrentBusinessDeliverySource:true}),{...source,toolsCalled:[...source.toolsCalled,'getBusinessInfo']}).text,reply);
  });
}
test('an explicitly dependent denied link validity remains truthful',()=>{
  const reply='Не могу подтвердить, что ссылка действует по всему Казахстану.';
  assert.equal(validateFinalText(reply,linkCtx({language:'ru',text:'Где действует ссылка?'}),source).text,reply);
});
