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
import {normalizeOrderPayload,normalizeRuntimeStatus} from "../src/services/dle.service.js";
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
 const c=context("Расскажите подробнее");
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

const candidate04WaitDraft="Кешіріңіз, асханада күту уақыты - 1 сағат. Сіз күтуге дайынсыз ба?";
test("candidate04 actual RU wait question rejects otherwise grounded full Kazakh prose",()=>{
 const c=context("Сколько ждать?");c.runtimeStatus.wait_time=60;c.fetchedSettings.wait_time=60;
 const r=validateFinalText(candidate04WaitDraft,c,{toolsCalled:["getKitchenStatus"]});
 assert.ok(r.warnings.includes("reply_language_mismatch"));
});
test("candidate04 actual RU wait consent detects inflected Kazakh surrounding prose",()=>{
 const c=context("Да, я готов ждать. Откройте оформление");c.magicLinkGranted=true;
 const r=validateFinalText("Тапсырыс беруге тырысамын. Сонымен, сіз не алғыңыз келеді? Мен сіздерге біздің мәзірді ұсынамын!",c,{toolsCalled:["getKitchenStatus","sendMenuLink"]});
 assert.ok(r.warnings.includes("reply_language_mismatch"));
});
test("candidate04 correct Russian wrapper preserves Kazakh brand and item names without repair",()=>{
 const c=context("Как к вам обращаться?");c.config.agent_name="Жеті самал қызметі";
 c.menuSnapshot.items=[{name:"Көкөніс роллы",price:2000,composition:"Күріш, қияр, сәбіз"}];
 const text="Вы можете обращаться ко мне «Жеті самал қызметі». Көкөніс роллы — 2000 тг.";
 const r=validateFinalText(text,c,grounded);
 assert.equal(r.text,text);assert.ok(!r.warnings.includes("reply_language_mismatch"));
 const mixed=validateFinalText("Вы можете называть меня «Жеті самал қызметі». "+candidate04WaitDraft,c,{toolsCalled:["getKitchenStatus"]});
 assert.ok(mixed.warnings.includes("reply_language_mismatch"));
});
test("candidate04 current KK wait answer stays exact and language follows each fresh context",()=>{
 const kk=context("Қанша күту керек?","kk");kk.runtimeStatus.wait_time=60;kk.fetchedSettings.wait_time=60;
 const r=validateFinalText(candidate04WaitDraft,kk,{toolsCalled:["getKitchenStatus"]});
 assert.equal(r.text,candidate04WaitDraft);assert.ok(!r.warnings.includes("reply_language_mismatch"));
 const ru=context("Сколько ждать?");ru.runtimeStatus.wait_time=60;ru.fetchedSettings.wait_time=60;
 assert.ok(validateFinalText(candidate04WaitDraft,ru,{toolsCalled:["getKitchenStatus"]}).warnings.includes("reply_language_mismatch"));
});
test("candidate04 recorded SOS does not promise an unsupported human response time",()=>{
 const c=context("Оператор уже ответил?");
 const draft="Ваш запрос о помощи с оператором был зафиксирован, и я не могу подтвердить, что уведомление было отправлено. Скоро должен ответить человек из службы поддержки.";
 const r=validateFinalText(draft,c,{toolsCalled:[],toolFindings:{escalationCreated:true,escalationNotificationAccepted:false}});
 assert.match(r.text,/был зафиксирован/u);assert.match(r.text,/не могу подтвердить/u);
 assert.doesNotMatch(r.text,/Скоро должен ответить/u);assert.ok(r.warnings.includes("unverified_human_action_removed"));
});
test("candidate04 human ETA denial and conditional possibility are not a timing guarantee",()=>{
 const c=context("Когда ответит поддержка?");
 for(const text of ["Скоро ли ответит человек из службы поддержки?","Не могу подтвердить, что человек из службы поддержки скоро ответит.","Если человек из службы поддержки ответит, вы увидите сообщение."]){
  assert.equal(validateFinalText(text,c,{toolFindings:{escalationCreated:true,escalationNotificationAccepted:false}}).text,text);
 }
});
test("candidate04 accepted notification still cannot prove a soon human reply",()=>{
 const c=context("Когда ответит поддержка?");
 const r=validateFinalText("Заявка зарегистрирована. Служба поддержки скоро ответит.",c,{toolFindings:{escalationCreated:true,escalationNotificationAccepted:true}});
 assert.match(r.text,/зарегистрирована/u);assert.doesNotMatch(r.text,/скоро ответит/u);
});
test("candidate04 normalization retains unavailable authority into actual kitchen handler",async()=>{
 const c=context("Кухня работает?");
 const normalized=normalizeRuntimeStatus({runtime_available:false,is_accepting_orders:true,within_work_hours:true,wait_time:0});
 assert.equal(normalized.runtime_available,false);
 const r=await kitchenToolProjection(normalized,c);
 assert.equal(r.runtime_available,false);assert.equal(r.live,false);assert.equal(r.wait_time,null);assert.equal(c.runtimeStatus.runtime_available,false);
});
test("candidate04 normalization preserves genuine live zero wait without an unavailable marker",async()=>{
 for(const data of [{runtime_available:true,wait_time:0},{wait_time:0,is_accepting_orders:true,within_work_hours:true}]){
  const c=context("Сколько ждать?");const normalized=normalizeRuntimeStatus(data);const r=await kitchenToolProjection(normalized,c);
  assert.equal(r.runtime_available,true);assert.equal(r.live,true);assert.equal(r.wait_time,0);
 }
});
test("candidate04 unknown runtime prompt exposes neither numeric nor verbal default zero",()=>{
 const c=context("Қанша күту керек?","kk");c.runtimeStatus.runtime_available=false;
 c.hardRealtimeContext={runtime_available:false,stale:false,wait_time:0,delivery:true,pickup:true};
 const facts=JSON.parse(buildFactsPrompt(c).split("FACTS_CONTEXT_START\n")[1].split("\nFACTS_CONTEXT_END")[0]);
 const runtime=facts.operational_runtime;assert.equal(runtime.wait_time,null);assert.equal(runtime.delivery_wait_time,null);assert.equal(runtime.pickup_wait_time,null);
 assert.equal(runtime.wait_label,null);assert.equal(runtime.delivery_wait_label,null);assert.equal(runtime.pickup_wait_label,null);assert.equal(runtime.delivery,null);assert.equal(runtime.pickup,null);
 assert.match(runtime.timing_answer_rule,/unknown/u);
});
test("candidate04 unavailable normalized runtime cannot certify zero or no-wait while keeping verified catalog",()=>{
 const c=context("Ненің расталғанын, ненің белгісіз екенін айтыңыз. Қанша күту керек?","kk");
 c.runtimeStatus=normalizeRuntimeStatus({runtime_available:false,wait_time:0,is_accepting_orders:true});
 const draft="Донер — 1990 теңге, тауық еті, лаваш, қызанақ. Сіздің сұрауыңызға байланысты күту уақыты 0 минут. Яғни, тапсырыс жасаған жағдайда күтуден қажеттілік жоқ.";
 const r=validateFinalText(draft,c,{toolsCalled:["getKitchenStatus","searchMenu"]});
 assert.match(r.text,/Донер.*1990/u);assert.doesNotMatch(r.text,/0 минут|күтуден қажеттілік жоқ/u);assert.match(r.text,/растай|белгісіз/u);
});
test("candidate04 explicit unknown runtime blocks independent no-wait assurance",()=>{
 const c=context("Сколько ждать?");c.runtimeStatus.runtime_available=false;
 const r=validateFinalText("Овощной ролл — 2000 тг. Ожидание не требуется, можете заказать без ожидания.",c,grounded);
 assert.match(r.text,/Овощной ролл.*2000/u);assert.doesNotMatch(r.text,/Ожидание не требуется|без ожидания/u);assert.match(r.text,/подтверд|неизвест/u);
});
test("candidate04 genuine known zero and honest unknown wait statements retain catalog prices",()=>{
 const c=context("Сколько ждать?");const good="Овощной ролл — 2000 тг. Время ожидания 0 минут.";
 assert.equal(validateFinalText(good,c,{toolsCalled:["getKitchenStatus","searchMenu"]}).text,good);
 c.runtimeStatus.runtime_available=false;const denied="Овощной ролл — 2000 тг. Время ожидания сейчас подтвердить не могу.";
 assert.equal(validateFinalText(denied,c,grounded).text,denied);
});

const candidate05UnknownDraft="Кешіріңіз, бірақ мен асхананың қазіргі күйін немесе күту уақытын тексере алмаймын. Дегенмен, арнайы нұсқаулар жоқ, демек, асхана ашық сияқты. Сізге қандай тағамдар ұсынылғанын білу үшін мәзірді тексерсем бе?";
function candidate05UnknownContext(language="kk"){
 const c=context(language==="kk"?"Не барын және қанша күту керегін түсінбедім. Деректерді тексеріп, ненің расталғанын, ненің белгісіз екенін айтыңыз.":"Что доступно и сколько ждать? Укажите подтверждённое и неизвестное.",language);
 c.runtimeStatus={runtime_available:false,is_accepting_orders:true,within_work_hours:true,wait_time:0};
 c.fetchedSettings={wait_time:0};return c;
}
test("candidate05 exact mixed unknown-runtime answer retains catalog facts without inferred openness",()=>{
 const c=candidate05UnknownContext();const r=validateFinalText(candidate05UnknownDraft,c,{toolsCalled:["getKitchenStatus","getShiftNotes"]});
 assert.ok(r.warnings.includes("unsupported_kitchen_claim_clause_removed"));
 assert.doesNotMatch(r.text,/асхана ашық сияқты/u);assert.match(r.text,/Донер/u);assert.match(r.text,/растай алмай|тексере алмай|белгісіз/u);
 assert.doesNotMatch(r.text,/0 минут|күту(?:ден)? қажеттілік жоқ/u);
});
test("candidate05 hedged unknown kitchen closure is not established by absent notes",()=>{
 const c=candidate05UnknownContext();const r=validateFinalText("Арнайы нұсқаулар жоқ, демек, асхана жабық сияқты.",c,{toolsCalled:["getKitchenStatus","getShiftNotes"]});
 assert.doesNotMatch(r.text,/асхана жабық сияқты/u);assert.ok(r.warnings.some(x=>x.includes("unsupported_kitchen")));
 const ru=candidate05UnknownContext("ru");const s=validateFinalText("Нет особых инструкций, поэтому кухня, кажется, открыта. Донер — 1990 тг.",ru,{toolsCalled:["getKitchenStatus","getShiftNotes","searchMenu"]});
 assert.doesNotMatch(s.text,/кухня.*открыта/u);assert.match(s.text,/Донер/u);assert.match(s.text,/1990/u);
});
test("candidate05 live known kitchen states and real zero remain valid",()=>{
 for(const [open,draft] of [[true,"Асхана ашық."],[false,"Асхана жабық."]] as const){
  const c=context("Асхана ашық па?","kk");c.runtimeStatus.is_accepting_orders=open;c.runtimeStatus.within_work_hours=open;
  assert.equal(validateFinalText(draft,c,{toolsCalled:["getKitchenStatus"]}).text,draft);
 }
 const c=context("Сколько ждать?");assert.equal(validateFinalText("Время ожидания — 0 минут.",c,{toolsCalled:["getKitchenStatus"]}).text,"Время ожидания — 0 минут.");
});
test("candidate05 configured schedule is not an unknown live kitchen status",()=>{
 const c=candidate05UnknownContext("ru");c.config.work_hours="10:00-22:00";
 const draft="По графику кухня работает с 10:00 до 22:00. Текущий статус кухни подтвердить не могу.";
 const result=validateFinalText(draft,c,{toolsCalled:["getBusinessInfo","getKitchenStatus"]});assert.ok(result.text.startsWith(draft));
 assert.doesNotMatch(validateFinalText("По графику работаем с 10:00 до 22:00, значит сейчас кухня открыта.",c,{toolsCalled:["getBusinessInfo"]}).text,/значит сейчас кухня открыта/u);
});
test("candidate05 explicit kitchen uncertainty and question do not become a positive assertion",()=>{
 const c=context("Қазір асхана ашық па?","kk");c.runtimeStatus.runtime_available=false;
 for(const draft of ["Асхана ашық па?","Асхана ашық екенін растай алмаймын."]){
  assert.equal(validateFinalText(draft,c,{toolsCalled:["getKitchenStatus"]}).text,draft);
 }
});
test("candidate05 mixed availability answer excludes blocked and explicitly unavailable items",()=>{
 const c=candidate05UnknownContext("ru");
 c.activeShiftNotes=[{id:"block-doner",text:"Донер временно недоступен",active:true,is_active:true}];
 c.menuSnapshot.items=[{name:"Донер",price:1990,composition:"Курица",available:true},{name:"Овощной ролл",price:2000,composition:"Рис",available:true},{name:"Суши сет",price:3200,composition:"Рыба",available:false}];
 c.menuGrounding={items:c.menuSnapshot.items,unavailable_now:["Донер"],sold_out_now:[]};
 const r=validateFinalText("Нет ограничений, поэтому кухня открыта.",c,{toolsCalled:["getKitchenStatus","getShiftNotes"]});
 assert.match(r.text,/Овощной ролл/u);assert.doesNotMatch(r.text,/Донер|Суши сет/u);
});
test("candidate05 failed or stale catalog does not become a verified availability fallback",()=>{
 for(const stale of [false,true]){
  const c=candidate05UnknownContext("ru");c.menuGrounding={items:c.menuSnapshot.items,menu_lookup:"unavailable"};c.hardRealtimeContext.stale=stale;
  const r=validateFinalText("Нет ограничений, поэтому кухня открыта.",c,{toolsCalled:["getKitchenStatus"]});
  assert.doesNotMatch(r.text,/Донер|1990|доступн.*ролл/u);assert.match(r.text,/подтверд|не могу|неизвест/iu);
 }
});
test("candidate05 unknown-runtime prompt separates catalog facts from empty notes and asks no redundant permission",()=>{
 const c=candidate05UnknownContext();const facts=JSON.parse(buildFactsPrompt(c).replace(/^FACTS_CONTEXT_START\s*/u,"").replace(/\s*FACTS_CONTEXT_END$/u,""));
 assert.equal(facts.operational_runtime.wait_time,null);assert.equal(facts.operational_runtime.runtime_available,false);
 assert.match(facts.operational_runtime.timing_answer_rule,/notes|instructions/u);
 assert.match(facts.operational_runtime.mixed_fact_answer_rule,/catalog|menu/u);assert.match(facts.operational_runtime.mixed_fact_answer_rule,/unknown/u);
 assert.equal(facts.menu_snapshot.items.length,c.menuSnapshot.items.length);
});
test("candidate05 original indirect human denial keeps its complete dependent clause",()=>{
 const c=context("Пока оператор не ответил, что известно точно?");
 const draft="Мы создали заявку на соединение с живым оператором по вашей проблеме. К сожалению, я не могу подтвердить, ответил ли оператор уже или когда именно он свяжется с вами. Спасибо за ваше терпение!";
 const r=validateFinalText(draft,c,{toolFindings:{escalationCreated:true,escalationNotificationAccepted:false}});
 assert.equal(r.text,draft);assert.ok(!r.warnings.includes("unverified_human_action_removed"));
});
test("candidate05 indirect human uncertainty never shields an independent promised ETA",()=>{
 const c=context("Оператор ответил?");const r=validateFinalText("Я не могу подтвердить, ответил ли оператор уже. Но оператор скоро свяжется с вами.",c,{toolFindings:{escalationCreated:true,escalationNotificationAccepted:false}});
 assert.match(r.text,/не могу подтвердить, ответил ли оператор уже/u);assert.doesNotMatch(r.text,/скоро свяжется/u);
 const s=validateFinalText("Я не могу подтвердить, ответил ли оператор, и оператор скоро свяжется с вами.",c,{toolFindings:{escalationCreated:true,escalationNotificationAccepted:false}});
 assert.doesNotMatch(s.text,/оператор скоро свяжется/u);assert.match(s.text,/не могу подтвердить/u);
});

test("candidate05 fresh catalog survives operational staleness while stale catalog stays unknown",()=>{
 const c=candidate05UnknownContext("ru");c.runtimeStatus.stale=true;c.hardRealtimeContext.stale=true;
 c.menuSnapshot.source="menu_live";c.menuGrounding.source="catalog.context.get";
 const r=validateFinalText("Статус кухни подтвердить не могу.",c,{toolsCalled:["getKitchenStatus","getShiftNotes"]});
 assert.match(r.text,/Донер/u);assert.match(r.text,/Овощной ролл/u);assert.match(r.text,/подтвердить не могу/u);
 assert.doesNotMatch(r.text,/0 минут|кухня открыта/u);
 for(const mark of [{stale:true},{is_stale:true},{source:"menu_stale_backup"},{menu_lookup:"unavailable"}]){
  const s=candidate05UnknownContext("ru");s.menuSnapshot.source="menu_live";s.menuGrounding={...s.menuGrounding,...mark};
  const denied=validateFinalText("Статус кухни подтвердить не могу.",s,{toolsCalled:["getKitchenStatus"]});
  assert.doesNotMatch(denied.text,/Донер|Овощной ролл|1990|2000/u);
  assert.match(denied.text,/подтверд|не могу|неизвест/iu);
 }
});

const candidate06ComboDraft="Донер комбосының құрамында Донер (тауық еті, лаваш, қызанақ) және картоп фри бар. Сізге тапсырыс жасау керек пе?";
test("candidate06 actual compound with nested ingredients retains verified direct combo core",()=>{
 const r=validateFinalText(candidate06ComboDraft,context("Комбоның құрамында не бар?","kk"),grounded);
 assert.match(r.text,/Донер.*картоп фри/u);assert.doesNotMatch(r.text,/^Сізге тапсырыс/u);
});
test("candidate06 possessive compound identity keeps exact core composition and2500 price",()=>{
 const draft="Донер комбосының құрамында Донер және картоп фри бар. Оның бағасы 2500 KZT.";
 const r=validateFinalText(draft,context("Донер комбоның құрамы мен бағасы қандай?","kk"),grounded);
 assert.equal(r.text,draft);assert.ok(!r.warnings.includes("menu_price_mismatch_removed"));
});
test("candidate06 compound possessive cannot borrow constituent1990 price",()=>{
 const r=validateFinalText("Донер комбосының бағасы 1990 KZT.",context("Донер комбо қанша?","kk"),grounded);
 assert.doesNotMatch(r.text,/1990/u);assert.ok(r.warnings.includes("menu_price_mismatch_removed"));
});
test("candidate06 failed nested detail restores only direct verified core without ingredient hierarchy",()=>{
 const r=validateFinalText("Донер комбосының құрамында Донер (майонез, жұмыртқа) және картоп фри бар.",context("Комбоның құрамында не бар?","kk"),grounded);
 assert.match(r.text,/Донер.*картоп фри/u);assert.doesNotMatch(r.text,/майонез|жұмыртқа/u);
 assert.ok(r.warnings.includes("unsupported_ingredient_claim_removed"));
});
test("candidate06 requested different variant cannot authorize nested combo details",()=>{
 const c=context("Көкөніс роллының құрамы қандай?","kk");
 const r=validateFinalText("Көкөніс роллының құрамында тауық еті, лаваш және қызанақ бар.",c,grounded);
 assert.doesNotMatch(r.text,/тауық|лаваш|қызанақ/u);
});
test("candidate06 unavailable or stale catalog cannot salvage a combo composition",()=>{
 for(const marker of [{menu_lookup:"unavailable"},{stale:true},{is_stale:true}]){
  const c=context("Комбоның құрамында не бар?","kk");c.menuGrounding={...c.menuGrounding,...marker};
  const r=validateFinalText(candidate06ComboDraft,c,grounded);assert.doesNotMatch(r.text,/құрамында.*Донер.*картоп/u);
 }
});
test("candidate06 ambiguous anonymous combo cannot be rebuilt from a guessed catalog subject",()=>{
 const c=context("Комбоның құрамында не бар?","kk");
 c.menuSnapshot.items.push({name:"Суши комбо",price:3500,composition:"Суши, картоп",available:true});
 const r=validateFinalText("Комбоның құрамында тауық пен күріш бар.",c,grounded);
 assert.doesNotMatch(r.text,/тауық пен күріш|Суши комбоның|Донер комбосының/u);
});
function candidate06OrderContext(text:string,status:string,paymentStatus="unverified"){
 const c=context(text,"kk");const record={id:98,phone:c.phone,status,payment_status:paymentStatus,items:[{name:"Донер",quantity:1}],type:"pickup"};
 const lookup=customerOrderFromRecord(record,c.phone,"kk");assert.equal(lookup.state,"found");
 c.activeOrder=(lookup as any).order;return c;
}
function candidate06OrderGrounding(c:any){
 const o=c.activeOrder;
 return {toolsCalled:["checkOrderStatus"],toolFindings:{orderFound:true,orderLookup:"found",orderStatus:o.status,orderStage:o.stage,orderStatusLabel:o.statusLabel,orderItems:o.items,orderPaymentStatus:o.paymentStatus,orderFulfillmentType:o.fulfillmentType}};
}
test("candidate06 actual pending order cannot be asserted preparing in inflected Kazakh",()=>{
 const c=candidate06OrderContext("98 нөмірлі тапсырысым қайда?","pending");
 const draft="98 нөмірлі тапсырысыңыз қазір әзірленуде, бірақ төлем күтілуде. Тапсырысыңыз сайтта рәсімделген, бірақ оның дайындалуы үшін төлем чегі келеді. Қосымша сұрағыңыз болса, жазыңыз!";
 const r=validateFinalText(draft,c,candidate06OrderGrounding(c));assert.doesNotMatch(r.text,/қазір әзірленуде/u);
 assert.ok(r.warnings.includes("order_state_mismatch_removed"));assert.match(r.text,/төлем|растай алмай/u);
});
test("candidate06 actual accepted unverified order has no sent receipt authority",()=>{
 const c=candidate06OrderContext("Қазір оның күйі қандай?","accepted");
 const draft='98 нөмірлі тапсырысыңыз қабылданды және қазір чек күтілуде. Төлем чегі жіберілді, бірақ ол әлі расталмаған. Тапсырысыңыз "Донер" бар.';
 const r=validateFinalText(draft,c,candidate06OrderGrounding(c));assert.doesNotMatch(r.text,/чегі жіберілді/u);
 assert.match(r.text,/чек күтілуде|қабылданды/u);assert.ok(r.warnings.includes("unconfirmed_payment_receipt_removed"));
});
test("candidate06 actual payment question cannot turn unverified status into a sent receipt",()=>{
 const c=candidate06OrderContext("Төлеген сияқтымын. Жүйеде төлем расталды ма?","accepted");
 const r=validateFinalText('98 нөмірлі тапсырысыңыз қазір чек күтілуде. Төлем чегі жіберілді, бірақ ол әлі расталмаған. Сізде "Донер" бар.',c,candidate06OrderGrounding(c));
 assert.doesNotMatch(r.text,/чегі жіберілді/u);assert.match(r.text,/чек күтілуде|растай алмай/u);
});
test("candidate06 receipt review proof supports receipt claim but paid alone does not",()=>{
 const c=candidate06OrderContext("Чек келді ме?","accepted","receipt_uploaded");
 const draft="Төлем чегі жіберілді және тексеруді күтуде.";assert.equal(validateFinalText(draft,c,candidate06OrderGrounding(c)).text,draft);
 const paid=candidate06OrderContext("Чек келді ме?","paid","paid");
 assert.doesNotMatch(validateFinalText(draft,paid,candidate06OrderGrounding(paid)).text,/чегі жіберілді/u);
});
test("candidate06 grounded preparing ready paid and pickup continue to survive",()=>{
 for(const [status,payment,draft] of [["paid","paid","98 нөмірлі тапсырысыңыз қазір әзірленуде."],["ready","paid","98 нөмірлі тапсырысыңыз дайын."]] as const){
  const c=candidate06OrderContext("Тапсырыс дайын ба?",status,payment);assert.equal(validateFinalText(draft,c,candidate06OrderGrounding(c)).text,draft);
 }
 const c=candidate06OrderContext("Жеткізу ме, әлде өзім алып кетемін бе?","ready","paid");
 assert.match(validateFinalText("Жеткізу де, алып кету де бар.",c,candidate06OrderGrounding(c)).text,/өзіңіз алып кетесіз/u);
});
test("candidate06 receipt questions and honest denial do not become sent-claim assertions",()=>{
 const c=candidate06OrderContext("Чек келді ме?","accepted");
 for(const draft of ["Төлем чегі жіберілді ме?","Төлем чегі жіберілгенін растай алмаймын.","Чек ещё не получен."]){
  assert.equal(validateFinalText(draft,c,candidate06OrderGrounding(c)).text,draft);
 }
});
test("candidate06 unavailable order lookup cannot reuse an old receipt review stage",()=>{
 const c=candidate06OrderContext("Чек келді ме?","accepted","receipt_uploaded");
 const r=validateFinalText("Төлем чегі жіберілді.",c,{toolsCalled:["checkOrderStatus"],toolFindings:{orderFound:false,orderLookup:"unavailable"}});
 assert.doesNotMatch(r.text,/чегі жіберілді/u);
});
test("candidate06 Ukrainian prose needs repair while verified literal Ukrainian names remain literal",()=>{
 const c=context("Как к вам обращаться?");
 const wrong="Дякую за вашу готовність чекати! Напишіть, будь ласка, що ви хочете замовити.";
 assert.ok(validateFinalText(wrong,c).warnings.includes("reply_language_mismatch"));
 c.config.system_prompt="Service name: Дякую за вашу готовність.";
 const good="Вы можете называть меня «Дякую за вашу готовність».";
 const r=validateFinalText(good,c);assert.equal(r.text,good);assert.ok(!r.warnings.includes("reply_language_mismatch"));
 const kk=context("Қалай атасам болады?","kk");assert.ok(validateFinalText(wrong,kk).warnings.includes("reply_language_mismatch"));
});

test("stopped06 direct composition cannot certify a failed or stale catalog",()=>{
 const draft="Донер комбосының құрамында Донер және картоп фри бар.";
 for(const mark of [{menu_lookup:"unavailable"},{stale:true},{is_stale:true}]){
  const c=context("Комбоның құрамында не бар?","kk");c.menuGrounding={...c.menuGrounding,...mark};
  const r=validateFinalText(draft,c,grounded);assert.doesNotMatch(r.text,/құрамында.*Донер.*картоп/u);
  assert.ok(r.warnings.includes("unsupported_ingredient_claim_removed"));
 }
});
test("stopped06 independent sent-receipt conjunction cannot borrow an honest receipt denial",()=>{
 const c=candidate06OrderContext("Чек келді ме?","accepted");
 const r=validateFinalText("Чек ещё не получен и платёжный чек уже отправлен.",c,candidate06OrderGrounding(c));
 assert.doesNotMatch(r.text,/чек уже отправлен/u);assert.match(r.text,/не получен/u);
 assert.ok(r.warnings.includes("unconfirmed_payment_receipt_removed"));
 for(const draft of ["Чек ещё не получен.","Не могу подтвердить, что чек уже отправлен.","Төлем чегінің жіберілгенін растай алмаймын."]){
  assert.equal(validateFinalText(draft,c,candidate06OrderGrounding(c)).text,draft);
 }
});

test("stopped06 verified current snapshot composition does not require optional menuGrounding projection",async()=>{
 const c=context("Что в составе Донера?","ru");c.menuGrounding=undefined;
 const menu={...c.menuSnapshot};let reads=0;
 await createSearchMenuSkill(c,async()=>{reads+=1;return menu;}).execute!({query:"Донер"},{} as any);
 assert.equal(reads,1);assert.equal(c.menuGrounding,undefined);
 const raw="Донер — состав: Курица, лаваш, томат.";
 const result=validateFinalText(raw,c,grounded);
 assert.equal(result.text,raw);assert.ok(!result.warnings.includes("unsupported_ingredient_claim_removed"));
});

const directcore07History=[
 {role:"user",text:"Есть напиток 0,5 л?"},
 {role:"assistant",text:"Донер и комбо."},
 {role:"user",text:"Он продаётся отдельно или только в составе комбо?"},
 {role:"user",text:"Какие отдельные напитки есть именно в меню?"},
 {role:"user",text:"Сколько стоит отдельный напиток 0,5 л?"}
];
const directcore07Attribute="Не придумывайте замену: подтвердите объём по меню";
const directcore07Negative="К сожалению, в нашем меню на данный момент нет напитков объемом 0,5 литра.";
test("directcore07 actual scoped absent-product attribute retains verified negative instead of asking again",()=>{
 const c=context(directcore07Attribute,"ru",directcore07History);
 const r=validateFinalText(directcore07Negative,c,grounded);
 assert.match(r.text,/нет напитков.*0,5/u);assert.doesNotMatch(r.text,/уточните.*какого товара/iu);
 assert.ok(!r.warnings.includes("menu_relation_reference_clarification"));
});
test("directcore07 customer description is no authority for failed or stale catalog absence",()=>{
 for(const marker of [{menu_lookup:"unavailable"},{stale:true}]){
  const c=context(directcore07Attribute,"ru",directcore07History);c.menuGrounding={...c.menuGrounding,...marker};
  const r=validateFinalText(directcore07Negative,c,grounded);assert.doesNotMatch(r.text,/нет напитков.*0,5/u);
 }
});
test("directcore07 current catalog volume defeats a false absent-volume draft",()=>{
 const c=context(directcore07Attribute,"ru",directcore07History);
 c.menuSnapshot.items=[...c.menuSnapshot.items,{name:"Кола 0,5 л",price:800,composition:"Вода, сахар",available:true}];
 assert.doesNotMatch(validateFinalText(directcore07Negative,c,grounded).text,/нет напитков.*0,5/u);
});
test("directcore07 customer attribute reference rejects assistant quoted foreign stale ambiguous and new-topic authority",()=>{
 for(const rows of [
  [{role:"assistant",text:"Есть напиток 0,5 л?"}],
  [{role:"user",text:'Он написал «Есть напиток 0,5 л?»'}],
  [{role:"user",text:"Есть напиток 0,5 л?",instanceId:"other"}],
  [{role:"user",text:"Есть напиток 0,5 л?",phone:"77000000001"}],
  [{role:"user",text:"Есть напиток 0,5 л?",createdAt:Date.now()-1800001}],
  [{role:"user",text:"Есть напиток 0,5 л или бутылка 1 л?"}],
  [...directcore07History,{role:"user",text:"А где мой заказ?"}]
 ]){
  const c=context(directcore07Attribute,"ru",rows);
  assert.ok(validateFinalText(directcore07Negative,c,grounded).warnings.includes("menu_relation_reference_clarification"));
 }
});
test("directcore07 unrelated product draft cannot replace an absent customer attribute",()=>{
 const c=context(directcore07Attribute,"ru",directcore07History);
 const r=validateFinalText("Донер — 1990 тг. Комбо с донером — 2500 тг.",c,grounded);
 assert.doesNotMatch(r.text,/Донер|Комбо|1990|2500/u);assert.match(r.text,/объ[её]м|подтверд/iu);
});
test("directcore07 actual unverified receipt removal retains a complete truthful payment subject",()=>{
 const c=candidate06OrderContext("Төлеген сияқтымын. Жүйеде төлем расталды ма?","accepted");
 const raw="98 нөмірлі тапсырысыңыздың статусы - чек күтудеміз. Төлем чегі жіберілді, бірақ әлі расталмады. Тапсырыс ішінде 1 Донер бар.";
 const r=validateFinalText(raw,c,candidate06OrderGrounding(c));
 assert.doesNotMatch(r.text,/чегі жіберілді|[.!?]\s*әлі расталмады/u);
 assert.match(r.text,/Төлем әлі расталмады/u);assert.match(r.text,/98.*чек күтудеміз/u);
 assert.ok(r.warnings.includes("unconfirmed_payment_receipt_removed"));
});
test("directcore07 paid order does not become unconfirmed payment after unsupported receipt removal",()=>{
 const c=candidate06OrderContext("Чек келді ме?","paid","paid");
 const r=validateFinalText("Төлем чегі жіберілді, бірақ әлі расталмады.",c,candidate06OrderGrounding(c));
 assert.doesNotMatch(r.text,/чегі жіберілді|Төлем әлі расталмады/u);assert.match(r.text,/растай алмай/u);
});

test("directcore07 verified combo component volume cannot become global catalog absence or standalone availability",()=>{
 const c=context(directcore07Attribute,"ru",directcore07History);
 c.menuSnapshot.items=c.menuSnapshot.items.map((item:any)=>item.id==="combo"?{...item,composition:"Донер, картофель фри, напиток 0,5 л"}:{...item});
 c.menuGrounding={...c.menuGrounding,items:c.menuSnapshot.items};
 const r=validateFinalText("В меню нет напитков 0,5 л.",c,grounded);
 assert.doesNotMatch(r.text,/нет напитков.*0,5/u);
 assert.doesNotMatch(r.text,/можно.*(?:отдельно|комбо)|прода[её]тся/u);
 assert.match(r.text,/объ[её]м|подтверд/iu);
});
test("directcore07 valid absence cannot authorize an independent unsupported standalone-volume claim",()=>{
 const c=context(directcore07Attribute,"ru",directcore07History);
 const r=validateFinalText("В меню нет напитков 0,5 л. Напиток 0,5 л можно взять отдельно.",c,grounded);
 assert.doesNotMatch(r.text,/можно взять отдельно/u);
 assert.match(r.text,/нет напитков.*0,5|подтверд/iu);
});

const DIRECT_CORE08_ACTUAL_RAW="As the user is asking \"What food is available now?\", I should use the `searchMenu` tool to find out what dishes are currently available. The previous turn already shows that `searchMenu` was executed and returned a list of available dishes. Therefore, I should use the information from the `searchMenu` result provided in the `FACTS_CONTEXT`.\n\nThe `searchMenu` result contains the following available dishes:\n- Донер (Тауық еті, лаваш, қызанақ) - 1990 KZT\n- Көкөніс роллы (Күріш, қияр, сәбіз) - 2000 KZT\n- Донер комбо (Донер, картоп фри) - 2500 KZT\n- Суши сет (Күріш, балық) - 3200 KZT\n\nI need to present this information to the user in Kazakh, as per the `FACTS_CONTEXT.language`. I should list the dishes with their names and prices. I should also adhere to the `reply_shape` constraints: at most 2 short sentences, one short message, casual register, and sparing emoji.\n\nLet's construct the response.\nThe user asked \"Қазір қандай тағам бар?\" which translates to \"What food is available now?\".\nThe `searchMenu` result shows the following:\n- Донер, price 1990\n- Көкөніс роллы, price 2000\n- Донер комбо, price 2500\n- Суши сет, price 3200\n\nI can present these in two sentences.\n\nSentence 1: List some of the items.\n\"Қазір бізде донер (1990 тг), көкөніс роллы (2000 тг) және донер комбо (2500 тг) бар.\"\n(Now we have doner (1990 KZT), vegetable rolls (2000 KZT), and doner combo (2500 KZT).)\n\nSentence 2: Mention the remaining item.\n\"Сонымен қатар, суши сетті (3200 тг) де ұсынамыз.\"\n(Additionally, we also offer sushi set (3200 KZT).)\n\nThis fits the \"at most 2 short sentences\" and \"one short message\" constraint. The register is casual and respectful. No emoji is needed for this factual response.Қазір бізде донер (1990 тг), көкөніс роллы (2000 тг) және донер комбо (2500 тг) бар. Сонымен қатар, суши сетті (3200 тг) де ұсынамыз.";

test("directcore08 actual unlabelled planning keeps the final grounded Kazakh answer beyond quoted drafts",()=>{
 const c=context("Қазір қандай тағам бар?","kk");
 const r=validateFinalText(DIRECT_CORE08_ACTUAL_RAW,c,grounded);
 assert.doesNotMatch(r.text,/I should|I need|The user|previous turn|searchMenu|reply_shape|FACTS_CONTEXT|construct the response|Sentence 1|Sentence 2/iu);
 assert.match(r.text,/Қазір|Қазіргі/u);assert.match(r.text,/донер|Донер/u);
 assert.match(r.text,/1990/u);assert.match(r.text,/2000/u);assert.match(r.text,/2500/u);
 // Available-food answer is nonexclusive; preserve existing conservative inflected-SKU price guard.
 assert.ok(r.warnings.includes("reasoning_preamble_removed"));
});
test("directcore08 response planning variants and Cyrillic customer quotes do not become an answer boundary",()=>{
 const c=context("Қазір қандай тағам бар?","kk");
 for(const prefix of [
  'The customer asked "Қазір қандай тағам бар?". I must present the searchMenu data. Draft: "Донер — 2500 тг." I need to follow reply_shape. ',
  'Analysis: I should call searchMenu. The customer wrote "Қазір қандай тағам бар?". Draft: "Донер — 2500 тг." I will compose the final response. '
 ]){
  const r=validateFinalText(prefix+"Қазір Донер — 1990 тг.",c,grounded);
  assert.doesNotMatch(r.text,/customer|searchMenu|reply_shape|Draft|Analysis|compose|2500/iu);
  assert.match(r.text,/Донер.*1990/u);
 }
});
test("directcore08 planning without complete guest tail uses only independently available current catalog",()=>{
 const c=context("Қазір қандай тағам бар?","kk");
 const r=validateFinalText('The customer asks what is available. I should use searchMenu and follow reply_shape. Draft: "Ойдан тағам — 9999 тг."',c,grounded);
 assert.doesNotMatch(r.text,/customer|searchMenu|reply_shape|Draft|Ойдан|9999/iu);
 assert.match(r.text,/Донер/u);assert.match(r.text,/Көкөніс роллы/u);
});
test("directcore08 no-current-catalog planning yields Cyrillic uncertainty without invented facts or effects",()=>{
 const c=context("Қазір қандай тағам бар?","kk");c.menuSnapshot={source:"menu_unavailable",items:[]};c.menuGrounding={menu_lookup:"unavailable",items:[]};
 const r=validateFinalText('The user asks for food. I should use searchMenu. I need to follow reply_shape.',c,grounded);
 assert.doesNotMatch(r.text,/The user|I should|searchMenu|reply_shape|Донер|1990|жібер|https:/iu);
 assert.match(r.text,/растай алмай/u);
});
test("directcore08 extracted guest tail still rejects unsupported price and ingredient facts",()=>{
 const prefix="The customer wants a reply. I should present searchMenu facts. I need to follow reply_shape.";
 const c=context("Донердің бағасы мен құрамы қандай?","kk");
 const r=validateFinalText(prefix+"Донер — 2500 тг. Донердің құрамында күріш пен балық бар.",c,grounded);
 assert.doesNotMatch(r.text,/2500|күріш пен балық/u);
 assert.ok(r.warnings.includes("menu_price_mismatch_removed"));assert.ok(r.warnings.includes("unsupported_ingredient_claim_removed"));
});
test("directcore08 extracted guest tail cannot grant a link or prove a sent payment receipt",()=>{
 const prefix="The customer asked about the order. I should use checkOrderStatus results. I need to construct the response.";
 const c=candidate06OrderContext("Төлем расталды ма?","accepted");c.magicLink="https://example.test/order";c.magicLinkGranted=false;c.explicitMenuLinkIntent=false;
 const r=validateFinalText(prefix+"Төлем чегі жіберілді. "+c.magicLink,c,candidate06OrderGrounding(c));
 assert.doesNotMatch(r.text,/чегі жіберілді|https:\/\/example/u);
 assert.ok(r.warnings.includes("unconfirmed_payment_receipt_removed"));
});
test("directcore08 legitimate quoted prose and known English SKU remain customer content",()=>{
 const c=context("Қазір қандай тағам бар?","kk");
 const quoted='Қонақ «I should list the dishes» деп жазды. Қазір Донер — 1990 тг.';
 assert.equal(validateFinalText(quoted,c,grounded).text,quoted);
 const named=context("Қазір қандай тағам бар?","kk");named.menuSnapshot.items=[...named.menuSnapshot.items,{name:"Green Bowl",price:2000,composition:"Күріш, қияр",available:true}];named.menuGrounding={...named.menuGrounding,items:named.menuSnapshot.items};
 const raw="Қазір Green Bowl — 2000 тг.";
 assert.equal(validateFinalText(raw,named,grounded).text,raw);
});
