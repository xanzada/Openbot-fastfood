import test from "node:test";
import assert from "node:assert/strict";
process.env.REDIS_URL="redis://127.0.0.1:1";
process.env.REDIS_CONNECT_TIMEOUT_MS="100";
process.env.REDIS_OPERATION_TIMEOUT_MS="100";
const {hasCustomerCheckoutIntent,hasDirectOrderIntent}=await import("../src/utils/orderIntent.js");
const {resolveAgentToolPlan}=await import("../src/agent/toolPolicy.js");
const {createSendMenuLinkSkill}=await import("../src/skills/menuLink.skill.js");
const {groundMenuTurn}=await import("../src/skills/searchMenu.skill.js");
const {redisClient}=await import("../src/services/redis.service.js");
test.after(()=>{if(redisClient.isOpen)redisClient.destroy();});
const context=(text:string,extra:any={})=>({
 instanceId:"budget-link-synthetic",phone:"77000000001",text,language:"kk",config:{},activeOrder:null,
 runtimeStatus:{is_accepting_orders:true,within_work_hours:true},hardRealtimeContext:{runtime_available:true},
 menuSnapshot:{items:[{name:"Донер куриный",price:1800},{name:"Спрайт",price:650}]},activeShiftNotes:[],
 chatHistory:[{role:"assistant",text:"Екі донер аламын. Сілтемені жіберіңіз",linkGranted:true}],
 magicLink:"https://fixture.invalid/menu",magicLinkAlreadySent:true,explicitMenuLinkIntent:true,...extra
} as any);
for(const text of [
 "1000001 теңгеге не аламын?","0 теңгеге не аламын?","2000.50 теңгеге не аламын?","2000,50 теңгеге не аламын?",
 "2000 теңгеге не аламын?","Қарным қатты ашып тұр, студентпін, менде 2000 теңге бар",
 "Что можно взять на 2000 тенге?","Я голоден, я студент, у меня 2000 тенге",
 "Менде 2 000 теңге бар, не ұсынасыз?","На 1500 тг что можно купить?",
]){
 test("actual exploratory budget needs fresh facts without model/history checkout permission: "+text,async()=>{
  const ctx=context(text),plan=resolveAgentToolPlan(ctx);
  assert.equal(hasDirectOrderIntent(text),false);assert.equal(hasCustomerCheckoutIntent(text),false);
  assert.equal(plan.requiredTools[0],"searchMenu");assert.equal(plan.requiredTools.includes("sendMenuLink"),false);
  const result:any=await createSendMenuLinkSkill(ctx).execute({reason:"model supplied request",guestAskedToResend:true});
  assert.equal(result.allowed,false);assert.notEqual(ctx.magicLinkGranted,true);
 });
}
for(const text of [
 "1000001 теңгеге не аламын? Бірақ екі донер аламын","Екі донер аламын","2000 теңгеге не аламын? Бірақ екі донер аламын",
 "Что можно купить на 2000 тенге? Но возьму два донера",
]){
 test("actual later decisive food choice authorizes checkout: "+text,async()=>{
  const ctx=context(text),plan=resolveAgentToolPlan(ctx);
  assert.equal(hasDirectOrderIntent(text),true);assert.equal(hasCustomerCheckoutIntent(text),true);
  assert.ok(plan.requiredTools.includes("searchMenu"));assert.ok(plan.requiredTools.includes("sendMenuLink"));
  await groundMenuTurn(ctx,(async()=>ctx.menuSnapshot) as any);
  const result:any=await createSendMenuLinkSkill(ctx).execute({reason:"current choice"});assert.equal(result.allowed,true);
 });
}
for(const text of [
 "Сілтеме керек","Сілтеме қажет","Маған сілтеме керек","Ссылка нужна","Мне нужна ссылка",
 "Сілтеме керек емес, бірақ сілтемені жіберіңіз","Ссылка не нужна, но пришлите ссылку",
 "Меню не отправляйте, ссылка нужна","2000 теңгеге не аламын? Сілтеме керек",
 "Что можно купить на 2000 тенге? Нужна ссылка","2000 теңгеге не аламын және сілтеме керек",
]){
 test("actual independent current noun/need request grants only its requested URL: "+text,async()=>{
  const ctx=context(text),plan=resolveAgentToolPlan(ctx);assert.equal(hasCustomerCheckoutIntent(text),true);
  assert.ok(plan.requiredTools.includes("sendMenuLink"));
  if(/2000/u.test(text))assert.equal(plan.requiredTools[0],"searchMenu");
  const result:any=await createSendMenuLinkSkill(ctx).execute({reason:"current URL"});assert.equal(result.allowed,true);
 });
}
for(const text of [
 "Сілтеме керек емес","Сілтеме қажет емес","Сілтеменің керегі жоқ","Ссылка не нужна","Не нужна ссылка",
 "Пришлите ссылку. Ссылка не нужна","Сілтемені жіберіңіз. Сілтеме керек емес",
 "Сілтемені жіберіңіз, сілтеме қажет емес","Ссылка нужна, но ссылку не присылайте",
 "Оператор написал «Сілтеме керек»","Клиент сказал “Нужна ссылка”",
 "2000 теңгеге не аламын? Сілтеме керек емес","2000 теңгеге не аламын және сілтеме керек емес",
 "Оператор сказал \'Нужна ссылка\'","Клиент сказал ‘Сілтеме керек’",
]){
 test("actual current refusal or quoted need withdraws checkout despite model/stale history: "+text,async()=>{
  const ctx=context(text),plan=resolveAgentToolPlan(ctx);assert.equal(hasCustomerCheckoutIntent(text),false);
  assert.equal(plan.requiredTools.includes("sendMenuLink"),false);
  const result:any=await createSendMenuLinkSkill(ctx).execute({reason:"model request",guestAskedToResend:true});assert.equal(result.allowed,false);assert.notEqual(ctx.magicLinkGranted,true);
 });
}
test("budget facts read survives closure without bypassing actual sales policy",async()=>{
 const ctx=context("2000 теңгеге не аламын? Сілтеме керек",{runtimeStatus:{is_accepting_orders:false,within_work_hours:true}});
 const plan=resolveAgentToolPlan(ctx);assert.ok(plan.requiredTools.includes("searchMenu"));assert.equal(plan.requiredTools.includes("sendMenuLink"),false);
 const result:any=await createSendMenuLinkSkill(ctx).execute({reason:"current URL"});assert.equal(result.allowed,false);assert.equal(result.reason,"kitchen_closed");
});
test("active operator wait note still gates independent URL while budget facts remain fresh",async()=>{
 const ctx=context("2000 теңгеге не аламын? Сілтеме керек",{activeShiftNotes:[{text:"Общее ожидание 120 минут."}]});
 const plan=resolveAgentToolPlan(ctx);assert.ok(plan.requiredTools.includes("searchMenu"));assert.equal(plan.requiredTools.includes("sendMenuLink"),false);
 const result:any=await createSendMenuLinkSkill(ctx).execute({reason:"current URL"});assert.equal(result.allowed,false);assert.equal(result.reason,"wait_consent_required");
});
test("a separate payment statement does not erase exploratory budget menu facts",()=>{
 const plan=resolveAgentToolPlan(context("За доставку оплатил 500 тг. Что можно купить на 2000 тенге?"));
 assert.ok(plan.requiredTools.includes("searchMenu"));assert.equal(plan.requiredTools.includes("sendMenuLink"),false);
});
