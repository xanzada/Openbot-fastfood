import test from "node:test";
import assert from "node:assert/strict";
import { validateFinalText } from "../src/agent/finalValidator.js";
import { manualCancellationBoundaryText } from "../src/services/orderAuthority.service.js";
const ctx=(language="kk",extra:any={})=>({instanceId:"audit-final-boundary",language,text:"Операторды шақырыңыз",config:{},chatHistory:[{role:"assistant",text:"Қалай көмектесемін?"}],activeShiftNotes:[],activeOrder:null,menuSnapshot:{items:[]},...extra} as any);
const receipt=(created:boolean,accepted:boolean)=>({toolsCalled:created?["escalateToAdmin"]:[],toolFindings:{escalationCreated:created,escalationNotificationAccepted:accepted}});
test("case registration cannot retain a dependent definite human-contact promise",()=>{
 for(const text of ["Әкімшіге хабарластық. Олар сізбен жақын арада байланысады.","Әкімшіге хабарладық. Ол сізбен байланысады.","Оператор уведомлён. Он скоро свяжется с вами.","Операторға өтініш тіркелді. Олар сізбен жақын арада байланысады.","Ваша просьба зарегистрирована. Оператор скоро ответит."]){
  const language=/[әғқңөұүһі]/iu.test(text)?"kk":"ru";
  const r=validateFinalText(text,ctx(language),receipt(true,false));
  assert.doesNotMatch(r.text,/байланысады|хабарласады|свяжется|скоро ответит/iu,text);
  assert.match(r.text,/тіркел|зарегистрирован/iu,text);
  assert.equal(r.hasLink,false);assert.ok(r.text.trim(),text);
 }
});
test("accepted notification preserves grounded contact and case-only registration remains factual",()=>{
 for(const text of ["Әкімшіге хабарластық.","Оператор уведомлён. Он свяжется с вами."]){
  assert.equal(validateFinalText(text,ctx(/[әғқңөұүһі]/iu.test(text)?"kk":"ru"),receipt(true,true)).text,text);
 }
 for(const text of ["Операторға өтініш тіркелді.","Обращение к оператору зарегистрировано."]){
  assert.equal(validateFinalText(text,ctx(/[әғқңөұүһі]/iu.test(text)?"kk":"ru"),receipt(true,false)).text,text);
 }
});
test("accepted notification cannot prove an imminent callback",()=>{
 for(const text of ["Әкімшіге хабарластық. Олар сізбен жақын арада байланысады.","Оператор вскоре свяжется с вами.","Оператор уведомлён. Он скоро свяжется с вами."]){
  const language=/[әғқңөұүһі]/iu.test(text)?"kk":"ru";const r=validateFinalText(text,ctx(language),receipt(true,true));
  assert.doesNotMatch(r.text,/жақын арада байланысады|вскоре свяжется|скоро свяжется/iu);
  assert.ok(r.text.trim());assert.doesNotMatch(r.text,/доставку.*не могу|жеткізілгенін.*растай алмаймын/iu);
 }
});
test("honest denied or quoted future contact does not unlock a later promise",()=>{
 for(const text of ["Ол сізбен байланыса алмайды.","Оператор не свяжется с вами.","Вы написали: «Оператор скоро ответит»."]){
  assert.equal(validateFinalText(text,ctx("ru"),receipt(true,false)).text,text);
 }
 for(const text of ["Оператор не свяжется, но они скоро ответят.","Ол байланыса алмайды, бірақ олар сізбен байланысады."]){
  assert.notEqual(validateFinalText(text,ctx("ru"),receipt(true,false)).text,text);
 }
});
test("cancellation case fallback records only the request and never asserts delivery or cancellation",()=>{
 for(const language of ["ru","kk"]){
  const raw=language==="ru"?"Я отменил ваш заказ.":"Тапсырысыңызды жойдым.";
  for(const created of [false,true]){
   const r=validateFinalText(raw,ctx(language,{activeOrder:{id:42,status:"cooking"}}),receipt(created,false));
   assert.match(r.text,/не могу|алмаймын/iu);
   assert.doesNotMatch(r.text,/передал|отправил|доставлен|жеткіздім|жібердім|свяжется|байланысады|заказ отменён|тоқтаттым|жойдым/iu);
   if(created)assert.match(r.text,/зарегистрирован|тіркел/iu);
   else assert.doesNotMatch(r.text,/зарегистрирован|тіркелді/iu);
  }
  const helper=manualCancellationBoundaryText(language,true);assert.match(helper,/зарегистрирован|тіркел/iu);assert.doesNotMatch(helper,/свяжется|байланысады|передал|жеткіздім/iu);
 }
});
test("protocol-only or opener-only survivors remain safe and nonempty after final validation",()=>{
 for(const language of ["ru","kk"]){
  for(const prefix of ["","Конечно. ","Әрине. "]){
   const raw=prefix+'\ntype: "tool_code"\ncode: "default_api.update_crm_lead({})"';
   const r=validateFinalText(raw,ctx(language,{text:"",chatHistory:[]}),{toolsCalled:[]});
   assert.ok(r.text.trim().length>0,JSON.stringify({language,prefix,result:r}));
   assert.doesNotMatch(r.text,/tool_code|default_api|update_crm|зарегистрирован|тіркелді|ссылк|сілтем/iu);
   assert.equal(r.hasLink,false);assert.ok(r.warnings.includes("tool_protocol_removed"));
  }
 }
});
