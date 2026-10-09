import fs from "node:fs";
import vm from "node:vm";
import ts from "typescript";
import * as actualOrderIntent from "../src/utils/orderIntent.js";
import test from "node:test";
import assert from "node:assert/strict";
import { lastDiscussedOrderNumber } from "../src/utils/orderIntent.js";
import { customerOrderFromRecord, formatCustomerOrderStatus, orderMentionedByItems, pickConversationOrder } from "../src/services/customerOrder.service.js";

const context = {
  order: { id: "58", status: "pending", created_at: "2026-07-31 07:34:47" },
  active_order: { id: "58", status: "pending", created_at: "2026-07-31 07:34:47" },
  recent_orders: [
    { id: "59", status: "completed", created_at: "2026-07-31 07:35:18" },
    { id: "58", status: "pending", created_at: "2026-07-31 07:34:47" },
  ],
};

test("the conversation remembers which order it has been about", () => {
  const history = [
    { role: "user", text: "че там брат" },
    { role: "assistant", text: "Тапсырыс #59: Жолда — тапсырыс курьерде." },
    { role: "user", text: "қашан келеді" },
  ];
  assert.equal(lastDiscussedOrderNumber(history), "59");
});

test("a bare follow-up answers about the discussed order, not an older pending one", () => {
  // The site called #58 the active order, but every message in this chat was
  // about #59, so answering with #58 made the bot look like it had amnesia.
  const picked = pickConversationOrder(context, "59");
  assert.equal(picked?.id, "59");
});

test("an order the site has never heard of never overrides the active one", () => {
  assert.equal(pickConversationOrder(context, "1234"), null);
});

test("a genuinely newer order the guest has not mentioned yet still wins", () => {
  const newer = {
    order: { id: "60", status: "pending", created_at: "2026-07-31 09:00:00" },
    recent_orders: [
      { id: "60", status: "pending", created_at: "2026-07-31 09:00:00" },
      { id: "59", status: "completed", created_at: "2026-07-31 07:35:18" },
    ],
  };
  assert.equal(pickConversationOrder(newer, "59"), null);
});

test("an empty or missing history pins nothing", () => {
  assert.equal(lastDiscussedOrderNumber(null), "");
  assert.equal(lastDiscussedOrderNumber([{ role: "user", text: "тапсырыс #59 қайда" }]), "");
});


test("a guest who names a dish points at the order that contains it", () => {
  const context = {
    order: { id: "58", status: "pending", created_at: "2026-07-31 07:34:47", items: [{ name: "Гункан-маки", qty: 1 }] },
    recent_orders: [
      { id: "59", status: "completed", created_at: "2026-07-31 07:35:18", items: [{ name: "Цезарь", qty: 1 }, { name: "Кальцоне", qty: 1 }] },
      { id: "58", status: "pending", created_at: "2026-07-31 07:34:47", items: [{ name: "Гункан-маки", qty: 1 }] },
    ],
  };
  const hit: any = orderMentionedByItems(context, "баяғы цезарь бар заказ қайтты болды");
  assert.equal(hit?.id, "59");
});

test("a dish nobody ordered pins nothing", () => {
  const context = { recent_orders: [{ id: "59", items: [{ name: "Цезарь", qty: 1 }] }] };
  assert.equal(orderMentionedByItems(context, "сәлем қалыңыз қалай"), null);
});

test("an empty message never pins an order", () => {
  const context = { recent_orders: [{ id: "59", items: [{ name: "Цезарь", qty: 1 }] }] };
  assert.equal(orderMentionedByItems(context, ""), null);
});

function currentOrderNumberPrompt(role="assistant",text="Тапсырысыңыздың номерін жібере аласыз ба?",createdAt=Date.now()){
 return {role,text,createdAt};
}
test("bare80 answers the immediately preceding order-number request including current user in history",()=>{
 for(const history of [[currentOrderNumberPrompt()],[currentOrderNumberPrompt("model","Пришлите, пожалуйста, номер заказа."),{role:"user",text:"80",createdAt:Date.now()}]]){
  assert.equal(actualOrderIntent.requestedOrderNumber("80",history),"80");
 }
 assert.equal(actualOrderIntent.requestedOrderNumber("Заказ #80"),"80");
});
test("bare wait budget or arbitrary number is not an order identifier without a pending request",()=>{
 for(const value of ["60","2000","80"]){
  assert.equal(actualOrderIntent.requestedOrderNumber(value),"");
  assert.equal(actualOrderIntent.isLikelyOrderStatusFollowUp(value),false);
 }
});
test("old quoted user or nonimmediate prompt does not authorize a bare order number",()=>{
 for(const history of [[currentOrderNumberPrompt("user")],[currentOrderNumberPrompt("assistant","Клиент написал «Пришлите номер заказа»")],
   [currentOrderNumberPrompt("assistant",undefined,Date.now()-1800001)],[currentOrderNumberPrompt(),{role:"user",text:"Я пока подумаю"}],
   [currentOrderNumberPrompt(),currentOrderNumberPrompt("assistant","Сколько минут вы готовы ждать?")]]){
  assert.equal(actualOrderIntent.requestedOrderNumber("80",history),"",JSON.stringify(history));
 }
});
function actualCustomerOrderReplyHarness(){
 const route=fs.readFileSync(new URL("../src/routes/whatsappWebhook.route.ts",import.meta.url),"utf8");
 const parsed=ts.createSourceFile("route.ts",route,ts.ScriptTarget.Latest,true);
 const fn=parsed.statements.find(node=>ts.isFunctionDeclaration(node)&&node.name?.text==="customerOrderReply");
 assert.ok(fn);const calls:string[]=[];const exports:any={};
 const code=ts.transpileModule(fn.getText(parsed)+"\nexports.reply=customerOrderReply;",{compilerOptions:{module:ts.ModuleKind.CommonJS,target:ts.ScriptTarget.ES2022}}).outputText;
 vm.runInNewContext(code,{exports,...actualOrderIntent,isLikelyComplaintText:()=>false,isLikelyOperatorRequestText:()=>false,
  getCustomerOrder:async(_instance:string,_domain:string,phone:string,language:"ru"|"kk",number:string)=>{
   calls.push(number);return customerOrderFromRecord({id:number,status:"pending",phone},phone,language);
  },customerOrderFromRecord,pickConversationOrder,formatCustomerOrderStatus,ctxKitchenWaitMinutes:()=>0,
  unavailableOrderReply:()=>"Unavailable",missingQuotedOrderReply:(_language:string,number:string)=>"Missing "+number,missingOrderReply:()=>"Missing"});
 return {calls,reply:(text:string,history:any[]=[])=>exports.reply({instanceId:"number-fixture",phone:"77000000000",language:"kk",text,chatHistory:history,config:{},activeOrder:{id:"100",status:"pending",phone:"77000000000"}})};
}
test("actual order-status route looks up requested80 rather than substituting latest100",async()=>{
 const h=actualCustomerOrderReplyHarness();
 const reply=await h.reply("80",[currentOrderNumberPrompt(),{role:"user",text:"80",createdAt:Date.now()}]);
 assert.deepEqual(h.calls,["80"]);assert.match(reply,/80/u);assert.doesNotMatch(reply,/100/u);
});
test("actual order-status route leaves unprompted numeric wait and budget to their own intent",async()=>{
 const h=actualCustomerOrderReplyHarness();for(const value of ["60","2000","80"])assert.equal(await h.reply(value),null,value);
 assert.deepEqual(h.calls,[]);
});
