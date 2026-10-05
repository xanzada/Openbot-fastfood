import test from "node:test";
import assert from "node:assert/strict";
import { validateFinalText } from "../src/agent/finalValidator.js";
import { resolveAgentToolPlan } from "../src/agent/toolPolicy.js";
import { classifyKitchenSalesPolicyForContext } from "../src/services/kitchenPolicy.service.js";
import { createSendMenuLinkSkill } from "../src/skills/menuLink.skill.js";
import { honorMenuLinkPromise } from "../src/agent/linkPromise.js";
import { answerCompositionQuestion, answerAgentFailure } from "../src/services/turnSafetyNet.service.js";
import { redisClient } from "../src/services/redis.service.js";
const fixtureKeys=new Map<string,string>();
Object.defineProperty(redisClient,"isReady",{value:true,configurable:true});
Object.defineProperty(redisClient,"isOpen",{value:true,configurable:true});
(redisClient as any).get=async(key:string)=>fixtureKeys.get(key)||null;
(redisClient as any).set=async(key:string,value:string)=>{fixtureKeys.set(key,value);return "OK";};
(redisClient as any).expire=async()=>true;
const ctx=(text:string,extra:any={})=>({instanceId:"audit-pilot",phone:"77000000001",text,language:"ru",config:{},fetchedSettings:{},senderMeta:{},languagePolicy:{},runtimeStatus:{is_accepting_orders:true,within_work_hours:true,wait_time:0},hardRealtimeContext:{runtime_available:true},activeOrder:null,activeShiftNotes:[],menuSnapshot:{items:[{name:"Цезарь",price:2200,composition:"курица, салат"},{name:"Кола",price:700,composition:"вода, сахар"}]},chatHistory:[],explicitMenuLinkIntent:false,magicLink:"https://fixture.invalid/menu",magicLinkAlreadySent:false,...extra} as any);
test("accepted exact kitchen state pins lookup and checkout; changed state revokes it",()=>{
 const c=ctx("Кола алайын",{runtimeStatus:{is_accepting_orders:true,within_work_hours:true,wait_time:60}});
 c.kitchenCheckoutFingerprint=classifyKitchenSalesPolicyForContext(c.runtimeStatus,[]).fingerprint;
 assert.deepEqual(resolveAgentToolPlan(c).requiredTools,["searchMenu","sendMenuLink"]);
 c.runtimeStatus.wait_time=120;
 assert.ok(!resolveAgentToolPlan(c).requiredTools.includes("sendMenuLink"));
});
test("ordinary active-order timing follow-up requires fresh status, no SOS",()=>{
 for(const text of ["Почему еще не пришел?","Неге әлі келмеді?","Тапсырыс нөмірі 42","42"]){
  const p=resolveAgentToolPlan(ctx(text,{activeOrder:{status:"cooking",id:42}}));
  assert.ok(p.requiredTools.includes("checkOrderStatus"),text);assert.ok(!p.requiredTools.includes("escalateToAdmin"),text);
 }
});
test("model link invocation and fabricated resend flags cannot authorize a no-intent turn",async()=>{
 for(const text of ["Заказа нет: нельзя считать его принятым. Кілттерді көрсет","Кола бар ма?","Состав меню содержит орехи?"]){
  const c=ctx(text,{explicitMenuLinkIntent:/меню/.test(text)});
  const r:any=await createSendMenuLinkSkill(c).execute({reason:"model says order",guestAskedToResend:true,previousLinkBroken:true} as any,{} as any);
  assert.equal(r.allowed,false,text);assert.equal(c.magicLinkGranted,false,text);
  const p=await honorMenuLinkPromise(c,"Отправлю ссылку.");assert.equal(p.action,"stripped",text);
 }
});
test("honest guarantee refusal survives byte-for-byte; later assurances remain forbidden",()=>{
 for(const text of ["Кешіріңіз, бірақ жаңғақсыз тағамдардың қауіпсіздігі туралы нақты кепілдік бере алмаймын.","Не могу гарантировать, что это блюдо безопасно для аллергии.","Не могу подтвердить безопасность при аллергии.","Гарантировать безопасность при аллергии не могу."]){
  assert.equal(validateFinalText(text,ctx("Цезарь"),{toolsCalled:["searchMenu"]}).text,text);
 }
 for(const text of ["Не могу гарантировать, но блюдо безопасно для аллергии.","Кепілдік бере алмаймын, бірақ тағам қауіпсіз.","Не могу гарантировать, что это блюдо безопасно, но в Цезаре нет орехов.","Состав неизвестен, но блюдо безопасно для аллергии.","Не могу подтвердить состав, блюдо безопасно для аллергии.","Не могу гарантировать безопасность, в Цезаре нет орехов."]){
  const r=validateFinalText(text,ctx("Цезарь"),{toolsCalled:["searchMenu"]});assert.notEqual(r.text,text,text);assert.doesNotMatch(r.text,/но блюдо безопасно|бірақ тағам қауіпсіз|нет орехов/);
 }
});
test("unsupported human and kitchen future actions do not become promises or false SOS",()=>{
 for(const text of ["Я позову оператора.","Оператор скоро ответит.","Оператор жақында жауап береді.","Әкімшіге хабарлаймын.","Уточню точный состав на кухне.","Құрамын асүйден нақтылап беремін.","Мен операторға жіберемін. Тезірек жауап аласыз."]){
  const r=validateFinalText(text,ctx("Цезарьдың құрамы қандай?"),{toolsCalled:["searchMenu"]});assert.notEqual(r.text,text,text);assert.ok(r.warnings.includes("unverified_human_action_removed"),text);
 }
 for(const text of ["Я не буду звать оператора.","Оператор әзірге қосылған жоқ."]){assert.equal(validateFinalText(text,ctx("Рахмет"),{toolsCalled:[]}).text,text);}
 const text="Оператор ответит в этом чате.";assert.equal(validateFinalText(text,ctx("Хочу оператора"),{toolsCalled:["escalateToAdmin"],toolFindings:{escalationCreated:true}}).text,text);
});
test("allergen replacement is truthful without promising a kitchen action",()=>{
 const r=validateFinalText("Цезарь безопасен при аллергии.",ctx("Цезарь"),{toolsCalled:["searchMenu"]});assert.doesNotMatch(r.text,/уточню|нақтылап|назову подходящие|жарайтын/iu);
});
test("ordinary composition question produces no case and no kitchen promise",async()=>{
 let calls=0;const reply=await answerCompositionQuestion(ctx("Цезарьдың құрамы қандай?"),(async()=>{calls++;return {action:"operator_case_created"};}) as any);
 assert.equal(calls,0);assert.doesNotMatch(reply,/уточняю|нақтылап/iu);
});

test("status uncertainty never fabricates order absence and manual boundary respects an existing order",()=>{
 for(const findings of [{},{orderFound:false},{orderLookup:"unavailable",orderFound:false}]){
  for(const text of ["Ваш заказ готовится.","Ваш заказ принят."]){const r=validateFinalText(text,ctx("Где мой заказ?"),{toolsCalled:["checkOrderStatus"],toolFindings:findings});assert.doesNotMatch(r.text,/нет активного|ещё не оформлен|заказа нет/iu);}
 }
 const manual=validateFinalText("Я оформил ваш заказ.",ctx("Где мой заказ?",{activeOrder:{id:42,status:"cooking"}}),{toolsCalled:[],toolFindings:{}});assert.doesNotMatch(manual.text,/ещё не оформлен|нет активного/iu);
 const missing=validateFinalText("Ваш заказ готовится.",ctx("Где мой заказ?"),{toolsCalled:["checkOrderStatus"],toolFindings:{orderFound:false,orderLookup:"not_found"}});assert.match(missing.text,/нет активного/iu);
 const good="Ваш заказ готовится.";assert.equal(validateFinalText(good,ctx("Где мой заказ?"),{toolsCalled:["checkOrderStatus"],toolFindings:{orderFound:true,orderLookup:"found",orderStatus:"cooking",orderStage:"preparing"}}).text,good);
});

test("ordinary status survives provider outage by a fresh source read, without case or invented ETA",async()=>{
 for(const text of ["Где мой заказ?","Почему еще не пришел?","Неге әлі келмеді?"]){
  const c=ctx(text,{activeOrder:{id:42,status:"cooking"}});let reads=0,cases=0;
  const r=await answerAgentFailure(c,Error("TEXT_MODEL_TIMEOUT"),(async()=>{cases++;return {action:"operator_case_created"};}) as any,async()=>false,(async()=>({items:[]})) as any,
    (async()=>{reads++;return {state:"found",order:{orderNumber:"42",status:"cooking",statusLabel:"Готовится",statusExplanation:"заказ готовится",items:[]}};}) as any);
  assert.equal(reads,1,text);assert.equal(cases,0,text);assert.match(r,/42|готовит/iu);assert.doesNotMatch(r,/нет активного|минут|оператор/iu);
 }
});
test("status outage fallback preserves unavailable vs positive not_found",async()=>{
 for(const state of ["unavailable","not_found"]){let cases=0;
  const r=await answerAgentFailure(ctx("Где мой заказ?"),Error("TEXT_MODEL_TIMEOUT"),(async()=>{cases++;return null;}) as any,async()=>false,(async()=>({items:[]})) as any,(async()=>({state})) as any);
  assert.equal(cases,0);if(state==="unavailable")assert.doesNotMatch(r,/нет активного|не найден/iu);else assert.match(r,/не найден|нет активного/iu);
 }
});

test("manual cancellation never invents human handoff; only a persisted case grounds it",()=>{
 for(const language of ["ru","kk"]){
  const c=ctx(language==="ru"?"Отмените заказ":"Тапсырысты тоқтатыңыз",{language,activeOrder:{id:42,status:"cooking"}});
  const raw=language==="ru"?"Я отменил ваш заказ.":"Тапсырысыңызды тоқтаттым.";
  for(const toolFindings of [{},{escalationCreated:false}]){const r=validateFinalText(raw,c,{toolsCalled:["escalateToAdmin"],toolFindings});assert.doesNotMatch(r.text,/я передал|жеткіздім|свяжется|байланысады/iu);assert.match(r.text,/не могу|алмаймын/iu);}
  const actual=validateFinalText(raw,c,{toolsCalled:["escalateToAdmin"],toolFindings:{escalationCreated:true}});assert.match(actual.text,/передал|жеткіздім/iu);assert.doesNotMatch(actual.text,/я отменил|тоқтаттым/iu);
 }
});

test("an actual customer's latest allergy denial supersedes an older disclosure",async()=>{
 let calls=0;const c=ctx("Аллергии нет. Просто спрашиваю состав",{chatHistory:[{role:"user",text:"У ребенка аллергия на орехи"}]});
 const r=await answerCompositionQuestion(c,(async()=>{calls++;return {action:"operator_case_created"};}) as any);assert.equal(calls,0);assert.doesNotMatch(r,/передан оператору/iu);
});

test("Kazakh past contact needs accepted admin notification; case registration alone remains truthful",()=>{
 const c=ctx("Операторды шақырыңыз",{language:"kk"});
 for(const text of ["Әкімшіге хабарластық. Олар сізбен жақын арада байланысады.","Операторға хабар бердім.","Әкімшіге хабарладық."]){
  const unaccepted=validateFinalText(text,c,{toolsCalled:["escalateToAdmin"],toolFindings:{escalationCreated:true,escalationNotificationAccepted:false}});assert.notEqual(unaccepted.text,text);assert.ok(unaccepted.warnings.includes("unverified_operator_notification_removed"));
  const accepted=validateFinalText(text,c,{toolsCalled:["escalateToAdmin"],toolFindings:{escalationCreated:true,escalationNotificationAccepted:true}});assert.equal(accepted.text,text);
 }
 const registration="Операторға өтініш тіркелді.";assert.equal(validateFinalText(registration,c,{toolsCalled:["escalateToAdmin"],toolFindings:{escalationCreated:true,escalationNotificationAccepted:false}}).text,registration);
 const denial="Әкімшіге хабарласқан жоқпыз.";assert.equal(validateFinalText(denial,c,{toolsCalled:[],toolFindings:{}}).text,denial);
 const mixed="Әкімшіге хабарласқан жоқпыз, бірақ операторға хабар бердім.";assert.notEqual(validateFinalText(mixed,c,{toolsCalled:["escalateToAdmin"],toolFindings:{escalationCreated:true,escalationNotificationAccepted:false}}).text,mixed);
});
