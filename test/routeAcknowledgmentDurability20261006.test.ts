import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import vm from "node:vm";
import ts from "typescript";

const raw = fs.readFileSync(new URL("../src/routes/whatsappWebhook.route.ts", import.meta.url), "utf8");
const route = ts.transpileModule(raw.slice(raw.indexOf("export function whatsappWebhookRoute()")), { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS } }).outputText;
function fixture(enqueue: (...args: any[]) => Promise<any>, media: any = null) {
  let callback: any; let scheduled = 0; let processed = 0; const middleware: any[] = [];
  const auth = () => {}; const resolver = () => {};
  const env: any = {
    exports: {}, createRouter: () => ({ post: (...args: any[]) => { middleware.push(...args.slice(1,-1)); callback=args.at(-1); } }),
    resolveTenantInstance: resolver, verifySecret: auth, Date,
    console: { info() {}, log() {}, warn() {}, error() {} },
    isOwnWhatsAppMessage: () => false, getInstanceId: (b: any) => b.instanceId,
    getPhone: (b: any) => b.phone, maskPhone: () => "masked", extractMessageId: (b: any) => b.messageId,
    extractInboundText: (b: any) => b.body, extractInboundMedia: () => media,
    DEVELOPER_ALERT_MARKER_RE: /__never_in_fixture__/, inboundBufferDelayMs: () => 500, inboundAudioBufferDelayMs: () => 6000,
    setImmediate: () => { scheduled++; }, processWhatsAppWebhook: async () => { processed++; },
    startInboundWebhookQueueWorker: () => {}, enqueueVerifiedInboundWebhook: enqueue,
  };
  vm.runInNewContext(route + ";exports.whatsappWebhookRoute();", env);
  return { callback, middleware, auth, resolver, state: () => ({scheduled,processed}) };
}
function response() { let status=0; const res: any={status(n:number){status=n;return this;},json(body:any){return {status,body};},send(body:any){return {status,body};}};return res; }
const body={instanceId:"audit-ingress",phone:"70000000001",messageId:"synthetic-message",body:"Сәлем"};
test("actual ingress retains authentication before its persistence boundary", () => {
  const f=fixture(async()=>({id:"synthetic-id",inserted:true})); assert.equal(f.middleware[0],f.resolver); assert.equal(f.middleware[1],f.auth);
});
test("actual ingress cannot acknowledge before its durable insertion settles", async () => {
  let release!:()=>void; let persisted=false; const blocked=new Promise<void>(r=>{release=r;});
  const f=fixture(async()=>{await blocked;persisted=true;return{id:"synthetic-id",inserted:true};});
  let acknowledged=false; const task=f.callback({body},response()).then((r:any)=>{acknowledged=true;assert.equal(persisted,true);assert.equal(r.status,202);assert.equal(r.body.accepted,true);});
  await Promise.resolve(); assert.equal(acknowledged,false); release();await task;assert.equal(f.state().processed,0);
});
test("actual ingress rejects storage failure without scheduling volatile processing", async () => {
  const f=fixture(async()=>{throw new Error("PRIVATE_STORAGE_CANARY");}); const r=await f.callback({body},response());
  assert.equal(r.status,503);assert.equal(r.body.accepted,undefined);assert.equal(JSON.stringify(r).includes("PRIVATE_STORAGE_CANARY"),false);assert.equal(f.state().scheduled,0);
});
test("actual ingress exposes a stable persisted job receipt for replay", async () => {
  const f=fixture(async()=>({id:"stable-synthetic-id",inserted:false}));const r=await f.callback({body},response());
  assert.equal(r.status,202);assert.equal(r.body.job_id,"stable-synthetic-id");assert.equal(r.body.duplicate,true);
});
test("ephemeral stickers are skipped without storing their binary payload", async () => {
  let inserted=0;const f=fixture(async()=>{inserted++;return{id:"must-not-persist",inserted:true};},{kind:"sticker",historyLabel:"[Sticker sent]"});
  const r=await f.callback({body:{...body,body:"",base64:"synthetic-sticker-bytes"}},response());assert.equal(r.status,202);assert.equal(r.body.skipped,true);assert.equal(r.body.reason,"sticker");assert.equal(inserted,0);
});
