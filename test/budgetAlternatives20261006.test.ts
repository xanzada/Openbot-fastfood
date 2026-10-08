import test from 'node:test';
import assert from 'node:assert/strict';
import { validateFinalText } from '../src/agent/finalValidator.js';
const items:any[]=[{name:'Донер куриный',price:1800,available:true,category:'Еда'},{name:'Фри',price:700,available:true},{name:'Спрайт',price:650,available:true,category:'Напитки'},{name:'Пицца',price:2500,available:true}];
const ctx=(patch:any={})=>({instanceId:'audit-budget-facts',phone:'fixture-guest',language:'kk',text:'2000 теңгеге не аламын?',config:{},chatHistory:[],activeShiftNotes:[],menuSnapshot:{items},...patch} as any);
const grounding={toolsCalled:['searchMenu']};
const raw='Донер куриный (1800 тг) мен Фри (700 тг) бірге ала аласыз. Немесе Донер куриный (1800 тг) және Спрайт (650 тг) алыңыз.';
test('actual K11/t2 draft cannot turn separate affordable products into an over-budget combo',()=>{
 const r=validateFinalText(raw,ctx(),grounding);assert.match(r.text,/бөлек/iu);assert.doesNotMatch(r.text,/бірге|және Спрайт|мен Фри/iu);
 assert.match(r.text,/Донер куриный — 1800 тг/);assert.doesNotMatch(r.text,/2500/);
});
test('Russian inquiry states separate choices and each current price',()=>{
 const r=validateFinalText('Возьмите донер и фри вместе за 2500 тг.',ctx({language:'ru',text:'Что взять на 2000 тенге?'}),grounding);assert.match(r.text,/отдельно/);assert.match(r.text,/Донер куриный — 1800 тг/);assert.doesNotMatch(r.text,/вместе|2500/);
});
test('live changed price beats earlier model amount',()=>{
 const r=validateFinalText(raw,ctx({menuSnapshot:{items:[{name:'Донер куриный',price:2200},{name:'Фри',price:'900'}]}}),grounding);assert.doesNotMatch(r.text,/Донер|1800|700/);assert.match(r.text,/Фри — 900 тг/);
});
for(const [id,patch]of [
 ['sold-out',{menuSnapshot:{items:items.map(i=>({...i,available:i.name!=='Донер куриный'}))}}],
 ['active-note',{activeShiftNotes:[{id:'active',text:'Донер куриный жоқ'}]}],
] as const)test(id,()=>assert.doesNotMatch(validateFinalText(raw,ctx(patch),grounding).text,/Донер/));
test('deleted note no longer forbids current available product',()=>assert.match(validateFinalText(raw,ctx({activeShiftNotes:[]}),grounding).text,/Донер куриный/));
for(const invalid of [true,false,'',' ',NaN,Infinity,{},[],0,-1])test(`invalid-price-${String(invalid)}`,()=>{
 const r=validateFinalText(raw,ctx({menuSnapshot:{items:[{name:'INVALID_PRICE_ITEM',price:invalid},{name:'Фри',price:700}]}}),grounding);assert.doesNotMatch(r.text,/INVALID_PRICE_ITEM/);assert.match(r.text,/Фри — 700 тг/);
});
test('no fitting confirmed prices is scoped to inspected confirmed positions',()=>{
 const r=validateFinalText(raw,ctx({menuSnapshot:{items:[{name:'Пицца',price:2500}]}}),grounding);assert.doesNotMatch(r.text,/2500|Донер|Спрайт/);assert.match(r.text,/расталған|подтвержд/);
});
for(const [id,patch,scope]of [
 ['lookup-unavailable',{menuSnapshot:{source:'menu_unavailable',items}},grounding],
 ['no-current-read',{},{}],
 ['missing-catalog',{menuSnapshot:null},grounding],
 ['failed-grounding',{menuGrounding:{menu_lookup:'unavailable'}},grounding],
]as const)test(id,()=>{const r=validateFinalText(raw,ctx(patch),scope);assert.doesNotMatch(r.text,/1800|700|650|2500/);assert.match(r.text,/растай алмай|подтвердить/);});
test('separate explicit URL survives budget advice while checkout still depends on its own guards',()=>{
 const r=validateFinalText(raw+' https://fixture.invalid/menu',ctx({text:'2000 теңгеге не аламын? Сілтемені жіберіңіз.',magicLinkGranted:true,magicLink:'https://fixture.invalid/menu',explicitMenuLinkIntent:true}),grounding);assert.match(r.text,/бөлек/);assert.match(r.text,/https:\/\/fixture.invalid\/menu/);assert.equal(r.hasLink,true);
});
for(const [id,text,history]of [
 ['genuine-order','Екі донер аламын, 2000 теңгем бар',[]],
 ['health-now','Аллергия на орехи. Что взять на 2000 тенге?',[]],
 ['health-continuation','Что взять на 2000 тенге?',[{role:'user',content:'У ребёнка аллергия на орехи'}]],
 ['diet','Без мяса, что взять на 2000 тенге?',[]],
 ['operator-request','Что взять на 2000 тенге? Хочу живого оператора.',[]],
 ['status-question','Что взять на 2000 тенге? Где мой заказ?',[]],
 ['payment-question','Что взять на 2000 тенге? Я уже оплатил.',[]],
 ['ingredients-question','Что взять на 2000 тенге? Что в составе донера?',[]],
 ['kitchen-question','Что взять на 2000 тенге? Кухня открыта?',[]],
] as const)test(id,()=>{const candidate='Подтвердить подходящий вариант пока не могу.';assert.equal(validateFinalText(candidate,ctx({language:'ru',text,chatHistory:history}),grounding).text,candidate);});
test('budgeted drinks question does not substitute meals for drinks',()=>{
 const r=validateFinalText(raw,ctx({language:'ru',text:'Что взять попить на 2000 тенге?'}),grounding);assert.match(r.text,/Спрайт — 650 тг/);assert.doesNotMatch(r.text,/Донер|Фри|Пицца/);
});


// Actual catalog-shaped facts: the drink is a combo component, not a separate SKU.
const actualFirstVoiceBudget20261008 = "Ассалаумағалейкум, брат. Заказ берейін деп едім ғой. Не бар сендерде, қарным ашып тұр. Екі мың теңгем бар менде, басқа жоқ.";
const actualBudgetItems20261008 = [
 {name:"Донер",price:1000,available:true,category_name:"Донер",composition:"Мәзірдегі донер"},
 {name:"Донер комбо",price:1800,available:true,category_name:"Донер",composition:"Донер, 0,5 л сусын, таңдауға екі тұздық."},
 {name:"4 сезона суши",price:2500,available:true,category_name:"Суши",composition:"Мәзірдегі суши"},
];
const actualBudgetRaw20261008 = "Донер — 1000 теңге. Донер комбо — 1800 теңге. Сондай-ақ, 4 сезона суши 2500 теңге тұрады. Тапсырыс бергіңіз келе ме?";
const actualBudgetContext20261008 = (text:string,patch:any={}) => ctx({
 text,language:"kk",menuSnapshot:{items:actualBudgetItems20261008},
 chatHistory:[{role:"user",text:"Здравствуйте",language:"ru"}],
 activeOrder:{order_id:98,status:"confirmed"},...patch
});
for (const text of [
 actualFirstVoiceBudget20261008,
 "2000 теңгеге не келеді?",
 "Хочу заказать. Что можно взять на 2000 тенге?",
]) test("menu-budget actual20261008 affordable generic pre-order: "+text,()=>{
 const r=validateFinalText(actualBudgetRaw20261008,actualBudgetContext20261008(text),grounding);
 assert.ok(r.warnings.includes("budget_alternatives_grounded"),JSON.stringify(r));
 assert.match(r.text,/Донер — 1000 тг/);
 assert.match(r.text,/Донер комбо — 1800 тг/);
 assert.doesNotMatch(r.text,/2500|4 сезона суши/);
});
test("menu-budget actual20261008 exact affordable boundary and separate choices",()=>{
 const r=validateFinalText(actualBudgetRaw20261008,actualBudgetContext20261008("2000 теңгеге не келеді?",{
  menuSnapshot:{items:[...actualBudgetItems20261008,{name:"Цезарь",price:2000,available:true}]}
 }),grounding);
 assert.match(r.text,/Цезарь — 2000 тг/);assert.doesNotMatch(r.text,/2500|бірге/);assert.match(r.text,/бөлек/);
});
test("menu-budget actual20261008 cannot offer sold-out, blocked or invalid-price positions",()=>{
 const r=validateFinalText(actualBudgetRaw20261008,actualBudgetContext20261008("2000 теңгеге не келеді?",{
  activeShiftNotes:[{id:"owned-fixture",text:"Донер комбо жоқ"}],
  menuSnapshot:{items:[{...actualBudgetItems20261008[0],available:false},actualBudgetItems20261008[1],actualBudgetItems20261008[2],{name:"Bad price",price:null}]}
 }),grounding);
 assert.ok(r.warnings.includes("budget_alternatives_grounded"));assert.doesNotMatch(r.text,/Донер|Bad price|2500/);assert.match(r.text,/расталған|подтвержд/);
});
test("menu-budget actual20261008 unavailable lookup never quotes stale affordable facts",()=>{
 const r=validateFinalText(actualBudgetRaw20261008,actualBudgetContext20261008("2000 теңгеге не келеді?",{
  menuGrounding:{menu_lookup:"unavailable"}
 }),grounding);
 assert.doesNotMatch(r.text,/1000|1800|2500|Донер/);assert.match(r.text,/растай алмай/);
});
test("menu-budget actual20261008 independent requested URL survives affordable guidance",()=>{
 const url="https://fixture.invalid/owned-menu";
 const r=validateFinalText(actualBudgetRaw20261008+" "+url,actualBudgetContext20261008(actualFirstVoiceBudget20261008+" Сілтемені жіберіңіз.",{
  magicLink:url,magicLinkGranted:true,explicitMenuLinkIntent:true
 }),grounding);
 assert.ok(r.warnings.includes("budget_alternatives_grounded"));assert.ok(r.text.includes(url));assert.doesNotMatch(r.text,/2500/);
});
for (const text of [
 "2000 теңгеге не келеді? Екі донер аламын.",
 "2000 теңгеге не келеді? Оформите заказ.",
 "2000 теңгеге не келеді? Измените заказ 98.",
 "2000 теңгеге не келеді? Отмените заказ 98.",
 "2000 теңгеге не келеді? Где мой заказ?",
 "2000 теңгеге не келеді? Заказ №98.",
 "2000 теңгеге не келеді? Я уже оплатил 2000 тенге.",
 "2000 теңгеге не келеді? Аллергия на орехи.",
] as const) test("menu-budget actual20261008 independent action/safety preserved: "+text,()=>{
 const r=validateFinalText("Уточните, пожалуйста.",actualBudgetContext20261008(text),grounding);
 assert.ok(!r.warnings.includes("budget_alternatives_grounded"),JSON.stringify(r));
});
for(const text of [actualFirstVoiceBudget20261008,"2000 теңгеге не келеді?"]) test("menu-budget actual20261008 full STT to fresh-menu budget chain: "+text,async()=>{
 const {voiceTranscriptForAgent}=await import("../src/services/mediaAnalysis.service.js");
 const {resolveAgentToolPlan}=await import("../src/agent/toolPolicy.js");
 const {groundMenuTurn}=await import("../src/skills/searchMenu.skill.js");
 const {hasCustomerCheckoutIntent}=await import("../src/utils/orderIntent.js");
 const transcript=voiceTranscriptForAgent({type:"reply",transcript:text},"audio/ogg");
 assert.equal(transcript,text);
 const c=actualBudgetContext20261008(transcript,{mediaContext:{kind:"audio"},menuSnapshot:{items:[{name:"STALE",price:50}]}});
 const plan=resolveAgentToolPlan(c);assert.equal(plan.requiredTools[0],"searchMenu");
 if(text==="2000 теңгеге не келеді?")assert.equal(hasCustomerCheckoutIntent(text),false);
 let reads=0;
 const result:any=await groundMenuTurn(c,(async(instance:string,domain:string,language:string,options:any)=>{
  reads++;assert.equal(language,"kk");assert.deepEqual(options,{forceFresh:true});
  return {items:actualBudgetItems20261008,source:"owned-menu-fixture"};
 })as any);
 assert.equal(reads,1);assert.deepEqual(c.menuSnapshot.items,actualBudgetItems20261008);
 const out=validateFinalText(actualBudgetRaw20261008,c,{toolsCalled:["searchMenu"]});
 assert.ok(out.warnings.includes("budget_alternatives_grounded"));assert.doesNotMatch(out.text,/2500|STALE/);
 assert.equal(reads,1);
});
test("menu-budget actual20261008 legitimate combo component survives an ordinary non-budget read",async()=>{
 const {groundMenuTurn}=await import("../src/skills/searchMenu.skill.js");
 const c=actualBudgetContext20261008("Донер комбо құрамы қандай?");
 const result:any=await groundMenuTurn(c,(async()=>({items:actualBudgetItems20261008,source:"owned-menu-fixture"}))as any);
 const combo=result.items.find((i:any)=>i.name==="Донер комбо");
 assert.ok(combo);assert.equal(combo.price,1800);assert.match(combo.ingredients,/0,5 л сусын/);
 assert.ok(!c.menuSnapshot.items.some((i:any)=>i.name==="0,5 л сусын"));
});


for (const action of ["Тапсырыс жаса.", "Тапсырыс бер.", "Тапсырыс жасаңыз.", "Тапсырыс беріңіз.", "Закажи.", "Закажите."]) {
 test("menu-budget actual20261008 actual imperative preserved: "+action,()=>{
  const r=validateFinalText("Уточните, пожалуйста.",actualBudgetContext20261008("2000 теңгеге не келеді? "+action),grounding);
  assert.ok(!r.warnings.includes("budget_alternatives_grounded"),JSON.stringify(r));
 });
}

test("menu-budget actual20261008 no-other-money clause preserves current food ceiling",()=>{
 const text="Қарным аш, екі мың теңгем бар, басқа ақшам жоқ";
 const r=validateFinalText(actualBudgetRaw20261008,actualBudgetContext20261008(text),grounding);
 assert.ok(r.warnings.includes("budget_alternatives_grounded"),JSON.stringify(r));
 assert.doesNotMatch(r.text,/2500/);assert.match(r.text,/1000|1800/);
});
for(const action of ["Ақшам қайда?", "Ақшамды қайтарыңыз."]) {
 test("menu-budget actual20261008 real money action preserved: "+action,()=>{
  const r=validateFinalText("Уточните, пожалуйста.",actualBudgetContext20261008("2000 теңгеге не келеді? "+action),grounding);
  assert.ok(!r.warnings.includes("budget_alternatives_grounded"),JSON.stringify(r));
 });
}
