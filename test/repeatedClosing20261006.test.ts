import test from 'node:test';
import assert from 'node:assert/strict';
import {validateFinalText} from '../src/agent/finalValidator.js';
const base:any={instanceId:'audit-style-repeat',phone:'fixture-guest',language:'kk',text:'Донер қанша тұрады?',config:{},activeShiftNotes:[],activeOrder:null,menuSnapshot:{items:[{name:'Донер куриный',price:1800}]},chatHistory:[]};
const source={toolsCalled:['searchMenu']};
for(const [id,language,prior,reply,want]of [
 ['actual-KK-repeat','kk','Кола — 750 тг. Қосымша сұрағыңыз болса, жазыңыз.','Донер куриный — 1800 тг. Қосымша сұрағыңыз болса, жазыңыз.','Донер куриный — 1800 тг.'],
 ['KK-family','kk','Қосымша сұрағыңыз болса, жазыңыз.','Донер куриный — 1800 тг. Мен көмектесуге дайынмын.','Донер куриный — 1800 тг.'],
 ['RU-repeat','ru','Обращайтесь, если возникнут вопросы.','Донер куриный — 1800 тг. Если будут вопросы, напишите.','Донер куриный — 1800 тг.'],
 ['two-closings','kk','Қосымша сұрағыңыз болса, жазыңыз.','Донер куриный — 1800 тг. Қосымша сұрағыңыз болса, жазыңыз. Мен көмектесуге дайынмын.','Донер куриный — 1800 тг.'],
]as const)test(id,()=>assert.equal(validateFinalText(reply,{...base,language,chatHistory:[{role:'assistant',content:prior}]},source).text,want));
for(const [id,prior,reply,role]of [
 ['first-occurrence','Донер куриный — 1800 тг.','Донер куриный — 1800 тг. Қосымша сұрағыңыз болса, жазыңыз.','assistant'],
 ['real-followup','Қосымша сұрағыңыз болса, жазыңыз.','Донер куриный — 1800 тг. Сусын да керек пе?','assistant'],
 ['customer-only','Қосымша сұрағыңыз болса, жазыңыз.','Донер куриный — 1800 тг. Қосымша сұрағыңыз болса, жазыңыз.','user'],
 ['only-closing','Қосымша сұрағыңыз болса, жазыңыз.','Қосымша сұрағыңыз болса, жазыңыз.','assistant'],
 ['quoted-previous','Ол «Қосымша сұрағыңыз болса, жазыңыз» деді.','Донер куриный — 1800 тг. Қосымша сұрағыңыз болса, жазыңыз.','assistant'],
 ['quoted-current','Қосымша сұрағыңыз болса, жазыңыз.','Сіз «Қосымша сұрағыңыз болса, жазыңыз» деп сұрадыңыз.','assistant'],
 ['safety','Қосымша сұрағыңыз болса, жазыңыз.','Гарантировать безопасность при аллергии не могу.','assistant'],
 ['meaningful-instruction','Қосымша сұрағыңыз болса, жазыңыз.','Если не открывается ссылка, напишите, какая ошибка показана.','assistant'],
]as const)test(id,()=>assert.equal(validateFinalText(reply,{...base,language:id==='safety'?'ru':'kk',chatHistory:[{role,content:prior}]},source).text,reply));
test('old history outside bounded recent replies does not suppress first new closing',()=>{
 const reply='Донер куриный — 1800 тг. Қосымша сұрағыңыз болса, жазыңыз.';
 const h=[{role:'assistant',content:'Қосымша сұрағыңыз болса, жазыңыз.'},...Array.from({length:8},()=>({role:'assistant',content:'Мәзір бойынша жауап.'}))];
 assert.equal(validateFinalText(reply,{...base,chatHistory:h},source).text,reply);
});
