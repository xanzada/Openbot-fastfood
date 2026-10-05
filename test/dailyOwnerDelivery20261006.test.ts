import assert from "node:assert/strict";
import test from "node:test";
import {processDailyOwnerReports, dailyReportKey, ownerReportDates, buildDailyOwnerText, localReportWindow} from "../src/services/dailyReportDelivery.service.js";
import type {DailyAnalyticsInputs} from "../src/services/dailyAnalytics.service.js";
import type {NotificationStore, NotificationRecord} from "../src/services/durableNotification.service.js";
class Store implements NotificationStore {
 records = new Map<string, NotificationRecord>(); locks = new Set<string>(); indexes = new Map<string, Map<string, number>>();
 async get(key:string) { const row=this.records.get(key); return row ? structuredClone(row) : null; }
 async save(key:string,index:string,row:NotificationRecord) {
  this.records.set(key,structuredClone(row)); const items=this.indexes.get(index)||new Map(); this.indexes.set(index,items);
  if(row.status==="delivered")items.delete(key);else items.set(key,row.next_attempt_at);
 }
 async claim(key:string,_token:string) {if(this.locks.has(key))return false;this.locks.add(key);return true;}
 async release(key:string,_token:string) {this.locks.delete(key);}
 async due(index:string,now:number) {return [...(this.indexes.get(index)||new Map()).entries()].filter(([,at])=>at<=now).map(([key])=>key);}
}
function harness(options:{config?:any;metrics?:any;leads?:any[];failures?:number;store?:Store}={}) {
 const store=options.store||new Store();
 const config={instance_id:"fixture",timezone:"Asia/Almaty",admin_phone:"+70000000001",alemi_secret:"test-only",...options.config};
 const sends:any[]=[]; const hub:any[]=[]; let failures=options.failures||0;
 const facts:DailyAnalyticsInputs={instanceId:config.instance_id,reportDate:"",brand:"Fixture restaurant",leads:options.leads||[],
  metrics:options.metrics||{},learningNotes:["Bearer forbidden-secret +70000000099"]};
 const deps:any={store,loadConfig:async(id:string)=>({...config,instance_id:id}),
  readFacts:async(_c:any,date:string)=>({...facts,reportDate:date}),
  saveHub:async(_c:any,f:any)=>{hub.push(f.reportDate);},
  send:async(payload:any)=>{sends.push(payload);if(failures-->0){const err:any=new Error("private error body");err.response={status:503};throw err;}return {acknowledged:true,ok:true};},
  log:()=>{}
 };
 return {store,config,sends,hub,deps,run:(at:string)=>processDailyOwnerReports([config],new Date(at),deps)};
}
async function alreadyDelivered(h:ReturnType<typeof harness>,date:string) {
 await h.store.save(dailyReportKey(h.config.instance_id,date),`daily_report_pending:${h.config.instance_id}`,
 {instance_id:h.config.instance_id,status:"delivered",prepared_at:"fixture",delivered_at:"fixture",attempts:1,next_attempt_at:0,recipient:"70000000001",text:"fixture",payload:{report_date:date}});
}
test("23:58 never prepares today's report",async()=>{const h=harness();await h.run("2026-10-06T18:58:00Z");assert.equal(h.sends.some(x=>x.text.includes("2026-10-06")),false);});
test("23:59 delivers today's deterministic report",async()=>{const h=harness();await h.run("2026-10-06T18:59:00Z");assert.equal(h.sends.filter(x=>x.text.includes("2026-10-06")).length,1);assert.equal((await h.store.get(dailyReportKey("fixture","2026-10-06")))?.status,"delivered");});
test("schedule uses local timezone instead of UTC midnight",()=>{assert.deepEqual(ownerReportDates({timezone:"Asia/Almaty"},new Date("2026-10-06T18:59:00Z")),["2026-10-06","2026-10-05"]);assert.deepEqual(ownerReportDates({timezone:"UTC"},new Date("2026-10-06T18:59:00Z")),["2026-10-05"]);});
test("two tenants are scheduled at their own 23:59",async()=>{
 const h=harness(); const configs=[h.config,{...h.config,instance_id:"utc",timezone:"UTC"}];
 h.deps.loadConfig=async(id:string)=>configs.find(config=>config.instance_id===id);
 await processDailyOwnerReports(configs,new Date("2026-10-06T18:59:00Z"),h.deps);
 assert.equal(h.sends.some(x=>x.instanceId==="fixture"&&x.text.includes("2026-10-06")),true);
 assert.equal(h.sends.some(x=>x.instanceId==="utc"&&x.text.includes("2026-10-06")),false);
});
test("no complaints still sends explicit zero block",async()=>{const h=harness({metrics:{complaints:0}});await h.run("2026-10-06T18:59:00Z");assert.match(h.sends[0].text,/Жалобы: 0/);assert.match(h.sends[0].text,/не зарегистрированы/);});
test("complaints produce separate safe block without customer notes",async()=>{const h=harness({metrics:{complaints:2},leads:[{phone:"+70000000099",sales_stage:"NEW",interest:"secret",psycho_analysis:"secret+70000000099"}]});await h.run("2026-10-06T18:59:00Z");assert.match(h.sends[0].text,/Жалобы: 2/);assert.doesNotMatch(h.sends[0].text,/secret|Bearer|70000000099/);});
test("unavailable LLM never blocks numerical report and cannot invent orders",async()=>{const h=harness({metrics:{turns:5,complaints:1},leads:[{phone:"+70000000002",sales_stage:"PAYMENT_PENDING",interest:"",psycho_analysis:"TEXT_MODEL_TIMEOUT"}]});await h.run("2026-10-06T18:59:00Z");assert.match(h.sends[0].text,/Намерений заказать: 1/);assert.match(h.sends[0].text,/Созданных заказов: нет данных/);assert.doesNotMatch(h.sends[0].text,/TEXT_MODEL_TIMEOUT/);});
test("503 persists retry state without delivered marker",async()=>{const h=harness({failures:2});await h.run("2026-10-06T18:59:00Z");const row=await h.store.get(dailyReportKey("fixture","2026-10-06"));assert.equal(row?.status,"pending");assert.equal(row?.attempts,1);assert.equal(row?.last_error,"HTTP_503");assert.equal(row?.delivered_at,undefined);});
test("503 then 200 retries stable ID and exactly one accepted send",async()=>{const h=harness({failures:1});await alreadyDelivered(h,"2026-10-05");await h.run("2026-10-06T18:59:00Z");await h.run("2026-10-06T19:01:00Z");await h.run("2026-10-06T19:05:00Z");assert.equal(h.sends.length,2);assert.equal(h.sends[0].requestId,h.sends[1].requestId);assert.equal((await h.store.get(dailyReportKey("fixture","2026-10-06")))?.attempts,2);});
test("repeated ticks never duplicate an accepted daily message",async()=>{const h=harness();await h.run("2026-10-06T18:59:00Z");await h.run("2026-10-06T18:59:50Z");assert.equal(h.sends.length,2);});
test("restart at 00:04 catches yesterday missed at 23:58",async()=>{const h=harness();await h.run("2026-10-06T18:58:00Z");const restarted=harness({store:h.store});await restarted.run("2026-10-06T19:04:00Z");assert.equal(restarted.sends.length,1);assert.match(restarted.sends[0].text,/2026-10-06/);});
test("already sent survives process restart",async()=>{const h=harness();await h.run("2026-10-06T18:59:00Z");const restarted=harness({store:h.store});await restarted.run("2026-10-06T19:04:00Z");assert.equal(restarted.sends.length,0);});
test("missing admin never sends and remains pending",async()=>{const h=harness({config:{admin_phone:""}});await h.run("2026-10-06T18:59:00Z");assert.equal(h.sends.length,0);assert.equal((await h.store.get(dailyReportKey("fixture","2026-10-06")))?.last_error,"ADMIN_RECIPIENT_MISSING");});
test("normalized recipient equal customer is blocked before transport",async()=>{const h=harness({config:{admin_phone:"+7 (000) 000-00-02"},leads:[{phone:"70000000002",sales_stage:"NEW",interest:"",psycho_analysis:""}]});await h.run("2026-10-06T18:59:00Z");assert.equal(h.sends.length,0);assert.equal((await h.store.get(dailyReportKey("fixture","2026-10-06")))?.last_error,"ADMIN_RECIPIENT_COLLISION");});
test("one tenant config failure cannot abort another",async()=>{const h=harness();h.deps.loadConfig=async(id:string)=>{if(id==="broken")throw new Error("TENANT_FAILURE");return h.config;};await processDailyOwnerReports([{...h.config,instance_id:"broken"},h.config],new Date("2026-10-06T18:59:00Z"),h.deps);assert.equal(h.sends.filter(x=>x.instanceId==="fixture").length,2);});
test("month and year boundaries use previous calendar date",()=>{assert.deepEqual(ownerReportDates({timezone:"UTC"},new Date("2027-01-01T00:04:00Z")),["2026-12-31"]);assert.deepEqual(ownerReportDates({timezone:"UTC"},new Date("2026-03-01T00:04:00Z")),["2026-02-28"]);});
test("gateway skipped or queued does not count as transport acceptance",async()=>{for(const response of [{skipped:true},{ok:true},{acknowledged:true,queued:true}]){const h=harness();h.deps.send=async()=>response;await h.run("2026-10-06T18:59:00Z");assert.equal((await h.store.get(dailyReportKey("fixture","2026-10-06")))?.status,"pending");}});
test("overlapping workers preserve one accepted request",async()=>{const h=harness();await alreadyDelivered(h,"2026-10-05");await Promise.all([h.run("2026-10-06T18:59:00Z"),h.run("2026-10-06T18:59:00Z")]);assert.equal(h.sends.length,1);});



test("runtime timezone wins when the tenant list omits or misstates it", async () => {
 const h=harness({config:{timezone:"UTC"}});
 await processDailyOwnerReports([{...h.config,timezone:"Asia/Almaty"}],new Date("2026-10-06T18:59:00Z"),h.deps);
 assert.equal(h.sends.some(payload=>payload.text.includes("2026-10-06")),false);
});
test("complaint details are deterministic, scoped to source fields, and free of PII", () => {
 const text=buildDailyOwnerText({instanceId:"fixture",reportDate:"2026-10-06",brand:"Fixture",leads:[],metrics:{complaints:1},learningNotes:[],
  timeZone:"Asia/Almaty",caseDetailsAvailable:true,complaintCases:[{kind:"complaint",status:"resolved",createdAt:Date.parse("2026-10-05T20:00:00Z"),
    updatedAt:Date.parse("2026-10-06T17:00:00Z"),summary:"Холодный заказ +70000000002, клиент Private Name, secret=hidden",assignedOperator:"Private Operator",resolution:"Private text"}]});
 assert.match(text,/22:00.*жалоба.*Еда была холодной.*решено/);
 assert.match(text,/оператор: назначен/);
 assert.match(text,/решение: зафиксировано/);
 assert.doesNotMatch(text,/70000000002|Private|hidden|secret/);
});
test("per-date operator-case windows respect timezone and daylight saving", () => {
 const normal=localReportWindow("2026-10-06","Asia/Almaty");
 assert.equal(new Date(normal.start).toISOString(),"2026-10-05T19:00:00.000Z");
 assert.equal(normal.end-normal.start+1,24*60*60*1000);
 const summerStart=localReportWindow("2026-03-29","Europe/Berlin");
 assert.equal(summerStart.end-summerStart.start+1,23*60*60*1000);
});
