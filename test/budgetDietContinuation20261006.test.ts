import test from 'node:test';
import assert from 'node:assert/strict';
import {validateFinalText} from '../src/agent/finalValidator.js';
const items=[{name:'Донер куриный',price:1800,composition:'Курица, лаваш'},{name:'Овощной салат',price:1300,composition:'Томат, огурец'}];
const base:any={instanceId:'audit-budget-diet',phone:'fixture-guest',language:'ru',text:'Что можно взять на 2000 тенге?',config:{},activeShiftNotes:[],chatHistory:[],menuSnapshot:{items}};
const source={toolsCalled:['searchMenu']};
for(const [id,language,input,prior]of [
 ['prior-RU','ru',base.text,'Я вегетарианец, мясо не ем.'],
 ['prior-KK','kk','2000 теңгеге не аламын?','Мен веганмын, ет жемеймін.'],
 ['prior-no-milk','ru',base.text,'Мне нужна еда без молока.'],
]as const)test(id,()=>{
 const raw=language==='kk'?'Диетаға сай нұсқаны әзірге растай алмаймын.':'Соответствие диете пока подтвердить не могу.';
 assert.equal(validateFinalText(raw,{...base,language,text:input,chatHistory:[{role:'user',content:prior}]},source).text,raw);
});
for(const [id,history]of [
 ['quoted-only',[{role:'user',content:'Он написал «Я вегетарианец, мясо не ем»'}]],
 ['assistant-only',[{role:'assistant',content:'Я вегетарианец, мясо не ем.'}]],
 ['later-new-subject',[{role:'user',content:'Я вегетарианец, мясо не ем.'},{role:'user',content:'Расскажите, как оплатить.'}]],
]as const)test(id,()=>assert.match(validateFinalText('Покажите варианты.',{...base,chatHistory:history},source).text,/каждый вариант отдельно/));
