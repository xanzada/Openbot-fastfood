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
