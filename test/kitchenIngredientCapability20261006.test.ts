import test from 'node:test';
import assert from 'node:assert/strict';
import {validateFinalText} from '../src/agent/finalValidator.js';
const base:any={instanceId:'kitchen-capability-fixture',phone:'fixture-guest',language:'kk',text:'Баламда жаңғаққа аллергия бар',config:{},chatHistory:[],activeOrder:null,activeShiftNotes:[],runtimeStatus:{runtime_available:true,is_accepting_orders:true,within_work_hours:true,is_emergency:false,wait_time:0},hardRealtimeContext:{runtime_available:true},fetchedSettings:{},menuSnapshot:{items:[{id:'doner',name:'Донер куриный',price:1800,composition:'Курица, лаваш, томат',available:true}]},menuGrounding:{menu_lookup:'ok'},magicLink:null,magicLinkGranted:false,explicitMenuLinkIntent:false,operatorCaseCreated:false,adminNotificationAccepted:false};
const source={toolsCalled:['searchMenu'],toolFindings:{}};
const actual2='Сондықтан мен жаңғақтың болуына кепілдік бере алмаймын. Егер сіз нақты бір тағам туралы сұрасаңыз, мен асханадан тексеру жасай аламын. Кандай тағамды меңзеп тұрсыз?';
const actual3='Жаңғақтың болуына кепілдік бере алмаймын. Сізге қандай тағам туралы айтып отырсыз, мен асханадан тексеру жасауға дайынмын?';
for(const [id,reply] of [['actual-K09t2',actual2],['actual-K09t3',actual3]] as const){
  test(`${id}: unsupported physical kitchen-checking offer is removed while honest denial survives`,()=>{
    const result=validateFinalText(reply,base,source);
    assert.doesNotMatch(result.text,/асханадан\s+тексеру\s+жасай|асханадан\s+тексеру\s+жасауға\s+дайын/iu);
    assert.match(result.text,/кепілдік бере алмаймын/iu);
    assert.doesNotMatch(result.text,/Өтінішіңіз тіркелді|хабарластық|жібердік/iu);
  });
}
for(const [id,reply,language,tools] of [
  ['actual-runtime-only-authority','Мен асханадан тексеру жасай аламын.','kk',['getKitchenStatus']],
  ['KK-conditional-capability','Егер қаласаңыз мен асханадан тексеру жасай аламын.','kk',['searchMenu']],
  ['KK-readiness','Мен асханадан тексеру жасауға дайынмын.','kk',['searchMenu']],
  ['RU-physical-ingredient-capability','Могу уточнить состав у повара.','ru',['searchMenu']],
  ['RU-conditional-physical-capability','Если хотите, могу проверить состав на кухне.','ru',['getKitchenStatus']],
  ['existing-RU-future-promise','Уточню состав на кухне.','ru',['searchMenu']],
] as const){
  test(`no tool authorizes physical kitchen ingredient-check capability: ${id}`,()=>{
    const result=validateFinalText(reply,{...base,language}, {toolsCalled:[...tools],toolFindings:{}});
    assert.doesNotMatch(result.text,/асханадан\s+тексеру\s+жасай|асханадан\s+тексеру\s+жасауға\s+дайын|могу\s+(?:уточнить|проверить)[^.!?]*(?:повар|кухн)|уточню[^.!?]*кухн/iu);
    assert.ok(result.text.trim());
    assert.doesNotMatch(result.text,/Өтінішіңіз тіркелді|Ваша просьба зарегистрирована|хабарластық|уведомлён/iu);
  });
}
for(const [id,reply,language,text] of [
  ['catalog-capability','Нақты тағамды айтсаңыз, мәзірдегі құрамын тексере аламын.','kk',base.text],
  ['conditional-catalog','Егер қаласаңыз, мәзірдегі құрамды тексере аламын.','kk',base.text],
  ['runtime-capability','Асүйдің ағымдағы күйін тексере аламын.','kk','Асүйдің күйін тексере аласыз ба?'],
  ['RU-runtime-capability','Могу проверить текущий статус кухни.','ru','Можете проверить статус кухни?'],
  ['explicit-KK-denial','Асханадан тексеру жасай алмаймын. Мәзірдегі құрамды тексере аламын.','kk',base.text],
  ['explicit-RU-denial','Не могу проверить состав на кухне. Могу посмотреть состав в меню.','ru','Что в составе?'],
  ['quoted-denial','«Асханадан тексеру жасай аламын» деп айтпаймын. Мәзірдегі деректерге сүйенемін.','kk',base.text],
] as const){
  test(`truthful catalog/runtime capability and quoted/explicit denial remain: ${id}`,()=>assert.equal(validateFinalText(reply,{...base,language,text},source).text,reply));
}
test('a recorded past handoff stays truthful without asserting an ingredient check occurred',()=>{
  const reply='Операторға хабарластық.';
  const result=validateFinalText(reply,{...base,text:'Оператор керек'}, {toolsCalled:['escalateToAdmin'],toolFindings:{escalationCreated:true,escalationNotificationAccepted:true}});
  assert.equal(result.text,reply);
});
test('a recorded handoff does not establish physical kitchen ingredient verification',()=>{
  const result=validateFinalText('Мен асханадан тексеру жасай аламын.',base,{toolsCalled:['escalateToAdmin'],toolFindings:{escalationCreated:true,escalationNotificationAccepted:true}});
  assert.doesNotMatch(result.text,/асханадан\s+тексеру\s+жасай/iu);
  assert.doesNotMatch(result.text,/құрамын растадым|тексердім/iu);
});
for(const [language,reply] of [
  ['kk',"'Асханадан тексеру жасай аламын' деп айтпаймын. Мәзірдегі деректерге сүйенемін."],
  ['kk','‘Асханадан тексеру жасай аламын’ деп айтпаймын. Мәзірдегі деректерге сүйенемін.'],
  ['ru',"Клиент сказал 'Могу уточнить состав у повара'. Могу посмотреть состав в меню."],
] as const){
  test(`a quoted capability cannot create a current kitchen-checking promise: ${reply}`,()=>assert.equal(validateFinalText(reply,{...base,language},source).text,reply));
}
