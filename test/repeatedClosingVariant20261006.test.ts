import test from 'node:test';
import assert from 'node:assert/strict';
import {validateFinalText} from '../src/agent/finalValidator.js';
const closing='Не көмек керек, жаза беріңіз.';
const body='Иә, біз жұмыс істеп тұрмыз!';
const runtime={runtime_available:true,is_accepting_orders:true,within_work_hours:true,is_emergency:false,wait_time:0};
const base:any={instanceId:'audit-closing-variant',phone:'fixture-guest',language:'kk',text:'Сіздер жұмыс істеп тұрсыздар ма?',config:{},activeShiftNotes:[],activeOrder:null,menuSnapshot:{items:[]},runtimeStatus:runtime,hardRealtimeContext:runtime,chatHistory:[]};
const source={toolsCalled:[]};
const assistant=(content:string)=>({role:'assistant',content});
const user=(content:string)=>({role:'user',content});
test('actual K02 third repeated generic invitation leaves working-hours answer',()=>{
 const chatHistory=[user('Ассалаумағалейкум'),assistant(`Уағалейкум ассалам! ${closing}`),user('Қайырлы күн'),assistant(`Қайырлы күн! ${closing}`)];
 assert.equal(validateFinalText(`${body} ${closing}`,{...base,chatHistory},source).text,body);
});
test('same repeated invitation after one prior answered topic is removed',()=>assert.equal(validateFinalText(`${body} ${closing}`,{...base,chatHistory:[assistant(`Мәзірді қарай аласыз. ${closing}`)]},source).text,body));
test('known invitation family also suppresses this generic variant',()=>assert.equal(validateFinalText(`${body} ${closing}`,{...base,chatHistory:[assistant('Қосымша сұрағыңыз болса, жазыңыз.')]},source).text,body));
test('first occurrence remains',()=>assert.equal(validateFinalText(`${body} ${closing}`,base,source).text,`${body} ${closing}`));
test('genuine product clarification remains',()=>{const reply=`${body} Қай мөлшердегі кола керек?`;assert.equal(validateFinalText(reply,{...base,chatHistory:[assistant(closing)]},source).text,reply)});
test('all-invitation answer is never emptied',()=>assert.equal(validateFinalText(closing,{...base,chatHistory:[assistant(closing)]},source).text,closing));
test('customer-only old invitation does not suppress first assistant occurrence',()=>assert.equal(validateFinalText(`${body} ${closing}`,{...base,chatHistory:[user(closing)]},source).text,`${body} ${closing}`));
test('quoted old invitation is not counted',()=>assert.equal(validateFinalText(`${body} ${closing}`,{...base,chatHistory:[assistant(`Сіз «${closing}» деп жаздыңыз.`)]},source).text,`${body} ${closing}`));
test('quoted current invitation is preserved',()=>{const reply=`${body} Сіз «${closing}» деп жаздыңыз.`;assert.equal(validateFinalText(reply,{...base,chatHistory:[assistant(closing)]},source).text,reply)});
test('fresh topic after three answered exchanges preserves a first new invitation',()=>{
 const chatHistory=[assistant(closing),user('Бірінші сұрақ'),assistant('Бірінші жауап.'),user('Екінші сұрақ'),assistant('Екінші жауап.'),user('Үшінші сұрақ'),assistant('Үшінші жауап.')];
 assert.equal(validateFinalText(`${body} ${closing}`,{...base,chatHistory},source).text,`${body} ${closing}`);
});
test('specific error-reporting instruction remains',()=>{const reply='Сілтеме ашылмаса, нақты қай қатені көргеніңізді жаза беріңіз.';assert.equal(validateFinalText(reply,{...base,chatHistory:[assistant(closing)]},source).text,reply)});
