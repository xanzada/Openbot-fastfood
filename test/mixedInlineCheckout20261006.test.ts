import test from "node:test";
import assert from "node:assert/strict";
import { resolveAgentToolPlan } from "../src/agent/toolPolicy.js";
const ctx=(text:string)=>({text,instanceId:"audit-mixed-inline",phone:"77000000001",language:"kk",config:{},runtimeStatus:{is_accepting_orders:true,within_work_hours:true},hardRealtimeContext:{runtime_available:true},activeOrder:null,activeShiftNotes:[],menuSnapshot:{items:[{name:"Донер куриный",price:1800}]},explicitMenuLinkIntent:false,chatHistory:[]} as any);
test("an independent explicit link or order survives a simultaneous inline-menu request",()=>{
 for(const text of ["Мәзірді осында жазып жіберіңіз. Сілтемені жіберіңіз.","Меню напишите здесь, и пришлите ссылку.","Напишите меню здесь и скиньте ссылку.","Мәзірді жазып беріңіз, екі донер алайын.","Мәзірді мәтін түрінде жіберіңіз. Сілтемені жіберіңіз.","Мәзірді мәтін түрінде жазып беріңіз, екі донер алайын."]){
  const plan=resolveAgentToolPlan(ctx(text));assert.ok(plan.requiredTools.includes("sendMenuLink"),text);assert.equal(plan.requiredTools[0],"searchMenu",text);
 }
});
test("a pure written-menu request requires facts and does not authorize checkout",()=>{
 for(const text of ["Мәзірді осында жазып жіберіңіз.","Мәзірді чатта мәтінмен жіберіңіз.","Напишите меню здесь и отправьте.","Покажите меню текстом.","Пришлите меню списком.","Мәзірді мәтін түрінде жіберіңіз.","Мәзірді тізіммен жіберіңіз."]){
  const plan=resolveAgentToolPlan(ctx(text));assert.ok(plan.requiredTools.includes("searchMenu"),text);assert.ok(!plan.requiredTools.includes("sendMenuLink"),text);
 }
});
test("an ordinary request to send menu retains checkout permission",()=>{
 assert.ok(resolveAgentToolPlan(ctx("Мәзірді осында жіберіңіз.")).requiredTools.includes("sendMenuLink"));
});
