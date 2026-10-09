import test from "node:test";
import assert from "node:assert/strict";
import {validateFinalText} from "../src/agent/finalValidator.js";
import {buildFactsPrompt} from "../src/context/buildFactsPrompt.js";
import {createSearchMenuSkill,menuQueryForTurn} from "../src/skills/searchMenu.skill.js";
import {shouldThink} from "../src/services/agentThinking.service.js";

const menu=[
 {id:"doner",name:"Донер",price:1990,composition:"Курица, лаваш, томат",available:true,category_name:"Еда"},
 {id:"veggie",name:"Овощной ролл",price:2000,composition:"Рис, огурец, морковь",available:true,category_name:"Еда"},
 {id:"combo",name:"Комбо с донером",price:2500,composition:"Донер, картофель фри",available:true,category_name:"Комбо"}
];
function context(text:string,history:unknown[]=[]){return {instanceId:"owned-pilot",phone:"77000000000",text,language:"ru",config:{currency:"KZT"},chatHistory:history.map((h:any)=>({createdAt:Date.now(),...h})),menuSnapshot:{items:menu,source:"dle_spa_items"},menuGrounding:{items:menu},activeShiftNotes:[],shporContext:[],runtimeStatus:{runtime_available:true,is_accepting_orders:true,within_work_hours:true},hardRealtimeContext:{},languagePolicy:{},mediaContext:null} as any;}
const budgetHistory=[{role:"user",text:"Ассалаумағалейкум, брат. Заказ берейін деп едім ғой. Не бар сендерде, қарным ашып тұр. Екі мың теңгем бар менде, басқа жоқ."},{role:"assistant",text:"Донер — 1990 тг; овощной ролл — 2000 тг."}];
test("pilot02 hard2000 survives actual combo followup without hiding only its price",()=>{
 const c=context("А из комбо что посоветуете?",budgetHistory);
 const r=validateFinalText("Рекомендую Комбо с донером. В него входит донер и картофель фри, а стоит 2500 тг.",c,{toolsCalled:["searchMenu"]});
 assert.doesNotMatch(r.text,/Рекомендую Комбо|2500/u);assert.match(r.text,/2000/u);
});
test("pilot02 no-meat survives later ordinary recommendation",()=>{
 const c=context("Что ещё посоветуете?",[{role:"user",text:"Без мяса, пожалуйста"},{role:"assistant",text:"Овощной ролл."}]);
 const r=validateFinalText("Рекомендую Донер — 1990 тг, с курицей и лавашем.",c,{toolsCalled:["searchMenu"]});
 assert.doesNotMatch(r.text,/Рекомендую Донер|курицей/u);assert.match(r.text,/Овощной ролл/u);
});
test("pilot02 correct combo price is not charged to its later Doner ingredient",()=>{
 const r=validateFinalText("Также есть Комбо с донером, в который входит донер и картофель фри, стоимостью 2500 тг.",context("Какие комбо есть?"),{toolsCalled:["searchMenu"]});
 assert.match(r.text,/2500/u);assert.ok(!r.warnings.includes("menu_price_mismatch_removed"));
});
test("pilot02 exact combo subject carries across its price sentence",()=>{
 const r=validateFinalText("Рекомендую Комбо с донером. В него входит донер и картофель фри, а стоит 2500 тг.",context("Из комбо что посоветуете?"),{toolsCalled:["searchMenu"]});
 assert.match(r.text,/2500/u);assert.ok(!r.warnings.includes("menu_price_mismatch_removed"));
});
test("pilot02 guest-owned budget mention is not a catalog price claim",()=>{
 const r=validateFinalText("У вас 2000 тг. Донер — 1990 тг.",context("У меня 2000 тг. Что посоветуете?"),{toolsCalled:["searchMenu"]});
 assert.ok(!r.warnings.includes("menu_price_mismatch_removed"));
});
test("pilot02 removing wrong-priced recommendation does not leave an orphan list marker",()=>{
 const r=validateFinalText("1. Донер — 1990 тг.\n2. Комбо с донером — 1234 тг.",context("Меню?"),{toolsCalled:["searchMenu"]});
 assert.match(r.text,/Донер.*1990/u);assert.doesNotMatch(r.text,/1234|(?:^|\s)2\.(?:\s|$)/u);
});
test("pilot02 current-session budget reaches facts on a followup",()=>{
 const out=buildFactsPrompt(context("А из комбо что посоветуете?",budgetHistory));
 const facts=JSON.parse(out.slice(out.indexOf("\n")+1,out.lastIndexOf("\nFACTS_CONTEXT_END")));
 assert.equal(facts.current_food_budget?.ceiling_amount,2000);assert.equal(facts.current_food_budget?.checkout_authority,false);
});
test("pilot02 short constrained decision merits THINK despite confident menu plan",()=>{
 assert.equal(shouldThink(context("А из комбо что посоветуете?",budgetHistory),{requiredTools:["searchMenu"]}),true);
});

test("pilot02 refreshed2700 compound price remains current while old2500 is removed atomically",()=>{
 const c=context("Сколько стоит Комбо с донером?");c.menuSnapshot.items=menu.map(item=>item.id==="combo"?{...item,price:2700}:item);
 const valid=validateFinalText("Комбо с донером, в него входит донер и картофель фри, стоит 2700 тг.",c,{toolsCalled:["searchMenu"]});
 assert.match(valid.text,/2700/u);assert.ok(!valid.warnings.includes("menu_price_mismatch_removed"));
 const stale=validateFinalText("1. Комбо с донером — 2500 тг.\n2. Овощной ролл — 2000 тг.",c,{toolsCalled:["searchMenu"]});
 assert.doesNotMatch(stale.text,/2500|Комбо с донером/u);assert.match(stale.text,/1\. Овощной ролл.*2000/u);assert.doesNotMatch(stale.text,/2\./u);
});
test("separate compound and ingredient SKU prices each bind their own occurrence",()=>{
 const c=context("Меню?");const r=validateFinalText("Комбо с донером — 2500 тг; Донер — 1990 тг.",c,{toolsCalled:["searchMenu"]});
 assert.match(r.text,/2500/u);assert.match(r.text,/1990/u);assert.ok(!r.warnings.includes("menu_price_mismatch_removed"));
 const wrong=validateFinalText("Комбо с донером — 1990 тг; Донер — 2500 тг.",c,{toolsCalled:["searchMenu"]});
 assert.doesNotMatch(wrong.text,/Комбо с донером.*1990|Донер.*2500/u);
});
test("wrong list price drops complete item even in a single-line enumeration",()=>{
 const r=validateFinalText("1. Донер — 1990 тг. 2. Комбо с донером — 1234 тг. 3. Овощной ролл — 2000 тг.",context("Меню?"),{toolsCalled:["searchMenu"]});
 assert.doesNotMatch(r.text,/1234|Комбо с донером|(?:^|\s)3\./u);assert.match(r.text,/2\. Овощной ролл/u);
});
test("explicit volume SKU does not borrow a differently sized item's price",()=>{
 const c=context("Меню?");c.menuSnapshot.items=[{id:"one",name:"Кола 1 л",price:800,available:true}];
 assert.doesNotMatch(validateFinalText("Кола 0,5 л — 800 тг.",c,{toolsCalled:["searchMenu"]}).text,/Кола 0,5/u);
 assert.match(validateFinalText("Кола 1 л — 800 тг.",c,{toolsCalled:["searchMenu"]}).text,/800/u);
});
test("identical product names with conflicting prices stay ambiguous",()=>{
 const c=context("Меню?");c.menuSnapshot.items=[{name:"Донер",price:1990},{name:"Донер",price:2500}];
 assert.doesNotMatch(validateFinalText("Донер — 2500 тг.",c,{toolsCalled:["searchMenu"]}).text,/2500/u);
});

test("pilot02 absent drink relation followup asks clarification instead of unrelated food",async()=>{
 const c=context("Он продаётся отдельно или только в составе комбо?",[{role:"user",text:"Есть напиток 0,5 л?"}]);c.menuGrounding=null;
 const result:any=await createSearchMenuSkill(c,async()=>c.menuSnapshot).execute!({query:"он продается отдельно или только составе комбо"},{} as any);
 assert.deepEqual(result.items,[]);assert.deepEqual(result.eligible_choices,[]);assert.ok(!result.safe_alternatives?.length);assert.equal(result.menu_relation?.needs_clarification,true);
 const final=validateFinalText("Донер — 1990 тг, Комбо с донером — 2500 тг.",c,{toolsCalled:["searchMenu"]});
 assert.doesNotMatch(final.text,/Донер|Комбо|1990|2500/u);assert.match(final.text,/Уточните.*товар/iu);
});
test("customer relation with one exact known SKU carries only that identity to real menu skill",async()=>{
 const c=context("Он продаётся отдельно или в комбо?",[{role:"user",text:"Есть Овощной ролл?"}]);c.menuGrounding=null;
 assert.equal(menuQueryForTurn(c.text,c),"овощной ролл");
 const result:any=await createSearchMenuSkill(c,async()=>c.menuSnapshot).execute!({query:"комбо"},{} as any);
 assert.deepEqual(result.items.map((x:any)=>x.name),["Овощной ролл"]);assert.equal(menuQueryForTurn(c.text,c),"овощной ролл");
});
test("ambiguous two products in latest customer question do not choose a relation subject",()=>{
 const c=context("Он продаётся отдельно или в комбо?",[{role:"user",text:"Донер или Овощной ролл?"}]);
 assert.equal(menuQueryForTurn(c.text,c),"");
 assert.match(validateFinalText("Донер — 1990 тг.",c,{toolsCalled:["searchMenu"]}).text,/Уточните/iu);
});
test("relation without prior customer identity does not borrow assistant or quoted subject",()=>{
 for(const history of [[{role:"assistant",text:"Овощной ролл — 2000 тг"}],[{role:"user",text:"Он написал «Овощной ролл»"}],[]]){
  const c=context("Он продаётся отдельно или в комбо?",history);
  assert.equal(menuQueryForTurn(c.text,c),"");
 }
});
test("foreign stale future or unproved customer history cannot ground relation",()=>{
 const now=Date.now();
 for(const extra of [{instanceId:"foreign"},{phone:"77000000009"},{createdAt:now-30*60_000-1},{createdAt:now+5000},{createdAt:undefined}]){
  const c=context("Он продаётся отдельно или в комбо?",[{role:"user",text:"Овощной ролл?",...extra}]);
  assert.equal(menuQueryForTurn(c.text,c),"");
 }
});
test("new explicit product question wins over earlier pronoun relation context",()=>{
 const c=context("Донер продаётся отдельно?",[{role:"user",text:"Есть напиток 0,5 л?"}]);
 assert.match(menuQueryForTurn(c.text,c),/донер/u);
 assert.match(validateFinalText("Донер — 1990 тг.",c,{toolsCalled:["searchMenu"]}).text,/1990/u);
});
test("contextual relation can skip one neutral customer acknowledgment without assistant identity",()=>{
 const c=context("Он продаётся отдельно или в комбо?",[{role:"user",text:"Овощной ролл?"},{role:"assistant",text:"Комбо с донером"},{role:"user",text:"Спасибо"}]);
 assert.equal(menuQueryForTurn(c.text,c),"овощной ролл");
});
test("a new non-menu customer question ends old relation authority",()=>{
 const c=context("Он продаётся отдельно или в комбо?",[{role:"user",text:"Овощной ролл?"},{role:"user",text:"Где заказ 98?"}]);
 assert.equal(menuQueryForTurn(c.text,c),"");
});
