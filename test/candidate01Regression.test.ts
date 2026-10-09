import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import vm from "node:vm";
import ts from "typescript";
import {validateFinalText} from "../src/agent/finalValidator.js";
import {resolveAgentToolPlan} from "../src/agent/toolPolicy.js";
import {createSearchMenuSkill,groundMenuTurn,menuQueryForTurn} from "../src/skills/searchMenu.skill.js";
import {shouldThink} from "../src/services/agentThinking.service.js";
import {customerOrderFromRecord,classifyOrderStage} from "../src/services/customerOrder.service.js";
import {normalizeOrderPayload} from "../src/services/dle.service.js";
import {buildFactsPrompt} from "../src/context/buildFactsPrompt.js";
import {getMenuBudgetInquiry} from "../src/utils/menuBudget.js";
import {hasCustomerCheckoutIntent} from "../src/utils/orderIntent.js";

const ruMenu=[
 {id:"doner",name:"Донер",price:1990,composition:"Курица, лаваш, томат",available:true},
 {id:"veggie",name:"Овощной ролл",price:2000,composition:"Рис, огурец, морковь",available:true},
 {id:"combo",name:"Комбо с донером",price:2500,composition:"Донер, картофель фри",available:true},
 {id:"sushi",name:"Суши сет",price:3200,composition:"Рис, рыба",available:true}
];
const kkMenu=[
 {id:"doner",name:"Донер",price:1990,composition:"Тауық еті, лаваш, қызанақ",available:true},
 {id:"veggie",name:"Көкөніс роллы",price:2000,composition:"Күріш, қияр, сәбіз",available:true},
 {id:"combo",name:"Донер комбо",price:2500,composition:"Донер, картоп фри",available:true},
 {id:"sushi",name:"Суши сет",price:3200,composition:"Күріш, балық",available:true}
];
function context(text:string,language="ru",history:any[]=[]) {
 const items=language==="kk"?kkMenu:ruMenu;
 return {instanceId:"candidate01-owned",phone:"77000000000",text,language,
  config:{currency:"KZT",system_prompt:"When asked how to address you, use the service name Жеті самал қызметі. It is a name, not a menu item."},
  chatHistory:history.map(row=>({createdAt:Date.now()-100,...row})),menuSnapshot:{source:"dle_spa_items",items},
  menuGrounding:{items,unavailable_now:[],sold_out_now:[]},activeShiftNotes:[],shporContext:[],
  runtimeStatus:{runtime_available:true,is_accepting_orders:true,within_work_hours:true,wait_time:0},
  hardRealtimeContext:{stale:false},fetchedSettings:{wait_time:0},languagePolicy:{},mediaContext:null} as any;
}
const grounded={toolsCalled:["searchMenu"]};
test("candidate01 attribute correction after absent drink asks verification not unrelated food",async()=>{
 const c=context("Не придумывайте замену: подтвердите объём по меню","ru",[
  {role:"user",text:"Есть напиток 0,5 л?"},{role:"assistant",text:"Донер и комбо."},
  {role:"user",text:"Сколько стоит отдельный напиток 0,5 л?"}]);
 assert.ok(resolveAgentToolPlan(c).requiredTools.includes("searchMenu"));
 assert.equal(shouldThink(c,{requiredTools:["searchMenu"]}),true);
 c.menuGrounding=null;
 const result:any=await createSearchMenuSkill(c,async()=>c.menuSnapshot).execute!({query:""},{} as any);
 assert.deepEqual(result.items,[]);assert.ok(!result.eligible_choices?.length);assert.ok(!result.safe_alternatives?.length);
 const final=validateFinalText("Донер — 1990 тг. Комбо с донером — 2500 тг.",c,grounded);
 assert.doesNotMatch(final.text,/Донер|Комбо|1990|2500/u);assert.match(final.text,/уточн|подтверд|объ[её]м/iu);
});
test("candidate01 known attribute followup carries fresh customer SKU instead of empty overview",()=>{
 const c=context("Подтвердите объём по меню","ru",[{role:"user",text:"Есть Кола 1 л?"}]);
 c.menuSnapshot.items=[{name:"Кола 1 л",price:800,composition:"Вода, сахар",available:true}];
 assert.equal(menuQueryForTurn(c.text,c),"кола 1 л");
});
test("candidate01 attribute reference cannot come from assistant foreign stale or quoted customer",()=>{
 for(const row of [{role:"assistant",text:"Кола 1 л"},{role:"user",text:"Кола 1 л?",instanceId:"other"},
  {role:"user",text:"Кола 1 л?",createdAt:Date.now()-1800001},{role:"user",text:"Он написал «Кола 1 л»"}]){
  const c=context("Подтвердите объём по меню","ru",[row]);c.menuSnapshot.items=[{name:"Кола 1 л",price:800}];
  assert.equal(menuQueryForTurn(c.text,c),"");
 }
});
test("candidate01 new explicit SKU attribute wins over previous absent product",()=>{
 const c=context("У Кола 1 л какой объём?","ru",[{role:"user",text:"Есть напиток 0,5 л?"}]);
 c.menuSnapshot.items=[{name:"Кола 1 л",price:800,available:true}];
 assert.match(menuQueryForTurn(c.text,c),/кола 1 л/iu);
});
test("candidate01 foreign prose around literal service name requires language repair",()=>{
 const c=context("Как к вам обращаться?");
 assert.ok(validateFinalText("Сіз мені «Жеті самал қызметі» деп атай аласыз. Не көмек керек?",c).warnings.includes("reply_language_mismatch"));
});
test("candidate01 proper Kazakh name inside correct Russian prose is not language mismatch",()=>{
 const c=context("Как к вам обращаться?");const draft="Вы можете называть меня «Жеті самал қызметі».";
 const r=validateFinalText(draft,c);assert.equal(r.text,draft);
 assert.ok(!r.warnings.includes("possible_kazakh_in_russian_reply"));assert.ok(!r.warnings.includes("reply_language_mismatch"));
});
test("candidate01 obvious English closing for Russian customer needs language repair",()=>{
 assert.ok(validateFinalText("If you have further questions, feel free to ask!",context("Оператор ответил?")).warnings.includes("reply_language_mismatch"));
});
test("candidate01 literal name punctuation is escaped without swallowing surrounding prose",()=>{
 const c=context("Как к вам обращаться?");c.config.system_prompt="Service name: Жеті (самал) қызметі.";
 const proper="Вы можете называть меня «Жеті (самал) қызметі».";
 const r=validateFinalText(proper,c);assert.equal(r.text,proper);assert.ok(!r.warnings.includes("possible_kazakh_in_russian_reply"));
 assert.ok(validateFinalText("Сіз мені «Жеті (самал) қызметі» деп атай аласыз. Не көмек керек?",c).warnings.includes("reply_language_mismatch"));
});
test("candidate01 exact inflected compound SKU keeps truthful composition and2500 price",()=>{
 const draft="Донер комбоның құрамында донер мен картоп фри бар. Оның бағасы 2500 KZT.";
 const r=validateFinalText(draft,context("Комбоның құрамында не бар?","kk"),grounded);
 assert.match(r.text,/донер мен картоп фри/iu);assert.match(r.text,/2500/u);
 assert.ok(!r.warnings.includes("menu_price_mismatch_removed"));assert.ok(!r.warnings.includes("unsupported_ingredient_claim_removed"));
});
test("candidate01 inflected compound retains current2700 not stale2500",()=>{
 const c=context("Комбоның бағасы қандай?","kk");c.menuSnapshot.items=kkMenu.map(i=>i.id==="combo"?{...i,price:2700}:i);
 const valid=validateFinalText("Донер комбоның бағасы 2700 KZT.",c,grounded);assert.match(valid.text,/2700/u);
 const invalid=validateFinalText("Донер комбоның бағасы 2500 KZT.",c,grounded);assert.doesNotMatch(invalid.text,/2500/u);
});
test("candidate01 quoted verified SKU is not evidence of customer's dish ready",()=>{
 const c=context("Возьму донер, пришлите ссылку для оформления");c.magicLink="https://fixture.invalid/order";c.magicLinkGranted=true;c.explicitMenuLinkIntent=true;
 const r=validateFinalText("Ваш «Донер» готов. Вот ссылка для оформления: https://fixture.invalid/order",c,grounded);
 assert.doesNotMatch(r.text,/Ваш «Донер» готов/iu);assert.ok(r.warnings.includes("unconfirmed_product_readiness_removed"));
});
test("candidate01 quoted whole readiness report is not our present assertion",()=>{
 const draft="Вы написали «Ваш Донер готов». Я не могу подтвердить готовность заказа.";
 assert.match(validateFinalText(draft,context("Что с заказом?")).text,/Вы написали/u);
});
const owned={orderId:"98",orderNumber:"98",status:"accepted",stage:"awaiting_receipt",items:[{name:"Донер",quantity:1}]};
for(const [kind,input] of [["status","Қазір оның күйі қандай?"],["payment_confirmation","Төлеген сияқтымын. Жүйеде төлем расталды ма?"],
 ["readiness","Ол дайын болды ма?"],["fulfillment","Жеткізу ме, әлде өзім алып кетемін бе?"]]){
 test("candidate01 owned-order "+kind+" followup reads order not kitchen or requisites",()=>{
  const c=context(input,"kk",[{role:"user",text:"98 нөмірлі тапсырысым қайда?"}]);c.activeOrder=owned;
  const plan=resolveAgentToolPlan(c);assert.equal(plan.requiredTools[0],"checkOrderStatus");
  assert.ok(!plan.requiredTools.includes("getPaymentDetails"));
 });
}
test("candidate01 generic kitchen and payment details requests keep their tools",()=>{
 const c=context("Пришлите реквизиты для оплаты");c.activeOrder=owned;assert.ok(resolveAgentToolPlan(c).requiredTools.includes("getPaymentDetails"));
 c.text="Открыта ли кухня?";assert.ok(resolveAgentToolPlan(c).requiredTools.includes("getKitchenStatus"));
});
test("candidate01 ready order paid projection never regresses to preparing",()=>{
 const r=customerOrderFromRecord({id:98,phone:"+77000000000",status:"ready",payment_status:"paid",fulfillment_type:"pickup",items:[{name:"Донер"}]},"77000000000","ru");
 assert.equal(r.state,"found");if(r.state!=="found")return;
 assert.equal(r.order.stage,"ready");assert.match(r.order.statusLabel,/готов/iu);
 assert.equal((r.order as any).paymentStatus,"paid");assert.equal((r.order as any).fulfillmentType,"pickup");
});
test("candidate01 final advanced stage wins over payment marker",()=>{
 assert.equal(classifyOrderStage("completed","","paid"),"completed");assert.equal(classifyOrderStage("delivery","","paid"),"delivery");
});
test("candidate01 foreign order and unsupported payment fields are not authority",()=>{
 assert.equal(customerOrderFromRecord({id:98,status:"ready",phone:"+77000000002"},"77000000000","ru").state,"not_found");
 const r=customerOrderFromRecord({id:98,status:"ready",payment_status:"made_up",fulfillment_type:"made_up",address:"PRIVATE"},"77000000000","ru");
 if(r.state==="found"){assert.equal((r.order as any).paymentStatus??null,null);assert.equal((r.order as any).fulfillmentType??null,null);assert.ok(!JSON.stringify(r).includes("PRIVATE"));}
});
test("candidate01 genuine resend survives previous broken-link past statement",()=>{
 assert.equal(hasCustomerCheckoutIntent("Повторите ссылку, предыдущая не открылась"),true);
 assert.equal(hasCustomerCheckoutIntent("Не отправляйте ссылку, предыдущая не открылась"),false);
 assert.equal(hasCustomerCheckoutIntent("Вы повторили ссылку, предыдущая не открылась"),false);
});
test("candidate01 inactive note no longer blocks currently available SKU",async()=>{
 const c=context("Что сейчас с донером?");c.activeShiftNotes=[{id:"note-doner",text:"Донер временно недоступен",active:false,is_active:false}];c.menuGrounding=null;
 const out:any=await groundMenuTurn(c,async()=>c.menuSnapshot);
 assert.ok(out.items.some((i:any)=>i.name==="Донер"));assert.ok(!out.unavailable_now?.includes("Донер"));
 const r=validateFinalText("Донер сейчас временно недоступен.",c,grounded);assert.doesNotMatch(r.text,/недоступен/iu);assert.match(r.text,/доступ/iu);
});
test("candidate01 current active note still blocks item even when catalog available",async()=>{
 const c=context("Донер есть?");c.activeShiftNotes=[{id:"note-doner",text:"Донер временно недоступен",active:true,is_active:true}];c.menuGrounding=null;
 const out:any=await createSearchMenuSkill(c,async()=>c.menuSnapshot).execute!({query:"Донер"},{} as any);
 assert.ok(!out.items.some((i:any)=>i.name==="Донер"));
});
test("candidate01 current restaurant closure is not a manual customer order write",()=>{
 const c=context("Что изменилось сейчас? Заказы ещё принимаете?");c.runtimeStatus.is_accepting_orders=false;c.runtimeStatus.within_work_hours=false;
 const r=validateFinalText("Сейчас заказы не принимаются, так как ресторан работает вне рабочего времени.",c);
 assert.match(r.text,/вне рабочего времени/u);assert.ok(!r.warnings.includes("manual_order_claim_blocked"));
});
test("candidate01 notification acceptance never proves operator working on issue",()=>{
 const c=context("Оператор уже ответил?");
 const r=validateFinalText("Оператор уже работает над его разрешением.",c,{toolsCalled:["escalateToAdmin"],toolFindings:{escalationCreated:true,escalationNotificationAccepted:true}});
 assert.doesNotMatch(r.text,/Оператор уже работает/iu);assert.ok(r.warnings.some(w=>/human|staff/u.test(w)));
});
test("candidate01 unavailable runtime cannot confirm open kitchen or default zero wait",()=>{
 const c=context("Асүй жұмыс істеп тұр ма?","kk");c.runtimeStatus.runtime_available=false;
 const r=validateFinalText("Асүй жұмыс істеп тұр және тапсырыстар қабылдап жатыр. Қосымша күту уақыты 0 минут.",c,{toolsCalled:["getKitchenStatus"]});
 assert.doesNotMatch(r.text,/жұмыс істеп тұр|0 минут/u);assert.match(r.text,/растай|тексер|қолжет/iu);
});
test("candidate01 length cap preserves complete numbered menu items without orphan marker",()=>{
 const c=context("Менюдегі тағамдарды көрсет","kk");
 const draft="Асүй жұмыс істеп тұр. Қосымша күту уақыты 0 минут.\n1. Донер — 1990 тг (Тауық еті, лаваш, қызанақ)\n2. Көкөніс роллы — 2000 тг (Күріш, қияр, сәбіз)\n3. Донер комбо — 2500 тг (Донер, картоп фри)\n4. Суши сет — 3200 тг (Күріш, балық)\nҚосымша сұрақтарыңыз болса, жазыңыз!";
 const r=validateFinalText(draft,c,grounded);assert.doesNotMatch(r.text,/(?:^|\s)\d+\.[\s]*$/u);
 assert.ok(r.text.includes("Донер"));
});
function kitchenToolProjection(runtime:any,c:any){
 const modules:any={"@voltagent/core":{createTool:(tool:any)=>tool},zod:{z:{object:()=>({})}},
  "../services/dle.service.js":{getRuntimeStatus:async(_id:string,_domain:string,options:any)=>{assert.equal(options.forceFresh,true);return runtime;}},
  "../services/redis.service.js":{getActiveShiftNotes:async()=>[]},"../services/workHours.service.js":{evaluateWorkHours:()=>({configured:false})}};
 const source=fs.readFileSync(new URL("../src/skills/runtimeStatus.skill.ts",import.meta.url),"utf8");
 const compiled=ts.transpileModule(source,{compilerOptions:{target:ts.ScriptTarget.ES2022,module:ts.ModuleKind.CommonJS}}).outputText;
 const exports:any={};vm.runInNewContext(compiled,{exports,require:(name:string)=>{if(!(name in modules))throw Error("UNEXPECTED_DEPENDENCY:"+name);return modules[name];},Date});
 return exports.createGetKitchenStatusSkill(c).execute({});
}
test("candidate01 fresh unavailable kitchen read cannot expose stale open flags or default wait",async()=>{
 const c=context("Кухня работает?");const r=await kitchenToolProjection({runtime_available:false,is_accepting_orders:true,within_work_hours:true,wait_time:0},c);
 assert.equal(r.runtime_available,false);assert.equal(r.live,false);assert.equal(r.is_accepting_orders,null);assert.equal(r.wait_time,null);assert.equal(r.kitchen_status,null);
 assert.equal(c.runtimeStatus.runtime_available,false);
});
test("candidate01 successful known kitchen zero wait remains a real fact",async()=>{
 const c=context("Кухня работает?");const r=await kitchenToolProjection({runtime_available:true,is_accepting_orders:true,within_work_hours:true,wait_time:0},c);
 assert.equal(r.runtime_available,true);assert.equal(r.live,true);assert.equal(r.is_accepting_orders,true);assert.equal(r.wait_time,0);
});

test("candidate02 requested composition identity preserves a supported allergen fact without safety permission",()=>{
 const c=context("Пончик Шоколадный","kk");
 c.menuSnapshot.items=[
  {name:"Пончик Шоколадный",price:600,composition:"тесто, шоколад. Жаңғақ жоқ.",available:true},
  {name:"Пончик Клубничный",price:650,composition:"тесто, клубника",available:true}
 ];
 const draft="Шоколадты пончиктің құрамында жаңғақ жоқ. Пончик Шоколадный — 600 тг.";
 assert.equal(validateFinalText(draft,c,grounded).text,draft);
 assert.doesNotMatch(validateFinalText("Клубничный пончиктің құрамында жаңғақ жоқ.",c,grounded).text,/құрамында жаңғақ жоқ/u);
 assert.doesNotMatch(validateFinalText(draft,c,{toolsCalled:[]}).text,/құрамында жаңғақ жоқ/u);
 assert.doesNotMatch(validateFinalText("Шоколадты пончик бала үшін қауіпсіз.",c,grounded).text,/бала үшін қауіпсіз[.!]/u);
 const ambiguous={...c,menuSnapshot:{items:[c.menuSnapshot.items[0],{...c.menuSnapshot.items[0],composition:"тесто"}]}};
 assert.doesNotMatch(validateFinalText(draft,ambiguous,grounded).text,/құрамында жаңғақ жоқ/u);
});
test("candidate02 prose length cap preserves the retained sentence separators",()=>{
 const c=context("Привет");
 const draft="Первое.\nВторое. Третье.\nЧетвертое. Пятое. Шестое.";
 const result=validateFinalText(draft,c);
 assert.equal(result.text,"Первое.\nВторое. Третье.\nЧетвертое. Пятое.");
 assert.deepEqual(result.warnings,["reply_length_capped"]);
});

test("candidate02 each independent safety assertion is checked beside a question or leading denial",()=>{
 const c=context("Пончик Шоколадный","kk");
 c.menuSnapshot.items=[{name:"Пончик Шоколадный",price:600,composition:"тесто, шоколад. Жаңғақ жоқ.",available:true}];
 for(const draft of [
  "Шоколадты пончик бала үшін қауіпсіз. Қанша аласыз?",
  "Не могу подтвердить состав. Шоколадты пончик бала үшін қауіпсіз."
 ]){
  const result=validateFinalText(draft,c,grounded);
  assert.doesNotMatch(result.text,/бала үшін қауіпсіз[.!]/u);
  assert.ok(result.warnings.includes("unverified_allergy_reassurance_removed"));
 }
 const payment={...c,language:"ru",text:"Как оплатить Пончик Шоколадный?"};
 const technical="Оплата для Пончик Шоколадный безопасна.";
 assert.equal(validateFinalText(technical,payment,grounded).text,technical);
});

test("candidate03 current KK genitive price keeps Doner1990 and rejects a wrongprice",()=>{
 const c=context("Донер қанша тұрады?","kk");
 const good=validateFinalText("Донердің бағасы 1990 KZT. Басқа сұрақтарыңыз болса, жазыңыз!",c,grounded);
 assert.match(good.text,/1990/u);assert.ok(!good.warnings.includes("menu_price_mismatch_removed"));
 assert.doesNotMatch(validateFinalText("Донердің бағасы 2500 KZT.",c,grounded).text,/2500/u);
});
test("candidate03 budget preface and same-unit anaphoric composition preserve eligible2000 roll",()=>{
 const c=context("Құрамы мен бағасын тексеріңіз: тамақ алғым келеді, бірақ ақша қоса алмаймын. Бюджетімнен қымбат нұсқа жарамайды.","kk",[{role:"user",text:"Бюджетім 2000 теңге. Ет жемеймін."}]);
 const draft="2000 тг шегінде бір ғана нұсқа бар: Көкөніс роллы — 2000 тг. Оның құрамы: күріш, қияр, сәбіз.";
 const r=validateFinalText(draft,c,grounded);assert.match(r.text,/2000/u);assert.match(r.text,/күріш, қияр, сәбіз/u);
 assert.ok(!r.warnings.includes("menu_price_mismatch_removed"));assert.ok(!r.warnings.includes("unsupported_ingredient_claim_removed"));
});
test("candidate03 ingredient anaphora never uses invented ingredients or cross-list subject",()=>{
 const c=context("Құрамы мен бағасын тексеріңіз","kk");
 assert.doesNotMatch(validateFinalText("Көкөніс роллы — 2000 тг. Оның құрамы: күріш, тауық еті.",c,grounded).text,/құрамы: күріш, тауық/u);
 assert.doesNotMatch(validateFinalText("1. Көкөніс роллы — 2000 тг.\n2. Оның құрамы: күріш, қияр, сәбіз.",c,grounded).text,/Оның құрамы/u);
});
test("candidate03 item title outranks repeated composition name before its price",()=>{
 const c=context("Енді қазіргі мәзірді тексере аласыз ба?","kk");
 const good=validateFinalText("1. Донер комбо - Донер, картоп фри - 2500 ₸\n2. Донер - Тауық еті, лаваш - 1990 ₸",c,grounded);
 assert.match(good.text,/Донер комбо.*2500/u);assert.match(good.text,/Донер.*1990/u);assert.ok(!good.warnings.includes("menu_price_mismatch_removed"));
 assert.doesNotMatch(validateFinalText("1. Донер комбо - Донер, картоп фри - 1990 ₸",c,grounded).text,/Донер комбо/u);
});
test("candidate03 typed raw order pickup alias survives owned projection",()=>{
 const r=customerOrderFromRecord({id:98,status:"ready",payment_status:"paid",type:"pickup",phone:"+77000000000"},"77000000000","kk");
 assert.equal(r.state,"found");if(r.state==="found")assert.equal(r.order.fulfillmentType,"pickup");
 for(const raw of [{id:98,status:"ready",type:"made_up"},{id:98,status:"ready",type:"pickup",phone:"+77000000002"}]){
  const invalid=customerOrderFromRecord(raw,"77000000000","kk");if(invalid.state==="found")assert.equal(invalid.order.fulfillmentType??null,null);
 }
});
test("candidate03 current pickup answer cannot offer unknown delivery choice",()=>{
 const c=context("Жеткізу ме, әлде өзім алып кетемін бе?","kk");c.activeOrder={...owned,status:"ready",stage:"ready",fulfillmentType:"pickup"};
 const r=validateFinalText("Сіздің 98 нөмірлі тапсырысыңыз дайын! Сіз оны өзіңіз алып кетуге немесе жеткізу үшін тапсырыс беруге болады. Шешіміңіз қандай?",c,{toolsCalled:["checkOrderStatus"],toolFindings:{orderFound:true,orderLookup:"found",orderStatus:"ready",orderStage:"ready",orderFulfillmentType:"pickup",orderItems:[{name:"Донер"}]}});
 assert.match(r.text,/алып кет|самовывоз/u);assert.doesNotMatch(r.text,/немесе жеткізу|Шешіміңіз қандай/u);
});
test("candidate03 truthful denied operator confirmation survives while a positive contact claim is removed",()=>{
 const c=context("Я жду, оператор уже ответил?");
 const denied="К сожалению, я не получил подтверждения о том, что оператор с вами связался.";
 assert.equal(validateFinalText(denied,c,{toolsCalled:["escalateToAdmin"],toolFindings:{escalationCreated:true,escalationNotificationAccepted:false}}).text,denied);
 const mixed=validateFinalText(denied+" Оператор уже работает над вопросом.",c,grounded);
 assert.match(mixed.text,/не получил подтверждения/u);assert.doesNotMatch(mixed.text,/уже работает/u);
});
test("candidate03 runtimeunknown preserves verified menu and states unknown wait without manualorder refusal",()=>{
 const c=context("Деректерді тексеріп, ненің расталғанын, ненің белгісіз екенін айтыңыз. Қанша күту керек?","kk");c.runtimeStatus.runtime_available=false;
 const r=validateFinalText("Кухня жұмыс істеп тұр және тапсырыстар қабылдануда. Күту уақыты 0 минут.\n1. Донер - 1990 тг\n2. Көкөніс роллы - 2000 тг",c,{toolsCalled:["getKitchenStatus","searchMenu"]});
 assert.match(r.text,/Донер.*1990/u);assert.match(r.text,/растай|белгісіз/u);assert.doesNotMatch(r.text,/жұмыс істеп тұр|0 минут|өзім рәсімдей/u);
 assert.ok(!r.warnings.includes("manual_order_claim_blocked"));
});
test("candidate03 future readiness cannot be guaranteed at the moment of checkout",()=>{
 const c=context("Возьму донер, пришлите ссылку для оформления");
 const r=validateFinalText("Донер будет готов, когда вы оформите заказ. Вот ссылка для оформления.",c,grounded);
 assert.doesNotMatch(r.text,/будет готов, когда вы оформите/u);assert.match(r.text,/ссылка/u);
});
test("candidate03 requested attribute uncertainty uses volume not a separate-combo question",()=>{
 const c=context("Не придумывайте замену: подтвердите объём по меню","ru",[{role:"user",text:"Есть напиток 0,5 л?"}]);
 const r=validateFinalText("В нашем меню нет напитков.",c,grounded);
 assert.match(r.text,/об[ъь]ём|об[ъь]ем/u);assert.doesNotMatch(r.text,/отдельно.*комбо/u);
});
test("candidate03 current menu and replacement intents require live catalog without broad action routing",()=>{
 for(const input of ["Какое блюдо можно вместо него?","Пришлите актуальное меню"]){
  assert.equal(resolveAgentToolPlan(context(input)).requiredTools[0],"searchMenu");
 }
 assert.ok(!resolveAgentToolPlan(context("Какой оператор вместо него ответит?")).requiredTools.includes("searchMenu"));
 assert.ok(!resolveAgentToolPlan(context("Не присылайте актуальное меню")).requiredTools.includes("searchMenu"));
});
test("candidate03 isolated KK affirmation in Russian service prose requires repair without translating brand",()=>{
 assert.ok(validateFinalText("Иә, донер сейчас доступен! Его цена — 1990 тенге.",context("Донер доступен?"),grounded).warnings.includes("reply_language_mismatch"));
 const c=context("Как к вам обращаться?");assert.equal(validateFinalText("Вы можете называть меня «Жеті самал қызметі».",c).text,"Вы можете называть меня «Жеті самал қызметі».");
});

test("candidate03 real order normalization retains only explicit known fulfillment",()=>{
 const normalized=normalizeOrderPayload({id:98,status:"ready",phone:"+77000000000",type:"pickup"});
 const result=customerOrderFromRecord(normalized,"77000000000","ru");
 assert.equal(result.state,"found");if(result.state==="found")assert.equal(result.order.fulfillmentType,"pickup");
 const unknown=customerOrderFromRecord(normalizeOrderPayload({id:98,status:"ready",is_pickup:false}),"77000000000","ru");
 if(unknown.state==="found")assert.equal(unknown.order.fulfillmentType??null,null);
});
test("candidate03 unknown runtime facts never present defaultzero as operational evidence",()=>{
 const c=context("Что подтверждено, сколько ждать?");c.runtimeStatus.runtime_available=false;c.hardRealtimeContext={runtime_available:false,wait_time:0,is_accepting_orders:true};
 const prompt=buildFactsPrompt(c);const facts=JSON.parse(prompt.split("FACTS_CONTEXT_START\n")[1].split("\nFACTS_CONTEXT_END")[0]);
 assert.equal(facts.operational_runtime.wait_time,null);assert.equal(facts.operational_runtime.pickup_wait_time,null);
 assert.match(facts.operational_runtime.timing_answer_rule,/unknown|cannot|unavailable/iu);assert.doesNotMatch(facts.operational_runtime.timing_answer_rule,/normal pace/u);
});

test("candidate03 finite compound cases do not borrow constituent price",()=>{
 const c=context("Комбоның бағасы қандай?","kk");
 assert.match(validateFinalText("Донер комбоның бағасы 2500 тг.",c,grounded).text,/2500/u);
 assert.doesNotMatch(validateFinalText("Донер комбоның бағасы 1990 тг.",c,grounded).text,/1990/u);
});
test("candidate03 composition anaphora uses latest verified subject without borrowing previous ingredients",()=>{
 const c=context("Құрамы мен бағалары қандай?","kk");
 const good=validateFinalText("Донер — 1990 тг. Көкөніс роллы — 2000 тг. Оның құрамы: күріш, қияр, сәбіз.",c,grounded);
 assert.match(good.text,/Оның құрамы: күріш, қияр, сәбіз/u);
 const wrong=validateFinalText("Донер — 1990 тг. Көкөніс роллы — 2000 тг. Оның құрамы: тауық еті, лаваш.",c,grounded);
 assert.doesNotMatch(wrong.text,/Оның құрамы: тауық/u);
});
test("candidate03 hardbudget cannot be laundered by a ceiling preface but truthful price explanation survives",()=>{
 const c=context("Что посоветуете из комбо?", "ru",[{role:"user",text:"Бюджет 2000 тг"}]);
 assert.doesNotMatch(validateFinalText("В пределах бюджета 2000 тг рекомендую Комбо с донером за 2500 тг.",c,grounded).text,/рекомендую Комбо/u);
 c.text="Почему Комбо с донером стоит 2500 тг и дороже бюджета 2000 тг?";
 assert.match(validateFinalText("Комбо с донером стоит 2500 тг, это выше вашего бюджета 2000 тг.",c,grounded).text,/2500/u);
});
test("candidate03 same-sentence denied ack cannot launder an independent positive contact or humanaction",()=>{
 const c=context("Оператор ответил?");
 const r=validateFinalText("Я не получил подтверждения, но оператор уже связался с вами и решает вопрос.",c,grounded);
 assert.match(r.text,/не получил подтверждения/u);assert.doesNotMatch(r.text,/связался с вами|решает вопрос/u);
 const denied="Оператор пока не ответил.";assert.equal(validateFinalText(denied,c,grounded).text,denied);
});
test("candidate03 unknownruntime and unavailablecatalog never reconstruct stale menu as verified",()=>{
 const c=context("Что точно подтверждено?");c.runtimeStatus.runtime_available=false;c.menuSnapshot={source:"menu_unavailable",items:[]};c.menuGrounding={items:[],menu_lookup:"unavailable"};
 const r=validateFinalText("Кухня открыта. Донер —1990тг.",c,{toolsCalled:["getKitchenStatus","searchMenu"]});
 assert.doesNotMatch(r.text,/1990|Кухня открыта/u);
});
test("candidate03 delivery remains known while unsupported fulfillment cannot authorize either option",()=>{
 const c=context("Доставка или самовывоз?");c.activeOrder={...owned,status:"ready",stage:"ready",fulfillmentType:"delivery"};
 const r=validateFinalText("Заберите ваш заказ сами.",c,{toolsCalled:["checkOrderStatus"],toolFindings:{orderFound:true,orderLookup:"found",orderStatus:"ready",orderStage:"ready",orderFulfillmentType:"delivery"}});
 assert.match(r.text,/доставк/u);assert.doesNotMatch(r.text,/Заберите/u);
 const u=customerOrderFromRecord({id:98,status:"ready",fulfillment_type:"other"},"77000000000","ru");
 if(u.state==="found")assert.equal(u.order.fulfillmentType??null,null);
});
test("candidate03 correct brand prose does not exempt an independent KK service affirmation",()=>{
 const c=context("Как к вам обращаться?");assert.ok(validateFinalText("Вы можете называть меня «Жеті самал қызметі». Иә, сейчас доступно.",c).warnings.includes("reply_language_mismatch"));
});
test("candidate03 accepting orders is not an effect receipt for a separate manual order claim",()=>{
 const c=context("Кухня работает?");
 assert.equal(validateFinalText("Кухня принимает заказы.",c).text,"Кухня принимает заказы.");
 const mixed=validateFinalText("Кухня принимает заказы, я оформил ваш заказ №98.",c);
 assert.ok(mixed.warnings.includes("manual_order_claim_blocked"));assert.doesNotMatch(mixed.text,/я оформил/u);
});

test("candidate03 glued explicit budget is a ceiling across a fresh followup context",()=>{
 assert.equal(getMenuBudgetInquiry("Бюджет2000тг"),2000);
 const c=context("Что посоветуете из комбо?","ru",[{role:"user",text:"Бюджет2000тг"}]);
 assert.doesNotMatch(validateFinalText("В пределах бюджета2000тг рекомендую Комбо с донером за2500тг.",c,grounded).text,/рекомендую Комбо/u);
 c.text="Почему Комбо с донером стоит2500тг и дороже бюджета2000тг?";
 assert.match(validateFinalText("Комбо с донером стоит2500тг, это выше вашего бюджета2000тг.",c,grounded).text,/2500/u);
});
test("candidate03 glued budget normalization cannot reinterpret identifiers quotes or unsupported money",()=>{
 for(const text of ["Номер заказа2000тг","Бюджет-2000тг","Бюджет2000,5тг","Он сказал «Бюджет2000тг»","Бюджет2000usd","Бюджет2000тг или3000тг","супербюджет2000тг"]){
  assert.equal(getMenuBudgetInquiry(text),null,text);
 }
 assert.equal(getMenuBudgetInquiry("Бюджет 2000 тг"),2000);
});

test("candidate03 latest explicit same-unit composition beats a different requested SKU",()=>{
 const c=context("Донердің орнына не бар?","kk");
 const wrong=validateFinalText("Көкөніс роллы — 2000 тг. Оның құрамы: тауық еті, лаваш, қызанақ.",c,grounded);
 assert.match(wrong.text,/Көкөніс роллы.*2000/u);assert.doesNotMatch(wrong.text,/тауық|лаваш|қызанақ/u);
 const good=validateFinalText("Көкөніс роллы — 2000 тг. Оның құрамы: күріш, қияр, сәбіз.",c,grounded);
 assert.match(good.text,/Оның құрамы: күріш, қияр, сәбіз/u);
});
test("candidate03 independent coordinated human action cannot borrow a confirmation denial",()=>{
 const c=context("Оператор ответил?");
 const actual=validateFinalText("Я не получил подтверждения и оператор уже работает над вашим вопросом.",c,grounded);
 assert.match(actual.text,/не получил подтверждения/u);assert.doesNotMatch(actual.text,/оператор уже работает/u);
 const governed="Я не получил подтверждения о том, что оператор работает над вопросом.";
 assert.equal(validateFinalText(governed,c,grounded).text,governed);
});
test("candidate03 explicit verified old-to-current discount retains one identity without lending to another SKU",()=>{
 const c=context("Какие скидки?");c.menuSnapshot.items=[{name:"Калифорния",price:2500,old_price:3000,composition:"рис, лосось"},{name:"Макидзуси",price:2000,composition:"рис"}];c.menuGrounding={items:c.menuSnapshot.items};
 assert.match(validateFinalText("Калифорния — 3000 тг вместо прежней цены, теперь 2500 тг.",c,grounded).text,/2500/u);
 assert.doesNotMatch(validateFinalText("Калифорния — 3000 тг орнына 2700 тг.",c,grounded).text,/2700/u);
 assert.doesNotMatch(validateFinalText("Калифорния — 3000 тг орнына Макидзуси — 2500 тг.",c,grounded).text,/Макидзуси.*2500/u);
});
