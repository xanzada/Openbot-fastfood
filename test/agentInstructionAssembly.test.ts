import assert from "node:assert/strict";
import test from "node:test";
import { buildAgentInstructions } from "../src/agent/instructionAssembly.js";

test("tenant voice is injected exactly once and remains bounded", () => {
  const marker = "UNIQUE_TENANT_VOICE_MARKER";
  const tenantText = `${marker} ${"restaurant voice ".repeat(100)}`;
  const instructions = buildAgentInstructions({
    instanceId: "prestige",
    text: "Сәлем",
    language: "kk",
    config: { system_prompt: tenantText },
    hardRealtimeContext: {},
    runtimeStatus: null,
    activeShiftNotes: [],
    chatHistory: [],
    shporContext: [],
    menuSnapshot: { items: [] },
  } as any);

  assert.equal(instructions.split(marker).length - 1, 1);
  assert.ok(!instructions.includes("TENANT_INSTRUCTIONS_START"));
  // The bound guards against a runaway prompt, not against a specific number.
  // Raised from 16 000 when getKitchenStatus/getShiftNotes were registered, then
  // from 16 500 for the two rules added after the 2026-08-12 live round (the link
  // never replaces an answer; an unavailable item still gets alternatives), then
  // from 17 000 for the allergen rule (never promise a dish is allergen-free), then
  // from 17 400 for the two-phase escalation contract (the tool reports whether
  // the operator was actually notified or a clarifying question is owed).
  // Each ceiling sits a few hundred chars above the then-current size, so a
  // runaway addition still trips it.
  // ...then from 17 800 for the unknown-kitchen rule (a failed runtime read is reported
  // as unknown instead of "normal", and the agent is told to confirm with getKitchenStatus
  // before committing to an order).
  // ...then from 18 200 for the restored wait-consent contract (mandatory ask,
  // per-channel delivery/pickup delays, clarify-on-unclear) plus the warm-voice
  // rules the owner asked for: fresh composition per guest, human-sized message
  // splitting, one-emoji cap, URL on its own line, and no system-flavoured link
  // wording (2026-08-24).
  // ...then from 20 000 for reply_shape: the code-computed wording plan (length,
  // message splitting, emoji policy, register) that replaced "adapt to the
  // customer" as a hope in prose with an actual per-turn input (2026-08-24).
  // ...then from 21 500 for the three inputs the owner asked for on 2026-08-29: a
  // vocabulary rule in VOICE (range, varied verbs, varied sentence length, no repeated
  // adjective), local_time (the real clock at the restaurant, the greeting that fits
  // this hour, the meal moment) and phrasing_memory (the openings and closing lines
  // this bot already spent on this guest). All three are per-turn facts the model could
  // not previously see, which is why "sound human" had to live as prose.
  assert.ok(instructions.length < 24_000, `assembled prompt is unexpectedly large: ${instructions.length}`);
});


const intelligenceCtx20261008=(text:string)=>({instanceId:"owned-intelligence-fixture",text,language:"kk",config:{},
 hardRealtimeContext:{},runtimeStatus:null,activeShiftNotes:[],chatHistory:[],shporContext:[],menuSnapshot:{items:[]}} as any);
const readFacts20261008=(value:string)=>JSON.parse(value.split("FACTS_CONTEXT_START\n")[1].split("\nFACTS_CONTEXT_END")[0]);
const readyAnalysis20261008={goal:"menu",mood:"unsure",urgency:"normal",complexity:"moderate",risk:"low",
 style_hint:"Brief and helpful",reasoning_brief:"Wants an affordable meal",proactive_note:"Verify menu facts"} as const;
for(const text of ["2000 теңгеге не келеді?","Ассалаумағалейкум, брат. Заказ берейін деп едім ғой. Не бар сендерде, қарным ашып тұр. Екі мың теңгем бар менде, басқа жоқ."]) {
 test("current intelligence20261008 current budget constraint: "+text,()=>{
  const facts=readFacts20261008(buildAgentInstructions(intelligenceCtx20261008(text)));
  assert.equal(facts.current_food_budget.ceiling_amount,2000);assert.equal(facts.current_food_budget.currency,"KZT");
  assert.equal(facts.current_food_budget.origin,"current_customer_turn");assert.equal(facts.current_food_budget.checkout_authority,false);
  assert.match(facts.current_food_budget.rule,/each/i);assert.match(facts.current_food_budget.rule,/menu|notes/i);
 });
}
test("current intelligence20261008 unknown budget asks clarification and never borrows history",()=>{
 const c=intelligenceCtx20261008("2.5 теңгеге не аламын?");c.chatHistory=[{role:"user",text:"У меня 9000 тенге"}];
 const facts=readFacts20261008(buildAgentInstructions(c));
 assert.equal(facts.current_food_budget.ceiling_amount,null);assert.match(facts.current_food_budget.rule,/clarif/i);
 assert.equal(readFacts20261008(buildAgentInstructions({...c,text:"Сәлем"})).current_food_budget,null);
});
test("current intelligence20261008 analysis becomes ready between steps without changing tool policy",async()=>{
 const {composeReadyAnalysisStepPolicy,createTurnThinkingState}=await import("../src/agent/instructionAssembly.js");
 const {createAgentStepPolicy}=await import("../src/agent/toolPolicy.js");
 const original=buildAgentInstructions(intelligenceCtx20261008("2000 теңгеге не келеді?"),"CRITIC_NOTE exact independent extra");
 const messages:any[]=[{role:"system",content:"SDK PREFIX\n"+original+"\nSDK SUFFIX",providerOptions:{owned:true}},
  {role:"system",content:"independent system"},{role:"user",content:"actual user"},{role:"tool",content:[{type:"tool-result",toolCallId:"owned",toolName:"searchMenu",output:{items:[]}}]}];
 const frozen=structuredClone(messages);const state=createTurnThinkingState(null);const base=createAgentStepPolicy({requiredTools:["searchMenu"],reason:"owned"});
 const policy=composeReadyAnalysisStepPolicy(base,original,state.read);
 assert.deepEqual(policy({stepNumber:0,messages}),base({stepNumber:0}));
 state.settle(readyAnalysis20261008 as any);
 const result:any=policy({stepNumber:0,messages});
 assert.deepEqual(result.toolChoice,{type:"tool",toolName:"searchMenu"});
 assert.ok(!(result instanceof Promise));assert.notEqual(result.messages,messages);assert.deepEqual(messages,frozen);
 assert.ok(result.messages[0].content.startsWith("SDK PREFIX\n"));assert.ok(result.messages[0].content.endsWith("\nSDK SUFFIX"));
 assert.ok(result.messages[0].content.includes("CRITIC_NOTE exact independent extra"));
 assert.deepEqual(result.messages.slice(1),messages.slice(1));
 const after=readFacts20261008(result.messages[0].content),before=readFacts20261008(original);
 assert.equal(after.turn_analysis.likely_goal,"menu");delete after.turn_analysis;delete before.turn_analysis;assert.deepEqual(after,before);
 assert.equal(policy({stepNumber:4,messages}).toolChoice,"none");
 assert.equal(policy({stepNumber:1,messages}).toolChoice,"auto");
});
test("current intelligence20261008 ready-before-step and greeting none retain all base fields",async()=>{
 const {composeReadyAnalysisStepPolicy,createTurnThinkingState}=await import("../src/agent/instructionAssembly.js");
 const state=createTurnThinkingState(readyAnalysis20261008 as any);
 const original=buildAgentInstructions(intelligenceCtx20261008("Не бар?"));
 const base=()=>({toolChoice:"none",temperature:0.25,providerOptions:{owned:"preserved"},activeTools:["searchMenu"]});
 const result:any=composeReadyAnalysisStepPolicy(base,original,state.read)({stepNumber:0,messages:[{role:"system",content:original}]});
 assert.equal(result.toolChoice,"none");assert.equal(result.temperature,0.25);assert.deepEqual(result.providerOptions,{owned:"preserved"});assert.deepEqual(result.activeTools,["searchMenu"]);
 assert.equal(readFacts20261008(result.messages[0].content).turn_analysis.likely_goal,"menu");
});
test("current intelligence20261008 no late/error state mutation and no pending-promise wait",async()=>{
 const {composeReadyAnalysisStepPolicy,createTurnThinkingState}=await import("../src/agent/instructionAssembly.js");
 const state=createTurnThinkingState(null);state.settle(readyAnalysis20261008 as any);state.settle(null);assert.equal(state.read(),null);
 state.close();state.settle(readyAnalysis20261008 as any);assert.equal(state.read(),null);
 const original=buildAgentInstructions(intelligenceCtx20261008("Не бар?")),base=()=>({toolChoice:"auto" as const});
 assert.deepEqual(composeReadyAnalysisStepPolicy(base,original,state.read)({messages:[{role:"system",content:original}]}),base());
 let awaited=false;const pending={then(){awaited=true;}} as any;
 assert.deepEqual(composeReadyAnalysisStepPolicy(base,original,()=>pending)({messages:[{role:"system",content:original}]}),base());assert.equal(awaited,false);
});
test("current intelligence20261008 skip absent, duplicate or foreign owned span observably",async()=>{
 const {composeReadyAnalysisStepPolicy}=await import("../src/agent/instructionAssembly.js");
 const original=buildAgentInstructions(intelligenceCtx20261008("Не бар?")),base=()=>({toolChoice:"auto" as const}),reasons:string[]=[];
 const p=composeReadyAnalysisStepPolicy(base,original,()=>readyAnalysis20261008 as any,reason=>reasons.push(reason));
 for(const messages of [[{role:"system",content:"other"}],[{role:"system",content:original+original}],
  [{role:"system",content:original},{role:"user",content:original}],[{role:"user",content:original}]]) assert.deepEqual(p({messages}),base());
 assert.equal(reasons.length,4);assert.ok(reasons.every(r=>/span|role/.test(r)));
});
test("current intelligence20261008 cache reuses advisory without accumulation and keeps fresh critic pass",async()=>{
 const {composeReadyAnalysisStepPolicy}=await import("../src/agent/instructionAssembly.js");
 const original=buildAgentInstructions(intelligenceCtx20261008("Не бар?")),base=()=>({toolChoice:"auto" as const});
 const p=composeReadyAnalysisStepPolicy(base,original,()=>readyAnalysis20261008 as any),messages=[{role:"system",content:original}];
 const a:any=p({messages}),b:any=p({messages});assert.equal(a.messages[0].content,b.messages[0].content);
 assert.equal((a.messages[0].content.match(/"turn_analysis":/g)||[]).length,1);
 const critic=original+"\n\nCRITIC_NOTE owned second pass";const second:any=composeReadyAnalysisStepPolicy(base,critic,()=>readyAnalysis20261008 as any)({messages:[{role:"system",content:"enriched\n"+critic+"\nsuffix"}]});
 assert.equal((second.messages[0].content.match(/CRITIC_NOTE owned second pass/g)||[]).length,1);assert.ok(second.messages[0].content.endsWith("\nsuffix"));
});
test("current intelligence20261008 refuse missing facts and unbounded advisory without changing messages",async()=>{
 const {composeReadyAnalysisStepPolicy}=await import("../src/agent/instructionAssembly.js");const base=()=>({toolChoice:"auto" as const}),reasons:string[]=[];
 const c=intelligenceCtx20261008("Не бар?"),original=buildAgentInstructions(c);
 for(const [instructions,analysis] of [["not facts",readyAnalysis20261008],[original,{...readyAnalysis20261008,style_hint:"x".repeat(10000)}]] as const) {
  assert.deepEqual(composeReadyAnalysisStepPolicy(base,instructions,()=>analysis as any,r=>reasons.push(r))({messages:[{role:"system",content:instructions}]}),base());
 }
 assert.equal(reasons.length,2);
});
