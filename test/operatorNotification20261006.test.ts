import assert from "node:assert/strict";
import test from "node:test";
import {queueOperatorCaseNotifications, drainOperatorNotifications, operatorNotificationKey, shouldPlanOperatorNotification, buildOperatorNotificationText} from "../src/services/operatorNotification.service.js";
import {guardedAdminRecipient} from "../src/services/durableNotification.service.js";
import type {NotificationStore, NotificationRecord} from "../src/services/durableNotification.service.js";
class Store implements NotificationStore {
 records=new Map<string,NotificationRecord>(); locks=new Set<string>(); indexes=new Map<string,Map<string,number>>();
 async get(key:string){return this.records.has(key)?structuredClone(this.records.get(key)!):null;}
 async save(key:string,index:string,row:NotificationRecord){this.records.set(key,structuredClone(row));const items=this.indexes.get(index)||new Map();this.indexes.set(index,items);if(row.status==="delivered")items.delete(key);else items.set(key,row.next_attempt_at);}
 async claim(key:string,_token:string){if(this.locks.has(key))return false;this.locks.add(key);return true;}
 async release(key:string,_token:string){this.locks.delete(key);}
 async due(index:string,now:number){return [...(this.indexes.get(index)||new Map()).entries()].filter(([,at])=>at<=now).map(([key])=>key);}
}
const input={instanceId:"fixture",phone:"70000000002",caseId:"case_fixture",signalId:"signal_fixture",kind:"complaint",summary:"Холодная еда",source:"ai_tool_escalate_to_admin"};
function harness(options:{admin?:string;failures?:number;hubFailures?:number;store?:Store}={}){
 const store=options.store||new Store();const sent:any[]=[];const hub:any[]=[];const legacy=new Set<string>();let failures=options.failures||0;let hubFailures=options.hubFailures||0;
 const deps:any={store,loadConfig:async(instance_id:string)=>({instance_id,admin_phone:options.admin??"+70000000001"}),
  send:async(payload:any)=>{sent.push(payload);if(failures-->0){const e:any=new Error("private credential");e.response={status:503};throw e;}return {acknowledged:true};},
  sendHub:async(payload:any)=>{hub.push(payload);if(hubFailures-->0){const e:any=new Error("private");e.response={status:503};throw e;}return {ok:true};},
  legacyHubSent:async(p:any)=>legacy.has(p.caseId),markLegacyHubSent:async(p:any)=>{legacy.add(p.caseId);},log:()=>{}};
 return {store,sent,hub,deps,queue:(p=input,now=1000)=>queueOperatorCaseNotifications(p,now,store),run:(now=1000)=>drainOperatorNotifications([{instance_id:"fixture"}],now,deps)};
}
test("transient model failure never plans operator notification",async()=>{const h=harness();await h.queue({...input,kind:"unresolved",source:"ai_unavailable"});assert.equal(h.store.records.size,0);await h.run();assert.equal(h.sent.length,0);});
test("true complaint plans both channels before any network",async()=>{const h=harness();await h.queue();assert.equal(h.store.records.size,2);assert.equal(h.sent.length,0);assert.equal(h.hub.length,0);});
test("explicit operator case plans admin delivery",async()=>{const h=harness();await h.queue({...input,kind:"human_request",summary:"Нужен человек"});await h.run();assert.equal(h.sent.length,1);assert.match(h.sent[0].text,/Нужен оператор/);});
test("money dispute plans a real durable case notification",async()=>{const h=harness();await h.queue({...input,summary:"Оплатил, заказ не подтвержден",source:"payment_shortfall",kind:"critical"});await h.run();assert.equal(h.sent.length,1);assert.equal(h.hub.length,1);});
test("unreadable receipt plans operator notification instead of discarding evidence",async()=>{const h=harness();await h.queue({...input,source:"media_unreadable_evidence",summary:"Чек требует проверки"});await h.run();assert.equal((await h.store.get(operatorNotificationKey("fixture","case_fixture","admin")))?.status,"delivered");});
test("admin delivery requires actual gateway acceptance",async()=>{const h=harness();await h.queue();await h.run();const row=await h.store.get(operatorNotificationKey("fixture","case_fixture","admin"));assert.equal(row?.attempts,1);assert.ok(row?.delivered_at);assert.equal(h.sent[0].phone,"70000000001");assert.notEqual(h.sent[0].phone,input.phone);});
test("503 retries once with stable request ID and one success",async()=>{const h=harness({failures:1});await h.queue();await h.run(1000);const pending=await h.store.get(operatorNotificationKey("fixture","case_fixture","admin"));assert.equal(pending?.status,"pending");assert.equal(pending?.last_error,"HTTP_503");await h.run(3000);await h.run(10000);assert.equal(h.sent.length,2);assert.equal(h.sent[0].requestId,h.sent[1].requestId);assert.equal((await h.store.get(operatorNotificationKey("fixture","case_fixture","admin")))?.status,"delivered");});
test("duplicate webhook creates one active notification and one accepted send",async()=>{const h=harness();await h.queue();await h.queue({...input,signalId:"new_signal"},1001);await h.run(1001);await h.queue({...input,signalId:"third_signal"},1002);await h.run(1002);assert.equal(h.sent.length,1);assert.equal(h.hub.length,1);assert.equal(h.hub[0].signalId,input.signalId);});
test("raw normalized client equals admin blocks WA transport",async()=>{const h=harness({admin:"+7 (000) 000-00-02"});await h.queue();await h.run();assert.equal(h.sent.length,0);assert.equal((await h.store.get(operatorNotificationKey("fixture","case_fixture","admin")))?.last_error,"ADMIN_RECIPIENT_COLLISION");});
test("masked phones are never accepted as recipients",async()=>{const h=harness({admin:"7000***002"});await h.queue();await h.run();assert.equal(h.sent.length,0);assert.equal((await h.store.get(operatorNotificationKey("fixture","case_fixture","admin")))?.last_error,"ADMIN_RECIPIENT_MISSING");});
test("outbox survives restart between creation and send",async()=>{const h=harness();await h.queue();const restarted=harness({store:h.store});await restarted.run();assert.equal(restarted.sent.length,1);await restarted.run(9000);assert.equal(restarted.sent.length,1);});
test("Hub 503 retries without a new client signal and keeps signal ID",async()=>{const h=harness({hubFailures:1});await h.queue();await h.run(1000);await h.run(3000);assert.equal(h.hub.length,2);assert.equal(h.hub[0].signalId,h.hub[1].signalId);assert.equal(h.sent.length,1);});
test("missing admin does not swallow the durable failure",async()=>{const h=harness({admin:""});await h.queue();await h.run();const row=await h.store.get(operatorNotificationKey("fixture","case_fixture","admin"));assert.equal(row?.status,"pending");assert.equal(row?.last_error,"ADMIN_RECIPIENT_MISSING");assert.equal(h.hub.length,1);});
test("explicit configured admin may use its own WhatsApp account and developer never supplies a missing recipient",()=>{
 assert.equal(guardedAdminRecipient({admin_phone:"+70000000001",whatsapp_phone:"70000000001"},["70000000002"]),"70000000001");
 assert.throws(()=>guardedAdminRecipient({dev_phone:"70000000001",developer_phone:"70000000001"}),/ADMIN_RECIPIENT_MISSING/);
 assert.throws(()=>guardedAdminRecipient({admin_phone:"+70000000001",whatsapp_phone:"70000000001"},["70000000001"]),/ADMIN_RECIPIENT_COLLISION/);
});
test("operator digest masks client and credential fields",()=>{const text=buildOperatorNotificationText({...input,summary:"Bearer credential-value secret=credential-value +70000000002 https://host.test/?token=value"});assert.doesNotMatch(text,/credential-value|70000000002|https:/);assert.match(text,/\*\*\*02/);});
test("queued or skipped gateway result remains pending",async()=>{for(const response of [{skipped:true},{ok:true},{acknowledged:true,queued:true}]){const h=harness();h.deps.send=async()=>response;await h.queue();await h.run();assert.equal((await h.store.get(operatorNotificationKey("fixture","case_fixture","admin")))?.status,"pending");}});
test("two concurrent drains send only once",async()=>{const h=harness();await h.queue();await Promise.all([h.run(),h.run()]);assert.equal(h.sent.length,1);assert.equal(h.hub.length,1);});
test("retry revalidates recipient and blocks a changed destination",async()=>{const h=harness({failures:1});await h.queue();await h.run(1000);h.deps.loadConfig=async()=>({instance_id:"fixture",admin_phone:"+70000000003"});await h.run(3000);assert.equal(h.sent.length,1);assert.equal((await h.store.get(operatorNotificationKey("fixture","case_fixture","admin")))?.last_error,"ADMIN_RECIPIENT_CHANGED");});

