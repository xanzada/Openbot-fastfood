import assert from "node:assert/strict";
import {readFileSync} from "node:fs";
import test from "node:test";
import vm from "node:vm";
import ts from "typescript";
import crypto from "node:crypto";
import {detectOperatorCaseKind} from "../src/services/operatorCase.service.js";
import {intentMatches,isLikelyMenuQuestion} from "../src/utils/intentText.js";
function routeHarness(media:any=null, pending:string|null=null) {
 const created:any[]=[];const writes:any[]=[];const exports:any={};
 const modules:any={
  "node:crypto":crypto,
  "./redis.service.js":{getComplaintMedia:async()=>media,clearComplaintMedia:async()=>{},markComplaintClarificationPending:async()=>{writes.push("clarification");return true;},saveCaseMedia:async()=>true,takeComplaintClarification:async()=>pending},
  "./operatorCase.service.js":{detectOperatorCaseKind,getActiveOperatorCaseId:async()=>null,createOperatorCase:async(payload:any)=>{created.push(payload);return {id:"case-fixture",...payload};},bumpOperatorCaseSignal:async()=>true},
  "./auditLogger.service.js":{auditError:()=>{}},
  "../utils/intentText.js":{intentMatches,isLikelyMenuQuestion}
 };
 const compiled=ts.transpileModule(readFileSync(new URL("../src/services/complaintRouting.service.ts",import.meta.url),"utf8"),{compilerOptions:{module:ts.ModuleKind.CommonJS,target:ts.ScriptTarget.ES2022,esModuleInterop:true}}).outputText;
 vm.runInNewContext(compiled,{exports,require:(name:string)=>modules[name],Date,console});
 return {created,writes,route:(text:string,options:any={})=>exports.routeComplaintToAdmin({instanceId:"fixture",phone:"70000000002",language:"ru",text,config:{},...options.ctx},{summary:"TEXT_MODEL_TIMEOUT",source:"ai_unavailable",customerReply:"Передал оператору",...options.input})};
}
for(const phrase of ["Здравствуйте","Сколько стоит донер?","не понял","Ссылка не открывается","абракадабра","ну хорошо, я сейчас подумаю и потом напишу"]) {
 test(`transient provider failure does not create SOS for '${phrase}'`,async()=>{const h=routeHarness();const result=await h.route(phrase);assert.equal(h.created.length,0);assert.equal(result.caseId,null);assert.doesNotMatch(result.customerReply||"",/Передал оператору/);});
}
test("fallback source preserves true detailed complaint",async()=>{const h=routeHarness();const result=await h.route("Заказ привезли холодный, курьер нагрубил");assert.equal(result.action,"operator_case_created");assert.equal(h.created[0].kind,"complaint");});
test("fallback source preserves explicit human request",async()=>{const h=routeHarness();const result=await h.route("Хочу живого оператора");assert.equal(result.action,"operator_case_created");assert.equal(h.created[0].kind,"human_request");});
test("fallback source preserves actual money dispute",async()=>{const h=routeHarness();const result=await h.route("Я уже оплатил, деньги списали, а заказ не подтвержден");assert.equal(result.action,"operator_case_created");assert.equal(h.created[0].kind,"critical");});
test("fallback source preserves unreadable receipt context",async()=>{const h=routeHarness({base64:"fixture",mimeType:"application/pdf"});const result=await h.route("Чек не удалось прочитать",{ctx:{mediaContext:{kind:"payment_receipt"}}});assert.equal(result.action,"operator_case_created");assert.equal(h.created[0].kind,"critical");});
test("fallback true complaint mentioning menu is not swallowed by menu gate",async()=>{const h=routeHarness();const result=await h.route("Заказ холодный и не тот, что в меню, сколько стоит возврат?");assert.equal(result.action,"operator_case_created");});


for(const phrase of ["Согласен ждать 60 минут","Күтуге келісемін","Не хочу говорить с оператором","Не соединяйте меня с оператором","Оператор сказал, что нужно добавить сыр","Оператору нужна пицца","Я сейчас подумаю и потом снова напишу вам"]) {
 test("AI tool cannot invent an incident from ordinary customer input: "+phrase,async()=>{
  const h=routeHarness(null,"у меня жалоба");
  const result=await h.route(phrase,{ctx:{thinking:{risk:"high",mood:"angry"}},input:{source:"ai_tool_escalate_to_admin",urgency:"high",summary:"Клиент в конфликте, требуется оператор"}});
  assert.equal(h.created.length,0);
  assert.equal(h.writes.length,0,"no invented complaint pending state");
  assert.ok(["skipped_unconfirmed_incident","skipped_menu_question"].includes(result.action));
  assert.doesNotMatch(result.customerReply,/Передал|свяжется|жібердім|байланысады/iu);
 });
}
for(const phrase of ["Не хочу говорить с оператором","Оператор сказал, что нужно добавить сыр"]) {
 test("provider outage preserves a refused/incidental operator turn without SOS: "+phrase,async()=>{
  const h=routeHarness();const result=await h.route(phrase);assert.equal(h.created.length,0);assert.equal(result.action,"skipped_technical_failure");
 });
}
test("long voice input alone is not a confirmed incident",async()=>{
 const h=routeHarness();const result=await h.route("[Media sent]",{input:{source:"long_voice"}});assert.equal(h.created.length,0);assert.ok(["skipped_unconfirmed_incident","skipped_menu_question"].includes(result.action));
});
test("real child allergy plus current safety guarantee question may require human review",async()=>{
 const h=routeHarness();const result=await h.route("Жаңғақсыз қауіпсіз деп кепілдік бере аласыз ба?",{ctx:{chatHistory:[{role:"user",content:"Баламда жаңғаққа аллергия бар"}]},input:{source:"ai_tool_escalate_to_admin",urgency:"high"}});assert.equal(result.action,"operator_case_created");assert.equal(h.created.length,1);
});
test("a model-written allergy story alone does not prove a customer incident",async()=>{
 const h=routeHarness();const result=await h.route("Согласен ждать 60 минут",{ctx:{chatHistory:[{role:"assistant",content:"У клиента аллергия"}]},input:{source:"ai_tool_escalate_to_admin",urgency:"high",summary:"У клиента аллергия"}});assert.equal(h.created.length,0);assert.ok(["skipped_unconfirmed_incident","skipped_menu_question"].includes(result.action));
});

test("old webhook clarification does not turn wait consent into an incident",async()=>{
 const h=routeHarness(null,"у меня жалоба");const result=await h.route("Согласен ждать 60 минут",{input:{source:"complaint_text",customerText:"у меня жалоба — Согласен ждать 60 минут"}});assert.equal(h.created.length,0);assert.equal(h.writes.length,0);assert.equal(result.caseId,null);
});
test("Kazakh dirt word is preserved as an actual food-quality incident",async()=>{
 const h=routeHarness();const result=await h.route("Тағам лас келді, ішінде шаш бар",{input:{source:"ai_tool_escalate_to_admin"}});assert.equal(h.created.length,1);assert.equal(result.action,"operator_case_created");
});

for(const phrase of ["Не отменяйте мой заказ, всё нормально","Возврат не нужен, заказ нормальный","Аллергии нет, хочу колу","Не вызывайте скорую, я спросил цену"]) {
 test("denied incident keywords do not create an AI-invented SOS: "+phrase,async()=>{
  const h=routeHarness();const result=await h.route(phrase,{input:{source:"ai_tool_escalate_to_admin",urgency:"high"}});assert.equal(h.created.length,0);assert.equal(result.caseId,null);
 });
}
for(const phrase of ["Не вызывайте скорую, но я задыхаюсь","Возврат не нужен, но деньги списали и заказ не подтвержден","Не отменяйте мой заказ, но позовите оператора"]) {
 test("a genuine positive incident clause survives unrelated refusal: "+phrase,async()=>{
  const h=routeHarness();const result=await h.route(phrase,{input:{source:"ai_tool_escalate_to_admin",urgency:"high"}});assert.equal(h.created.length,1);assert.equal(result.action,"operator_case_created");
 });
}
