import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import vm from "node:vm";
import ts from "typescript";
function loadCron() {
 const exports: any = {}; const owner: any[] = [];
 const modules: any = {
  "../services/redis.service.js": { redisClient: { isOpen: true } },
  "../services/platformConfig.service.js": { getAllRestaurantConfigs: async () => [{instance_id:"fixture",admin_phone:"+70000000001",timezone:"Asia/Almaty",alemi_secret:"fixture"}], getRestaurantConfig: async () => ({instance_id:"fixture",admin_phone:"+70000000001",timezone:"Asia/Almaty",alemi_secret:"fixture"}) },
  "../services/developerNotify.service.js": {notifyDeveloperSystemFailure: async()=>{}},
  "../services/alemiApi.service.js": {callAlemiLegacyAction:async(action:string)=>action==="get_today_crm"?[]:{ok:true}},
  "../services/dailyAnalytics.service.js": {localDayKey:()=> "2026-10-06",readSentDates:async()=>new Set(),pendingReportDates:()=>["2026-10-06"],normalizeLeadRows:(x:any)=>x,readDailyMetrics:async()=>({}),readLearningNotes:async()=>[],buildDailyAnalyticsRow:async()=>({total_chats:0}),markAnalyticsSent:async()=>{}},
  "../utils/envNumber.js": {envNumber:(_v:any,x:any)=>x},
  "../services/dailyReportDelivery.service.js": {processDailyOwnerReports:async()=>{owner.push("accepted");}},
  "../services/operatorNotification.service.js": {drainOperatorNotifications:async()=>{}}
 };
 const compiled=ts.transpileModule(readFileSync(process.env.AUDIT_DAILY_BASELINE_SOURCE || new URL("../src/cron/statsCron.ts",import.meta.url),"utf8"),{compilerOptions:{module:ts.ModuleKind.CommonJS,target:ts.ScriptTarget.ES2022}}).outputText;
 vm.runInNewContext(compiled,{exports,require:(name:string)=>modules[name],Date,Intl,process:{env:{}},console:{log(){},warn(){},error(){}}});
 return {exports,owner};
}
test("daily cron exposes a tenant-local owner delivery tick",()=> {
 const h=loadCron(); assert.equal(typeof h.exports.runOwnerNotificationTick,"function");
});
test("owner delivery tick sends independently of Hub analytics ledger",async()=>{
 const h=loadCron(); if(h.exports.runOwnerNotificationTick) await h.exports.runOwnerNotificationTick();
 assert.equal(h.owner.length,1,"the baseline only saves Hub analytics; no owner transport is invoked");
});

