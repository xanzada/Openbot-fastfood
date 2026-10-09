import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import vm from "node:vm";
import ts from "typescript";
import * as actualValidator from "../src/agent/finalValidator.js";
import {replyLanguageMismatch} from "../src/agent/finalValidator.js";
import {isMenuAttributeVerificationQuestion} from "../src/utils/menuQuestionContext.js";
import {needsShoppingPrepass,shoppingEvidence} from "../src/services/shoppingConstraints.service.js";
import {buildAgentInstructions,composeReadyAnalysisStepPolicy,createTurnThinkingState} from "../src/agent/instructionAssembly.js";
function fixture(text:string,constrained:boolean,mode="parallel",reject=false,drafts=["safe"],highRisk=false,criticIssues=["wrong_language"],criticFix="Use customer language.",options:any={}){
 const events:string[]=[],captured:string[]=[];let calls=0,critics=0;
 const ctx:any={instanceId:"think-fixture",phone:"77000000001",text,language:"ru",config:{system_prompt:"Service name: Жеті самал қызметі."},chatHistory:constrained?[{role:"user",text:"Бюджет 2000 тг",createdAt:Date.now()}]:[],menuSnapshot:{source:"dle",items:[{name:"Овощной ролл",price:2000,composition:"рис"}]},activeShiftNotes:[],hardRealtimeContext:{},runtimeStatus:null,shporContext:[],mediaContext:null,...options.ctx};
 const analysis={goal:"menu",mood:"unsure",urgency:"normal",complexity:"moderate",risk:highRisk?"high":"low",style_hint:"brief",reasoning_brief:"eligible2000",proactive_note:"verify"};
 const modules:any={
  "../utils/menuQuestionContext.js":{isMenuAttributeVerificationQuestion},
  "../services/shoppingConstraints.service.js":{refreshShoppingConstraints:async()=>{events.push("state");},needsShoppingPrepass},
  "@voltagent/core":{Agent:class{instructions:string;constructor(opts:any){this.instructions=opts.instructions;}async generateText(_text:string,opts:any){calls++;events.push("response");const messages=[{role:"system",content:this.instructions}];const step=opts.prepareStep({stepNumber:0,messages});captured.push((step.messages||messages)[0].content);return{text:drafts[Math.min(calls-1,drafts.length-1)],steps:options.stepResults?.[calls-1]||options.steps||[]};}},stepCountIs:()=>()=>false},
  "../skills/index.js":{createFastFoodSkills:()=>[]},
  "../services/agentThinking.service.js":{analyzeTurnSituation:async(c:any)=>{events.push("think_start");assert.equal(shoppingEvidence(c)?.checkout_authority??false,false);await Promise.resolve();if(reject){events.push("think_error");throw Error("SYNTHETIC");}events.push("think_complete");return analysis;},critiqueDraftReply:async()=>{if(!highRisk)throw Error("EXTRA_MODEL_FORBIDDEN");critics++;return{ok:false,issues:criticIssues,fix_hint:criticFix};}},
  "./finalValidator.js":{validateFinalText:(text:string)=>({text,warnings:[]}),fallbackReply:()=>"safe",groundedReplyFallback:(actualValidator as any).groundedReplyFallback,replyLanguageMismatch},
  "./greeting.js":{readGuestGreeting:()=>null},"./instructionAssembly.js":{buildAgentInstructions,composeReadyAnalysisStepPolicy,createTurnThinkingState},
  "./modelRouter.js":{resolveModel:()=>({})},"./toolPolicy.js":{resolveLiveAgentToolPlan:async()=>({requiredTools:[],reason:"fixture"}),createAgentStepPolicy:()=>()=>({toolChoice:"none"})},
  "../skills/searchMenu.skill.js":{groundMenuTurn:async()=>{throw Error("UNEXPECTED_GROUND");},menuQueryForTurn:()=>""},
  "./linkPromise.js":{honorMenuLinkPromise:async()=>({action:"none"})},
  "../services/kitchenPolicy.service.js":{classifyKitchenSalesPolicyForContext:()=>({mode:"normal",requiresConsent:false})},
  "../utils/envNumber.js":{envNumber:(_v:any,fallback:number)=>fallback}
 };
 const compiled=ts.transpileModule(fs.readFileSync(new URL("../src/agent/fastfoodAgent.ts",import.meta.url),"utf8"),{compilerOptions:{target:ts.ScriptTarget.ES2022,module:ts.ModuleKind.CommonJS}}).outputText;
 const exports:any={};vm.runInNewContext(compiled,{exports,require:(name:string)=>{if(!(name in modules))throw Error("UNEXPECTED_FAKE_DEPENDENCY:"+name);return modules[name];},process:{env:{THINK_MODE:mode}},Date,Promise,setTimeout,console:{info(){},warn(){}}});
 return{run:()=>exports.runFastFoodAgent(ctx),events,captured,calls:()=>calls,critics:()=>critics};
}
test("constrained short followup consumes bounded completed THINK before first response generation",async()=>{
 const f=fixture("А из комбо что посоветуете?",true);await f.run();assert.deepEqual(f.events,["state","think_start","think_complete","response"]);assert.match(f.captured[0],/eligible2000/);assert.equal(f.calls(),1);
});
test("simple unconstrained turn keeps parallel generation and no extra response round",async()=>{
 const f=fixture("Что посоветуете?",false);await f.run();assert.ok(f.events.indexOf("response")<f.events.indexOf("think_complete"));assert.equal(f.calls(),1);
});
test("THINK failure falls back once without an extra call and off mode remains explicit",async()=>{
 const f=fixture("А из комбо что посоветуете?",true,"parallel",true);await f.run();assert.equal(f.calls(),1);assert.ok(!f.captured[0].includes("eligible2000"));
 const off=fixture("А из комбо что посоветуете?",true,"off");await off.run();assert.deepEqual(off.events,["state","response"]);assert.equal(off.calls(),1);
});

test("attribute verification consumes existing bounded THINK before first response without shopping ceiling",async()=>{
 const f=fixture("Не придумывайте замену: подтвердите объём по меню",false);
 await f.run();assert.deepEqual(f.events,["state","think_start","think_complete","response"]);assert.equal(f.calls(),1);
});
test("wrong language reuses one rewrite while keeping proper name and critic cannot add another",async()=>{
 const f=fixture("Как к вам обращаться?",false,"blocking",false,["Сіз мені «Жеті самал қызметі» деп атай аласыз. Не көмек керек?","Вы можете называть меня «Жеті самал қызметі»."],true);
 const r=await f.run();assert.equal(r.text,"Вы можете называть меня «Жеті самал қызметі».");assert.equal(f.calls(),2);assert.equal(f.critics(),1);
 assert.ok(f.captured[1].includes("LANGUAGE_REPAIR"));assert.ok(f.captured[1].includes("Жеті самал қызметі"));assert.equal(f.events.filter(x=>x==="think_start").length,1);
});
test("correct Russian prose with literal Kazakh name needs no rewrite and failed language repair is safe",async()=>{
 const f=fixture("Как к вам обращаться?",false,"blocking",false,["Вы можете называть меня «Жеті самал қызметі»."]);
 await f.run();assert.equal(f.calls(),1);
 const bad=fixture("Как к вам обращаться?",false,"blocking",false,["If you have further questions, feel free to ask!"]);
 const r=await bad.run();assert.equal(bad.calls(),2);assert.equal(r.text,"safe");assert.ok(r.validationWarnings.includes("reply_language_unresolved"));
});

test("simultaneous language and factual critic failures enter one rewrite instruction",async()=>{
 const f=fixture("Как к вам обращаться?",false,"blocking",false,["Сіз мені «Жеті самал қызметі» деп атай аласыз. Не көмек керек?","Вы можете называть меня «Жеті самал қызметі»."],true,["invented_fact"],"Remove the unverified delivery promise.");
 await f.run();assert.equal(f.calls(),2);assert.equal(f.critics(),1);assert.equal(f.events.filter(x=>x==="think_start").length,1);
 assert.match(f.captured[1],/LANGUAGE_REPAIR/u);assert.match(f.captured[1],/CRITIC_NOTE/u);
 assert.match(f.captured[1],/invented_fact/u);assert.match(f.captured[1],/Remove the unverified delivery promise\./u);
});

test("candidate03 one failed language rewrite retains verified wait60 in customer language",async()=>{
 const steps=[{toolCalls:[{toolName:"getKitchenStatus",input:{}}],toolResults:[{toolName:"getKitchenStatus",output:{runtime_available:true,live:true,wait_time:60}}]}];
 const f=fixture("Сколько ждать?",false,"off",false,["Кейін 1 сағат күту қажет болады. Сіз күте аласыз ба?"],false,[],"",{ctx:{runtimeStatus:{runtime_available:true,wait_time:60},fetchedSettings:{wait_time:60}},steps});
 const r=await f.run();assert.equal(f.calls(),2);assert.match(r.text,/60 минут|1 час/u);assert.ok(!replyLanguageMismatch(r.text,{language:"ru"} as any));
 assert.ok(r.validationWarnings.includes("reply_language_unresolved"));
});
test("candidate03 failed language rewrite never confirms a wait from runtimeunknown default",async()=>{
 const steps=[{toolCalls:[{toolName:"getKitchenStatus",input:{}}],toolResults:[{toolName:"getKitchenStatus",output:{runtime_available:false,live:false,wait_time:null}}]}];
 const f=fixture("Сколько ждать?",false,"off",false,["If you have further questions, feel free to ask!"],false,[],"",{ctx:{runtimeStatus:{runtime_available:false,wait_time:0}},steps});
 const r=await f.run();assert.equal(f.calls(),2);assert.doesNotMatch(r.text,/0 минут/u);assert.match(r.text,/подтверд|неизвест|не могу/u);
});

test("candidate03 language fallback never authorizes a cached wait after a failed fresh read",async()=>{
 const steps=[{toolCalls:[{toolName:"getKitchenStatus",input:{}}],toolResults:[{toolName:"getKitchenStatus",output:{runtime_available:false,live:false,wait_time:null}}]}];
 const f=fixture("Сколько ждать?",false,"off",false,["If you have further questions, feel free to ask!"],false,[],"",{ctx:{runtimeStatus:{runtime_available:true,wait_time:60}},steps});
 const r=await f.run();assert.equal(f.calls(),2);assert.match(r.text,/подтвердить не могу/u);assert.doesNotMatch(r.text,/60|0 минут/u);
});
test("candidate03 language fallback preserves lastknown uncertainty instead of advertising an exact fresh wait",async()=>{
 const steps=[{toolCalls:[{toolName:"getKitchenStatus",input:{}}],toolResults:[{toolName:"getKitchenStatus",output:{runtime_available:true,live:false,is_last_known:true,wait_time:60}}]}];
 const f=fixture("Сколько ждать?",false,"off",false,["If you have further questions, feel free to ask!"],false,[],"",{ctx:{runtimeStatus:{runtime_available:true,wait_time:60}},steps});
 const r=await f.run();assert.equal(f.calls(),2);assert.match(r.text,/подтвердить не могу/u);assert.doesNotMatch(r.text,/60/u);
});

test("candidate04 exact full Kazakh wait prose uses one rewrite then verified Russian60 fallback",async()=>{
 const steps=[{toolCalls:[{toolName:"getKitchenStatus",input:{}}],toolResults:[{toolName:"getKitchenStatus",output:{runtime_available:true,live:true,wait_time:60}}]}];
 const draft="Кешіріңіз, асханада күту уақыты - 1 сағат. Сіз күтуге дайынсыз ба?";
 const f=fixture("Сколько ждать?",false,"off",false,[draft],false,[],"",{ctx:{runtimeStatus:{runtime_available:true,wait_time:60}},steps});
 const r=await f.run();assert.equal(f.calls(),2);assert.match(f.captured[1],/LANGUAGE_REPAIR/u);assert.match(r.text,/60 минут/u);
 assert.ok(!replyLanguageMismatch(r.text,{language:"ru"} as any));assert.ok(r.validationWarnings.includes("reply_language_unresolved"));
});
test("candidate04 successful language rewrite retains truthful wait without another call",async()=>{
 const draft="Кешіріңіз, асханада күту уақыты - 1 сағат. Сіз күтуге дайынсыз ба?";
 const f=fixture("Сколько ждать?",false,"off",false,[draft,"Сейчас ориентировочное ожидание — 60 минут."],false,[],"",{ctx:{runtimeStatus:{runtime_available:true,wait_time:60}}});
 const r=await f.run();assert.equal(f.calls(),2);assert.equal(r.text,"Сейчас ориентировочное ожидание — 60 минут.");
});

const candidate05ConsentDraft="Кешіріңіз, бірақ мен тапсырысты рәсімдеу үшін сілтеме жібере алмаймын. Дегенмен, мен барлық тапсырыс беруге мүмкіндік беретін ас мәзірімізді ұсынамын. Сіз қандай ас алғыңыз келеді? Мысалы, донер немесе овощной ролл.";
function candidate05Steps(kitchen:any,link:any){
 return [{toolCalls:[{toolName:"getKitchenStatus",input:{}},{toolName:"sendMenuLink",input:{}}],toolResults:[{toolName:"getKitchenStatus",output:kitchen},{toolName:"sendMenuLink",output:link}]}];
}
test("candidate05 actual explicit wait consent uses one rewrite then meaningful verified Russian fallback",async()=>{
 const steps=candidate05Steps({runtime_available:true,live:true,wait_time:60},{allowed:false,link:null});
 const f=fixture("Я согласен ждать 60 минут",false,"off",false,[candidate05ConsentDraft],false,[],"",{ctx:{runtimeStatus:{runtime_available:true,wait_time:60},magicLinkGranted:false,kitchenCheckoutFingerprint:"actual-current-fingerprint"},steps});
 const r=await f.run();assert.equal(f.calls(),2);assert.match(r.text,/60 минут/u);assert.match(r.text,/готов.*ждать|готовность ждать|соглас.*ждать/u);
 assert.match(r.text,/ссылк|оформлен/u);assert.doesNotMatch(r.text,/Я на связи|техническ|согласие.*сохран|ссылк.*(?:отправлена|отправлю|получена)/u);
 assert.ok(!replyLanguageMismatch(r.text,{language:"ru"} as any));assert.ok(r.validationWarnings.includes("reply_language_unresolved"));
});
test("candidate05 current successful link grant alone permits the consent fallback link promise",async()=>{
 const steps=candidate05Steps({runtime_available:true,live:true,wait_time:60},{allowed:true,link:"https://fixture.invalid/order"});
 const f=fixture("Я согласен ждать 60 минут",false,"off",false,[candidate05ConsentDraft],false,[],"",{ctx:{runtimeStatus:{runtime_available:true,wait_time:60},magicLinkGranted:true,magicLink:"https://fixture.invalid/order"},steps});
 const r=await f.run();assert.equal(f.calls(),2);assert.match(r.text,/60 минут/u);assert.match(r.text,/ссылк.*отдельн/iu);assert.doesNotMatch(r.text,/https?:/u);
});
test("candidate05 latest rejected or unknown link result never inherits a prior grant",async()=>{
 for(const link of [{allowed:false,link:null},null]){
  const steps=candidate05Steps({runtime_available:true,live:true,wait_time:60},link);
  const f=fixture("Я согласен ждать 60 минут",false,"off",false,[candidate05ConsentDraft],false,[],"",{ctx:{runtimeStatus:{runtime_available:true,wait_time:60},magicLinkGranted:true,magicLink:"https://fixture.invalid/old"},steps});
  const r=await f.run();assert.equal(f.calls(),2);assert.doesNotMatch(r.text,/ссылк.*(?:отдельн|отправлена|отправлю)|https?:/iu);assert.match(r.text,/60 минут/u);
 }
});
test("candidate05 expressed consent cannot turn unknown or last-known wait into confirmed60",async()=>{
 for(const kitchen of [{runtime_available:false,live:false,wait_time:null},{runtime_available:true,live:false,is_last_known:true,wait_time:60}]){
  const f=fixture("Я согласен ждать 60 минут",false,"off",false,[candidate05ConsentDraft],false,[],"",{ctx:{runtimeStatus:{runtime_available:true,wait_time:60}},steps:candidate05Steps(kitchen,{allowed:false,link:null})});
  const r=await f.run();assert.equal(f.calls(),2);assert.doesNotMatch(r.text,/60 минут|0 минут/u);assert.match(r.text,/подтверд|неизвест/u);
 }
});
test("candidate05 refusal or quoted consent is not a current acceptance",async()=>{
 for(const text of ["Я не согласен ждать 60 минут","Клиент написал «Я согласен ждать 60 минут»"]){
  const f=fixture(text,false,"off",false,[candidate05ConsentDraft],false,[],"",{ctx:{runtimeStatus:{runtime_available:true,wait_time:60}},steps:candidate05Steps({runtime_available:true,live:true,wait_time:60},{allowed:false,link:null})});
  const r=await f.run();assert.equal(f.calls(),2);assert.doesNotMatch(r.text,/Вы (?:готовы|согласны)|готовность ждать|согласие.*принято/u);
 }
});
test("candidate05 explicit Kazakh consent fallback preserves customer language and verified wait",async()=>{
 const f=fixture("Мен 60 минут күтуге келісемін",false,"off",false,["If you have further questions, feel free to ask!"],false,[],"",{ctx:{language:"kk",runtimeStatus:{runtime_available:true,wait_time:60}},steps:candidate05Steps({runtime_available:true,live:true,wait_time:60},{allowed:false,link:null})});
 const r=await f.run();assert.equal(f.calls(),2);assert.match(r.text,/60 минут/u);assert.match(r.text,/күтуге.*дайын|күтуге.*келіс/iu);
 assert.ok(!replyLanguageMismatch(r.text,{language:"kk"} as any));
});

test("candidate05 successful current-turn grant survives a later rewrite duplicate refusal",async()=>{
 const first=candidate05Steps({runtime_available:true,live:true,wait_time:60},{allowed:true,link:"https://fixture.invalid/current"});
 const second=candidate05Steps({runtime_available:true,live:true,wait_time:60},{allowed:false,link:null});
 const f=fixture("Я согласен ждать 60 минут",false,"off",false,[candidate05ConsentDraft],false,[],"",{ctx:{runtimeStatus:{runtime_available:true,wait_time:60},magicLinkGranted:true,magicLink:"https://fixture.invalid/current"},stepResults:[first,second]});
 const r=await f.run();assert.equal(f.calls(),2);assert.match(r.text,/60 минут/u);assert.match(r.text,/ссылк.*отдельн/iu);
});
