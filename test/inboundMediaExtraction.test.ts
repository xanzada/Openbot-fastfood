import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import vm from "node:vm";
import ts from "typescript";
import { extractInboundMedia, hydrateInboundMedia } from "../src/services/inboundGuard.service.js";

test("hydrateInboundMedia revalidates WhatsApp PDF receipts after download", async () => {
  const body = {
    hasMedia: true,
    downloadUrl: "https://example.com/receipt.pdf",
    data: {
      message: {
        documentMessage: {
          fileLength: 2048,
          caption: "Kaspi receipt",
        },
      },
    },
  };

  const initialMedia = extractInboundMedia(body);
  assert.ok(initialMedia);
  assert.equal(initialMedia.valid, false);
  assert.equal(initialMedia.reason, "missing_mime_type");

  const originalFetch = globalThis.fetch;
  globalThis.fetch = (async () =>
    new Response(Buffer.from("%PDF-1.4 test"), {
      status: 200,
      headers: { "content-type": "application/pdf" },
    })) as typeof fetch;

  try {
    const hydrated = await hydrateInboundMedia(body, initialMedia);
    assert.ok(hydrated);
    assert.ok(hydrated.base64?.startsWith("data:application/pdf;base64,"));
    assert.equal(hydrated.valid, true);
    assert.equal(hydrated.reason, undefined);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

for (const type of ["audio", "ptt"]) {
  test("supported " + type + " without duration reaches hydrated audio with MIME and bytes", async () => {
    const bytes = Buffer.alloc(96); bytes.write("ID3");
    const body = {type, hasMedia:true, mediaType:"audio/mpeg", mediaData:bytes.toString("base64")};
    const hydrated = await hydrateInboundMedia(body, extractInboundMedia(body));
    assert.equal(hydrated?.valid,true);
    assert.equal(hydrated?.mimeType,"audio/mpeg");
    assert.equal(hydrated?.base64,"data:audio/mpeg;base64,"+bytes.toString("base64"));
    assert.equal(hydrated?.durationSeconds,undefined);
  });
}

test("ordinary audio above the former 8MiB cap hydrates without losing bytes", async () => {
  const bytes = Buffer.alloc(9 * 1024 * 1024 + 1); bytes.write("ID3");
  const body = {type:"audio",hasMedia:true,mediaType:"audio/mpeg",fileLength:bytes.length,seconds:240,mediaData:bytes.toString("base64")};
  const hydrated = await hydrateInboundMedia(body, extractInboundMedia(body));
  assert.equal(hydrated?.valid,true);
  assert.equal(hydrated?.sizeBytes,bytes.length);
  assert.equal(hydrated?.durationSeconds,240);
  assert.equal(Buffer.from(String(hydrated?.base64).split(",")[1],"base64").equals(bytes),true);
});

test("audio MIME and byte signatures still reject invalid input", async () => {
  const body = {type:"audio",hasMedia:true,mediaType:"audio/mpeg",mediaData:Buffer.alloc(96).toString("base64")};
  const hydrated = await hydrateInboundMedia(body, extractInboundMedia(body));
  assert.equal(hydrated?.reason,"media_signature_mismatch");
  assert.equal(extractInboundMedia({...body,mediaType:"audio/not-supported"})?.valid,false);
});

test("hydrated ordinary audio reaches the existing actual transcription branch without PTT", async () => {
  const bytes=Buffer.alloc(96);bytes.write("ID3");
  const body={type:"audio",hasMedia:true,mediaType:"audio/mpeg",mediaData:bytes.toString("base64")};
  const hydrated=await hydrateInboundMedia(body,extractInboundMedia(body));assert.equal(hydrated?.valid,true);
  // Execute the production function, replacing provider dependencies only.
  const source=fs.readFileSync(new URL("../src/services/mediaAnalysis.service.ts",import.meta.url),"utf8");
  const file=ts.createSourceFile("mediaAnalysis.service.ts",source,ts.ScriptTarget.ES2022,true);
  const fn=file.statements.find(node=>ts.isFunctionDeclaration(node)&&node.name?.text==="analyzeMedia");
  assert.ok(fn);
  const compiled=ts.transpileModule(fn.getText(file).replace(/^export /,""),{compilerOptions:{target:ts.ScriptTarget.ES2022,module:ts.ModuleKind.None}}).outputText;
  let calls=0;
  const analyze=new vm.Script(compiled+";analyzeMedia").runInNewContext({
    Buffer,console,
    stripDataUrl:(value:string)=>value.includes(",")?value.split(",")[1]:value,
    isGeminiNativeMediaProvider:()=>false,
    transcribeAudio:async(audio:Buffer,mime:string,lang:string)=>{
      calls++;assert.equal(audio.equals(bytes),true);assert.equal(mime,"audio/mpeg");assert.equal(lang,"ru");return "Синтетический вопрос";
    },
  });
  const result=await analyze(hydrated?.base64,hydrated?.mimeType,"","ru");
  assert.equal(calls,1);assert.equal(result.type,"reply");assert.equal(result.transcript,"Синтетический вопрос");
});
