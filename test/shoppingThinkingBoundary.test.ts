import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import vm from "node:vm";
import ts from "typescript";
import {needsShoppingPrepass,shoppingEvidence} from "../src/services/shoppingConstraints.service.js";
import {buildAgentInstructions,composeReadyAnalysisStepPolicy,createTurnThinkingState} from "../src/agent/instructionAssembly.js";
function fixture(text:string,constrained:boolean,mode="parallel",reject=false){
 const events:string[]=[],captured:string[]=[];let calls=0;
 const ctx:any={instanceId:"think-fixture",phone:"77000000001",text,language:"ru",config:{},chatHistory:constrained?[{role:"user",text:"Бюджет 2000 тг",createdAt:Date.now()}]:[],menuSnapshot:{source:"dle",items:[{name:"Овощной ролл",price:2000,composition:"рис"}]},activeShiftNotes:[],hardRealtimeContext:{},runtimeStatus:null,shporContext:[],mediaContext:null};
 const analysis={goal:"menu",mood:"unsure",urgency:"normal",complexity:"moderate",risk:"low",style_hint:"brief",reasoning_brief:"eligible2000",proactive_note:"verify"};
 const modules:any={
  "../services/shoppingConstraints.service.js":{refreshShoppingConstraints:async()=>{events.push("state");},needsShoppingPrepass},
  "@voltagent/core":{Agent:class{instructions:string;constructor(opts:any){this.instructions=opts.instructions;}async generateText(_text:string,opts:any){calls++;events.push("response");const messages=[{role:"system",content:this.instructions}];const step=opts.prepareStep({stepNumber:0,messages});captured.push((step.messages||messages)[0].content);return{text:"safe",steps:[]};}},stepCountIs:()=>()=>false},
  "../skills/index.js":{createFastFoodSkills:()=>[]},
  "../services/agentThinking.service.js":{analyzeTurnSituation:async(c:any)=>{events.push("think_start");assert.equal(shoppingEvidence(c)?.checkout_authority??false,false);await Promise.resolve();if(reject){events.push("think_error");throw Error("SYNTHETIC");}events.push("think_complete");return analysis;},critiqueDraftReply:async()=>{throw Error("EXTRA_MODEL_FORBIDDEN");}},
  "./finalValidator.js":{validateFinalText:(text:string)=>({text,warnings:[]}),fallbackReply:()=>"safe"},
  "./greeting.js":{readGuestGreeting:()=>null},"./instructionAssembly.js":{buildAgentInstructions,composeReadyAnalysisStepPolicy,createTurnThinkingState},
  "./modelRouter.js":{resolveModel:()=>({})},"./toolPolicy.js":{resolveLiveAgentToolPlan:async()=>({requiredTools:[],reason:"fixture"}),createAgentStepPolicy:()=>()=>({toolChoice:"none"})},
  "../skills/searchMenu.skill.js":{groundMenuTurn:async()=>{throw Error("UNEXPECTED_GROUND");},menuQueryForTurn:()=>""},
  "./linkPromise.js":{honorMenuLinkPromise:async()=>({action:"none"})},
  "../services/kitchenPolicy.service.js":{classifyKitchenSalesPolicyForContext:()=>({mode:"normal",requiresConsent:false})},
  "../utils/envNumber.js":{envNumber:(_v:any,fallback:number)=>fallback}
 };
 const compiled=ts.transpileModule(fs.readFileSync(new URL("../src/agent/fastfoodAgent.ts",import.meta.url),"utf8"),{compilerOptions:{target:ts.ScriptTarget.ES2022,module:ts.ModuleKind.CommonJS}}).outputText;
 const exports:any={};vm.runInNewContext(compiled,{exports,require:(name:string)=>{if(!(name in modules))throw Error("UNEXPECTED_FAKE_DEPENDENCY:"+name);return modules[name];},process:{env:{THINK_MODE:mode}},Date,Promise,setTimeout,console:{info(){},warn(){}}});
 return{run:()=>exports.runFastFoodAgent(ctx),events,captured,calls:()=>calls};
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
