import test from "node:test";
import assert from "node:assert/strict";
import { resolveAgentToolPlan } from "../src/agent/toolPolicy.js";
import { groundMenuTurn, menuQueryForTurn } from "../src/skills/searchMenu.skill.js";
import { validateFinalText } from "../src/agent/finalValidator.js";
const menu=[{name:"Донер куриный",category_name:"Донеры",price:1800,composition:"Курица, лаваш, томат",available:true},{name:"Цезарь",category_name:"Салаты",price:2200,composition:"Курица, салат",available:true}];
const ctx=(text:string,extra:any={})=>({instanceId:"audit-composition",phone:"77000000001",language:"kk",text,config:{},runtimeStatus:{is_accepting_orders:true,within_work_hours:true},hardRealtimeContext:{runtime_available:true},activeOrder:null,activeShiftNotes:[],chatHistory:[{role:"user",text:"Донердің құрамы қандай?"},{role:"assistant",text:"Донер куриныйдің құрамында курица, лаваш, томат."}],menuSnapshot:{items:menu},...extra} as any);
test("K07/K08 contextual ingredient question requires real fresh read of the customer-named dish",async()=>{
 for(const text of ["Ішінде не бар?","Что внутри?"]){
  const c=ctx(text);assert.ok(resolveAgentToolPlan(c).requiredTools.includes("searchMenu"),text);
  assert.equal(menuQueryForTurn(text,c),"донер куриный");
  let calls=0;const result:any=await groundMenuTurn(c,(async(_instance:any,_domain:any,_language:any,options:any)=>{calls++;assert.equal(options.forceFresh,true);return {items:menu.map(i=>i.name==="Донер куриный"?{...i,composition:"Курица, лаваш, сыр"}:i),source:"changed-authoritative-v3"};}) as any);
  assert.equal(calls,1);assert.equal(result.lookup_query,"донер куриный");assert.equal(result.items[0].name,"Донер куриный");assert.match(result.items[0].ingredients,/сыр/iu);assert.doesNotMatch(result.items[0].ingredients,/томат/iu);
  assert.deepEqual(resolveAgentToolPlan(c).requiredTools,["searchMenu"]);assert.equal(c.magicLinkGranted,undefined);
 }
});
test("contextual ingredient read applies a current blocking note before returning the prior dish",async()=>{
 const c=ctx("Ішінде не бар?",{activeShiftNotes:[{id:"now-blocked",text:"Донер куриный нет"}]});let reads=0;
 const result:any=await groundMenuTurn(c,(async()=>{reads++;return {items:menu};}) as any);
 assert.equal(reads,1);assert.deepEqual(result.items,[]);assert.ok(result.unavailable_now.some((n:string)=>/донер/iu.test(n)));
 assert.ok(result.safe_alternatives.every((i:any)=>i.name!=="Донер куриный"));
 const clear:any=await groundMenuTurn(ctx("Ішінде не бар?"),(async()=>({items:menu})) as any);assert.equal(clear.items[0].name,"Донер куриный");assert.match(clear.items[0].ingredients,/томат/iu);
});
test("composition context uses customer topic only, does not select from assistant prose or an unrelated old topic",()=>{
 assert.equal(menuQueryForTurn("Ішінде не бар?",ctx("Ішінде не бар?",{chatHistory:[{role:"assistant",text:"Цезарь жақсы."}]})),"");
 assert.equal(menuQueryForTurn("Ішінде не бар?",ctx("Ішінде не бар?",{chatHistory:[{role:"user",text:"Донер алайын"},{role:"user",text:"Где мой заказ?"}]})),"");
 assert.equal(menuQueryForTurn("Ішінде не бар?",ctx("Ішінде не бар?",{chatHistory:[{role:"user",text:"Донердің құрамы қандай?"},{role:"user",text:"Цезарьдың құрамы қандай?"}]})),"цезарь");
 assert.equal(menuQueryForTurn("Цезарьдың құрамы қандай?",ctx("Цезарьдың құрамы қандай?")),"цезарьдың құрамы қандай");
 assert.deepEqual(resolveAgentToolPlan(ctx("Рахмет")).requiredTools,[]);
});
test("an unresolved composition question reads live facts but marks the missing dish for clarification",async()=>{
 for(const extra of [{chatHistory:[]},{chatHistory:[{role:"user",text:"Донер куриный и Цезарь"}]},{menuSnapshot:{items:[...menu,{name:"Донер говяжий",price:1900}]}}]){
  const c=ctx("Ішінде не бар?",extra);let reads=0;const result:any=await groundMenuTurn(c,(async()=>{reads++;return {items:menu};}) as any);
  assert.equal(reads,1);assert.equal(result.needs_dish_clarification,true);assert.equal(result.lookup_query,"");
  assert.ok(!resolveAgentToolPlan(c).requiredTools.includes("sendMenuLink"));assert.ok(!resolveAgentToolPlan(c).requiredTools.includes("escalateToAdmin"));
 }
});
test("K09 explicit no-nut guarantee gets a direct honest denial without invented kitchen/handoff",()=>{
 const c=ctx("Жаңғақсыз қауіпсіз деп кепілдік бере аласыз ба?",{chatHistory:[{role:"user",text:"Баламда жаңғаққа аллергия бар"},{role:"user",text:"Цезарьдың нақты құрамы қандай?"}]});
 const raw="Кешіріңіз, бірақ тағамдардың құрамындағы ингредиенттер туралы нақты деректер алу үшін асханаға тексеруді сұрауға көмектесе аламын. Сіздерге қажет пе?";
 const r=validateFinalText(raw,c,{toolsCalled:["searchMenu"]});
 assert.match(r.text,/кепілдік.*алмай/iu);assert.equal(r.hasLink,false);assert.doesNotMatch(r.text,/өтініш.*тіркелді|тексеріп жатыр|нақтылап беремін|жеткіздім/iu);
 const ru=validateFinalText("Если нужно, могу помочь уточнить состав.",ctx("Можете гарантировать, что без орехов безопасно?",{language:"ru"}),{toolsCalled:["searchMenu"]});assert.match(ru.text,/гарант.*не могу|не могу.*гарант/iu);
});
test("honest guarantee denials and ordinary grounded recipe replies remain unchanged",()=>{
 for(const raw of ["Кешіріңіз, бірақ жаңғақсыз тағамдардың қауіпсіздігі туралы нақты кепілдік бере алмаймын.","Гарантировать безопасность при аллергии не могу.","Не могу гарантировать, что это блюдо безопасно для аллергии."]){
  assert.equal(validateFinalText(raw,ctx("Жаңғақсыз қауіпсіз деп кепілдік бере аласыз ба?",{language:/[әғқңөұүһі]/iu.test(raw)?"kk":"ru"}),{toolsCalled:["searchMenu"]}).text,raw);
 }
 const raw="Донер куриныйдің құрамында: курица, лаваш, томат.";assert.equal(validateFinalText(raw,ctx("Ішінде не бар?"),{toolsCalled:["searchMenu"]}).text,raw);
 for(const text of ["Кепілдік керек емес, құрамын ғана айтыңыз.","Не требую гарантировать безопасность, нужен состав."]){
  assert.equal(validateFinalText("Жарайды.",ctx(text),{toolsCalled:["searchMenu"]}).text,"Жарайды.");
 }
});
