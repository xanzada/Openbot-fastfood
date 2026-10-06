import test from 'node:test';
import assert from 'node:assert/strict';
import { buildFactsPrompt } from '../src/context/buildFactsPrompt.js';
import { validateFinalText } from '../src/agent/finalValidator.js';

// Source fixtures only: no transport, provider, customer or business-info API.
const closed = {runtime_available:true,is_accepting_orders:true,within_work_hours:false,is_emergency:false,wait_time:0};
const ctx = (language:'kk'|'ru'='kk',extra:any={}) => ({
  instanceId:'hours-source-fixture',phone:'fixture-guest',text:language==='kk'?'Түнде жұмыс істейсіз бе?':'Вы работаете ночью?',language,
  languagePolicy:{},senderMeta:{},config:{},runtimeStatus:closed,hardRealtimeContext:closed,fetchedSettings:{wait_time:0},
  activeOrder:null,activeShiftNotes:[],activeShiftNotesFingerprint:'',chatHistory:[],shporContext:[],mediaContext:null,
  menuSnapshot:{items:[{id:'cola',name:'Кола',price:750,available:true}]},menuGrounding:{menu_lookup:'ok'},
  magicLink:null,magicLinkAlreadySent:false,explicitMenuLinkIntent:false,...extra,
} as any);
const grounding = {toolsCalled:['getBusinessInfo'],toolFindings:{}};
const validate = (reply:string,context:any) => validateFinalText(reply,context,grounding).text;

for(const config of [{},{work_hours:''},{work_hours:'   '}]) {
  test(`off-hours facts never publish an application default for empty tenant hours: ${JSON.stringify(config)}`,()=>{
    const facts=buildFactsPrompt(ctx('kk',{config}));
    assert.doesNotMatch(facts,/work hours:\s*12:00\s*-\s*03:00/iu);
    assert.match(facts,/outside operating hours/iu);
    assert.match(facts,/browsing the menu/iu);
  });
}
test('configured tenant hours remain in the off-hours facts',()=>{
  assert.match(buildFactsPrompt(ctx('kk',{config:{work_hours:'12:00 - 03:00'}})),/12:00\s*-\s*03:00/u);
});
for(const [language,reply] of [
  ['kk','Кешіріңіз, бірақ дәл сәтте кәсіпорынның жұмыс уақыты туралы ақпарат бере алмаймын. Дегенмен, біз түнде жұмыс істемейміз. Тек күндізгі уақытта, сағат 12:00-ден 03:00-ге дейін қызмет көрсетеміз.'],
  ['ru','Рабочие часы сейчас подтвердить не могу. Однако мы ночью не работаем. Работаем с 12:00 до 03:00.'],
] as const){
  test(`a tool name alone does not authorize missing tenant hours or a blanket night denial: ${language}`,()=>{
    const result=validate(reply,ctx(language));
    assert.doesNotMatch(result,/12:00|03:00|біз\s+түнде\s+жұмыс\s+істемейміз|мы\s+ночью\s+не\s+работаем/iu);
    assert.ok(result.trim());
  });
}
for(const [language,reply] of [
  ['kk','Біз түнде жұмыс істемейміз. Жұмыс уақыты 12:00-ден 03:00-ге дейін.'],
  ['ru','Мы ночью не работаем. Рабочие часы с 12:00 до 03:00.'],
] as const){
  test(`an overnight tenant schedule cannot coexist with a blanket no-night claim: ${language}`,()=>{
    const result=validate(reply,ctx(language,{config:{work_hours:'12:00 - 03:00'}}));
    assert.doesNotMatch(result,/біз\s+түнде\s+жұмыс\s+істемейміз|мы\s+ночью\s+не\s+работаем/iu);
    assert.match(result,/12:00/u);assert.match(result,/03:00/u);
  });
}
for(const [language,reply,config] of [
  ['kk','Жұмыс сағаттарын қазір растай алмаймын. Қазір тапсырыс қабылдамаймыз.',{}],
  ['ru','Не могу сейчас подтвердить рабочие часы. Сейчас заказы не принимаем.',{}],
  ['kk','Жұмыс уақыты 12:00-ден 03:00-ге дейін.',{work_hours:'12:00 - 03:00'}],
  ['ru','Рабочие часы с 12:00 до 03:00.',{work_hours:'12:00 - 03:00'}],
  ['kk','Қазір жабықпыз. Нақты жұмыс кестесін растай алмаймын.',{work_hours:'12:00 - 03:00'}],
  ['ru','Сейчас ночью мы закрыты. Нельзя оформить заказ.',{work_hours:'12:00 - 03:00'}],
  ['ru','Раньше работали с 12:00 до 03:00. Сейчас рабочие часы подтвердить не могу.',{}],
  ['kk','Бұрын «Біз түнде жұмыс істемейміз» деп айттым. Қазір кестені растай алмаймын.',{}],
  ['ru','Не могу утверждать, что мы ночью не работаем. Сейчас закрыты.',{}],
  ['kk','Түнде жұмыс істемейміз бе? Нақты кестені растай алмаймын.',{}],
] as const){
  test(`known hours/current closure/history/denial/question keeps its scope: ${reply}`,()=>{
    assert.equal(validate(reply,ctx(language,{config})),reply);
  });
}
// Equivalent clock formats and a date-less opening forecast share the same
// missing tenant-hours authority, rather than adding another business fact.
for(const reply of ['Работаем с 12 до 03.','Откроемся в 12.']){
  test(`unknown tenant hours do not permit an hour-only schedule or opening forecast: ${reply}`,()=>{
    const result=validate(reply,ctx('ru'));
    assert.doesNotMatch(result,/(?:с|в)\s+12|до\s+03/u);assert.ok(result.trim());
  });
}
test('configured daytime no-night statement keeps the exact supported schedule',()=>{
  const reply='Біз түнде жұмыс істемейміз. Жұмыс уақыты 12:00-ден 18:00-ге дейін.';
  assert.equal(validate(reply,ctx('kk',{config:{work_hours:'12:00 - 18:00'}})),reply);
});
for(const reply of ['Біз 14:00-ден 05:00-ге дейін жұмыс істейміз.','Работаем с 14 до 05.']){
  test(`a known tenant schedule does not authorize a different current range: ${reply}`,()=>{
    const result=validate(reply,ctx(reply.startsWith('Біз')?'kk':'ru',{config:{work_hours:'12:00 - 03:00'}}));
    assert.doesNotMatch(result,/14(?::00)?|05(?::00)?/u);assert.ok(result.trim());
  });
}
for(const [config,reply] of [
  [{work_hours:'12:00 - 03:00'},'Рабочие часы с 12:00 до 3:00.'],
  [{work_hours:'12:00 — 03:00'},'Работаем с 12 до 3.'],
  [{work_hours:'24/7'},'Работаем с 00:00 до 24:00.'],
] as const){
  test(`known schedule comparison preserves equivalent clock formatting: ${reply}`,()=>assert.equal(validate(reply,ctx('ru',{config})),reply));
}
for(const reply of ['Открываемся в 03:00.','Закрываемся в 12:00.']){
  test(`a schedule endpoint must retain its opening/closing role: ${reply}`,()=>{
    assert.doesNotMatch(validate(reply,ctx('ru',{config:{work_hours:'12:00 - 03:00'}})),/03:00|12:00/u);
  });
}
for(const reply of ['Открываемся в 12:00.','Закрываемся в 03:00.']){
  test(`the correct single opening/closing endpoint remains supported: ${reply}`,()=>assert.equal(validate(reply,ctx('ru',{config:{work_hours:'12:00 - 03:00'}})),reply));
}
