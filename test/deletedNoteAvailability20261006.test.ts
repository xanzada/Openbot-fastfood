import test from 'node:test';
import assert from 'node:assert/strict';
import { validateFinalText } from '../src/agent/finalValidator.js';

// Catalog availability is not a claim about physical inventory or quantity.
const open = {runtime_available:true,is_accepting_orders:true,within_work_hours:true,is_emergency:false,wait_time:0};
const ctx = (extra:any={}) => ({
  instanceId:'deleted-note-fixture',phone:'fixture-guest',text:'Маған кола керек',language:'kk',config:{},
  fetchedSettings:{wait_time:0},runtimeStatus:open,hardRealtimeContext:open,activeOrder:null,activeShiftNotes:[],
  menuSnapshot:{items:[{id:'cola',name:'Кола',price:800,available:true},{id:'sprite',name:'Спрайт',price:650,available:true}]},
  menuGrounding:{menu_lookup:'ok',unavailable_now:[]},
  chatHistory:[{role:'assistant',content:'Кола уақытша қолжетімсіз. Спрайт 650 теңге.'}],
  magicLink:null,magicLinkAlreadySent:false,explicitMenuLinkIntent:false,...extra,
} as any);
const source = {toolsCalled:['searchMenu'],toolFindings:{}};
const validate = (reply:string,context:any=ctx()) => validateFinalText(reply,context,source).text;
const denied = /кола[^.!?\n]{0,90}(?:қол\s?жетімсіз|қол\s?жетімді\s+емес|недоступна)/iu;
for(const [name,reply,price] of [
  ['K37t4','Кешіріңіз, кола қазіргі уақытта қолжетімсіз. Бірақ сіз Спрайт сусынын ала аласыз, бағасы 650 теңге. Сізге тапсырыс беру үшін сілтеме жіберейін бе?',800],
  ['K37t5','Кешіріңіз, кола қазіргі уақытта қолжетімсіз. Сіз Спрайт сусынын немесе донер куриный тапсырыс бере алуыңыз мүмкін.',800],
  ['K38t4','Кешіріңіз, бірақ Кола уақытша қол жетімді емес. Оның орнына Спрайт 650 теңге.',850],
  ['K38t5','Кешіріңіз, бірақ Кола уақытша қол жетімді емес. Оның орнына Спрайт 650 теңге.',850],
] as const){
  test(`current exact SKU availability overrides the removed note's old assistant statement: ${name}`,()=>{
    const context=ctx();context.menuSnapshot.items[0].price=price;
    const result=validate(reply,context);
    assert.doesNotMatch(result,denied);assert.match(result,/Кола/iu);
    assert.doesNotMatch(result,/(?:склад|қойма|запас)[^.!?]{0,30}\d|\d+\s*(?:штук|дана)/iu);
  });
}
test('the same fresh catalog contradiction in Russian is corrected',()=>{
  assert.doesNotMatch(validate('Кола сейчас недоступна. Спрайт стоит 650 тенге.',ctx({language:'ru',text:'Мне нужна кола'})),denied);
});
for(const [name,extra] of [
  ['active blocking note',{activeShiftNotes:[{id:'current-note',text:'Кола временно недоступна'}]}],
  ['explicit sold out',{menuSnapshot:{items:[{id:'cola',name:'Кола',price:800,available:false},{id:'sprite',name:'Спрайт',price:650,available:true}]}}],
  ['unknown availability',{menuSnapshot:{items:[{id:'cola',name:'Кола',price:800},{id:'sprite',name:'Спрайт',price:650,available:true}]}}],
  ['failed fresh catalog',{menuGrounding:{menu_lookup:'unavailable'}}],
  ['stale live context',{hardRealtimeContext:{...open,stale:true}}],
  ['current grounded restriction',{menuGrounding:{menu_lookup:'ok',unavailable_now:['Кола']}}],
] as const){
  test(`a real restriction or missing authority does not authorize a positive availability correction: ${name}`,()=>{
    const reply='Кола қазір қолжетімсіз. Спрайт 650 теңге.';
    const output=validate(reply,ctx(extra));
    if(name==='failed fresh catalog'){
      // This fixture has no current snapshot provenance; a failed read cannot
      // certify the cached alternative's price.
      assert.match(output,/Кола қазір қолжетімсіз/u);
      assert.doesNotMatch(output,/Спрайт|650/u);
      assert.doesNotMatch(output,/Кола (?:мәзірде )?(?:қазір )?қолжетімді/u);
    }else assert.equal(output,reply);
  });
}
for(const reply of [
  'Бұрын «Кола қолжетімсіз» деп айттым. Қазір мәзірде Кола 800 теңге.',
  'Коланың нақты қолжетімділігін растай алмаймын.',
  'Кола мәзірде қолжетімді. Бағасы 800 теңге.',
  'Кола қолжетімсіз бе? Қазір мәзірді қараймын.',
]){
  test(`quoted history/question/honest uncertainty/current positive remains: ${reply}`,()=>assert.equal(validate(reply),reply));
}
test('current closed-order refusal is distinct from item availability',()=>{
  const reply='Қазір тапсырыс қабылдамаймыз. Кола мәзірде 800 теңге.';
  assert.equal(validate(reply,ctx({runtimeStatus:{...open,within_work_hours:false},hardRealtimeContext:{...open,within_work_hours:false}})),reply);
});
test('a longer unknown SKU is not declared available from a shorter catalog name',()=>{
  const reply='Кола зеро сейчас недоступна.';
  assert.equal(validate(reply,ctx({language:'ru',text:'Есть Кола зеро?'})),reply);
});
