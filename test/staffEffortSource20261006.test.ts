import test from 'node:test';
import assert from 'node:assert/strict';
import {validateFinalText} from '../src/agent/finalValidator.js';

// Source-only fixtures. A cooking status does not prove staff expedite intent.
const ctx=(language:'kk'|'ru'='kk')=>({instanceId:'staff-effort-fixture',phone:'fixture-guest',language,
  text:language==='kk'?'Қашан дайын болады?':'Когда будет готово?',config:{},chatHistory:[],activeShiftNotes:[],
  runtimeStatus:{runtime_available:true,is_accepting_orders:true,within_work_hours:true,is_emergency:false,wait_time:0},
  hardRealtimeContext:{runtime_available:true,stale:false},fetchedSettings:{wait_time:0},
  activeOrder:{order_number:'42',status:'cooking',stage:'preparing',items:[{name:'Донер куриный'}]},
  menuSnapshot:{items:[{id:'doner',name:'Донер куриный',price:1800,available:true}]},menuGrounding:{menu_lookup:'ok'},
  magicLink:null,magicLinkGranted:false,magicLinkAlreadySent:false,explicitMenuLinkIntent:false,shporContext:[],
} as any);
const source={toolsCalled:['checkOrderStatus'],toolFindings:{orderFound:true,orderStatus:'cooking',orderStage:'preparing',orderItems:[{name:'Донер куриный'}]}};
const validate=(raw:string,language:'kk'|'ru'='kk')=>validateFinalText(raw,ctx(language),source).text;
for(const reply of [
  'Сіздің тапсырысыңыз 42 номерімен «Донер куриный» тағамы әзірленуде. Дайын болу уақыты әзірге белгісіз, алайда мейрамхана қызметкерлері оны тез арада дайындауға тырысуда. Дайын болғанда хабарлаймыз!',
  'Тапсырысыңыз 42 номерімен «Донер куриный» тағамы әзірленуде. Қазіргі уақытта дайын болу уақыты белгісіз, бірақ мейрамхана қызметкерлері оны тез арада дайындауға тырысуда. Дайын болғанда хабарлаймыз!',
]){
  test(`actual cooking/unknown ETA does not imply current staff urgency: ${reply}`,()=>{
    const result=validate(reply);
    assert.doesNotMatch(result,/қызметкерлері[^.!?]{0,100}тез\s+арада[^.!?]{0,70}тырысуда/iu);
    assert.match(result,/әзірленуде/u);assert.match(result,/уақыты[^.!?]{0,30}белгісіз/u);assert.match(result,/хабарлаймыз/u);
  });
}
for(const reply of ['Сотрудники стараются приготовить заказ как можно скорее.','Повара сейчас ускоряют приготовление заказа.']){
  test(`current Russian staff effort requires its own facts: ${reply}`,()=>{
    const result=validate(reply,'ru');
    assert.doesNotMatch(result,/(?:сотрудники|повара)[^.!?]{0,100}(?:стараются|ускоряют)/iu);assert.ok(result.trim());
  });
}
for(const [language,reply] of [
  ['kk','Тапсырыс 42 әзірленуде. Нақты дайын болу уақыты белгісіз. Дайын болғанда хабарлаймыз.'],
  ['kk','Дайын болған сәтте бірден хабарлаймыз.'],
  ['kk','«Мейрамхана қызметкерлері оны тез арада дайындауға тырысуда» деген мәліметті растай алмаймын. Тапсырыс әзірленуде.'],
  ['ru',"Не могу подтвердить утверждение 'сотрудники стараются приготовить заказ как можно скорее'."],
  ['kk','Қызметкерлер оны тез арада дайындауға тырыса ма? Бұл туралы расталған дерек жоқ.'],
  ['ru','Вчера сотрудники старались приготовить быстрее. Сейчас точное время неизвестно.'],
  ['ru','Сотрудники обычно стараются готовить быстро.'],
  ['kk','Қызметкерлер әдетте тез дайындауға тырысады.'],
] as const){
  test(`staff boundary preserves status/notify/denial/question/past/general policy: ${reply}`,()=>assert.equal(validate(reply,language),reply));
}
for(const [language,reply,keep] of [
  ['kk','Кеше тапсырыс кешікті және қызметкерлер қазір тез арада дайындауға тырысуда.',/Кеше тапсырыс кешікті/u],
  ['ru','Вчера заказ задержался и сотрудники сейчас стараются приготовить как можно скорее.',/Вчера заказ задержался/u],
] as const){
  test(`a historical prefix cannot hide a later explicit current staff observation: ${reply}`,()=>{
    const result=validate(reply,language);
    assert.doesNotMatch(result,/қызметкерлер\s+қазір[^.!?]{0,70}тырысуда|сотрудники\s+сейчас[^.!?]{0,90}стараются/iu);
    assert.match(result,keep);
  });
}
test('a denied dependent current staff observation remains denied after a historical prefix',()=>{
  const reply='Кеше тапсырыс кешікті және қызметкерлер қазір тез арада дайындауға тырысуда екенін растай алмаймын.';
  assert.equal(validate(reply),reply);
});
for(const [language,reply,keep] of [
  ['kk','Кеше тапсырыс кешікті және қызметкерлер оны тез арада дайындауға тырысуда.',/Кеше тапсырыс кешікті/u],
  ['ru','Вчера заказ задержался и сотрудники стараются приготовить как можно скорее.',/Вчера заказ задержался/u],
] as const){
  test(`a present staff predicate remains current without a redundant temporal adverb: ${reply}`,()=>{
    const result=validate(reply,language);
    assert.doesNotMatch(result,/қызметкерлер[^.!?]{0,100}тырысуда|сотрудники[^.!?]{0,100}стараются/iu);assert.match(result,keep);
  });
}
for(const [language,reply] of [
  ['kk','Кеше тапсырыс кешікті және қызметкерлер оны тез арада дайындауға тырысты.'],
  ['kk','Кеше тапсырыс кешікті және қызметкерлер оны тез арада дайындауға тырысуда еді.'],
  ['kk','Кеше тапсырыс кешікті және қызметкерлер оны тез арада дайындауға тырысып жатыр еді.'],
  ['ru','Вчера заказ задержался и сотрудники старались приготовить как можно скорее.'],
  ['kk','Кеше тапсырыс кешікті және қызметкерлер оны тез арада дайындауға тырысуда деп айтылды.'],
  ['kk','Кеше тапсырыс кешікті және қызметкерлер оны тез арада дайындауға тырысуда екенін растай алмаймын.'],
  ['kk','Кеше «қызметкерлер оны тез арада дайындауға тырысуда» деген жауап келді.'],
  ['kk','Кеше тапсырыс кешікті және қызметкерлер әдетте тез арада дайындауға тырысуда.'],
] as const){
  test(`tense/report/denial/quotation/policy governs the staff claim itself: ${reply}`,()=>assert.equal(validate(reply,language),reply));
}
