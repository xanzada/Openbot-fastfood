import test from "node:test";
import assert from "node:assert/strict";
import { callModelChain, clearModelCooldowns } from "../src/agent/modelRouter.js";

const okResult = (text: string) => ({ content: [{ type: "text", text }], usage: {} });
function fakeModel(modelId: string, behaviour: (signal: AbortSignal) => Promise<any>, log: string[]) {
  return {
    modelId,
    async doGenerate(options: any) {
      log.push(`start:${modelId}`);
      const signal = options.abortSignal as AbortSignal;
      signal.addEventListener("abort", () => log.push(`abort:${modelId}`), { once: true });
      return behaviour(signal);
    },
  };
}
const hang = (signal: AbortSignal) => new Promise((_r, reject) => signal.addEventListener("abort", () => reject(new Error("aborted")), { once: true }));
const after = (ms: number, value: any) => () => new Promise((r) => setTimeout(() => r(value), ms));
const entry = (model: any, timeout = 8000) => ({ model, timeout, label: `t:${model.modelId}` });

test("a stalled primary is hedged: the parallel lane answers and the stalled one is aborted", async () => {
  process.env.TEXT_HEDGE_DELAY_MS = "50";
  clearModelCooldowns();
  const log: string[] = [];
  const started = Date.now();
  const result = await callModelChain([
    entry(fakeModel("a", hang, log)),
    entry(fakeModel("b", after(20, okResult("from b")), log)),
    entry(fakeModel("c", hang, log), 20000),
  ], "doGenerate", {});
  assert.equal(result.content[0].text, "from b");
  assert.ok(Date.now() - started < 1000);
  assert.deepEqual(log.filter((l) => l.startsWith("start")), ["start:a", "start:b"]);
  assert.ok(log.includes("abort:a"));
});

test("a fast primary costs exactly one call", async () => {
  process.env.TEXT_HEDGE_DELAY_MS = "200";
  clearModelCooldowns();
  const log: string[] = [];
  const result = await callModelChain([
    entry(fakeModel("a", after(10, okResult("from a")), log)),
    entry(fakeModel("b", after(10, okResult("from b")), log)),
  ], "doGenerate", {});
  assert.equal(result.content[0].text, "from a");
  assert.deepEqual(log, ["start:a"]);
});

test("a failing lane starts the next one immediately; all failing rejects", async () => {
  process.env.TEXT_HEDGE_DELAY_MS = "5000";
  clearModelCooldowns();
  const log: string[] = [];
  const started = Date.now();
  const result = await callModelChain([
    entry(fakeModel("a", async () => { throw new Error("boom"); }, log)),
    entry(fakeModel("b", after(10, okResult("from b")), log)),
  ], "doGenerate", {});
  assert.equal(result.content[0].text, "from b");
  assert.ok(Date.now() - started < 1000);
  clearModelCooldowns();
  await assert.rejects(callModelChain([
    entry(fakeModel("x", async () => { throw new Error("x down"); }, [])),
    entry(fakeModel("y", async () => { throw new Error("y down"); }, [])),
  ], "doGenerate", {}), /y down/);
});

test("an empty answer loses to a lane still running", async () => {
  process.env.TEXT_HEDGE_DELAY_MS = "10";
  clearModelCooldowns();
  const log: string[] = [];
  const result = await callModelChain([
    entry(fakeModel("a", after(40, { content: [], usage: {} }), log)),
    entry(fakeModel("b", after(80, okResult("from b")), log)),
  ], "doGenerate", {});
  assert.equal(result.content[0].text, "from b");
});

test("TEXT_HEDGE_DELAY_MS=0 keeps the old sequential chain", async () => {
  process.env.TEXT_HEDGE_DELAY_MS = "0";
  clearModelCooldowns();
  const log: string[] = [];
  const result = await callModelChain([
    entry(fakeModel("a", after(30, okResult("from a")), log)),
    entry(fakeModel("b", after(1, okResult("from b")), log)),
  ], "doGenerate", {});
  assert.equal(result.content[0].text, "from a");
  assert.deepEqual(log, ["start:a"]);
  delete process.env.TEXT_HEDGE_DELAY_MS;
});
