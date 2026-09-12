import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { prepareMediaForAnalysis } from "../src/services/mediaAnalysis.service.js";

test("a PDF receipt is rendered to an image for providers without document input", async () => {
  let received = "";
  const prepared = await prepareMediaForAnalysis(
    Buffer.from("%PDF-1.4 receipt").toString("base64"),
    "application/pdf",
    true,
    async pdf => {
      received = pdf.toString("utf8");
      return Buffer.from("png-preview");
    },
  );
  assert.match(received, /^%PDF-/);
  assert.equal(prepared.mimeType, "image/png");
  assert.equal(Buffer.from(prepared.base64, "base64").toString("utf8"), "png-preview");
});

test("the media analyzer sends the prepared preview to the LLM", () => {
  const source = fs.readFileSync(path.join(process.cwd(), "src/services/mediaAnalysis.service.ts"), "utf8");
  assert.match(source, /await prepareMediaForAnalysis\(/);
  assert.match(source, /base64: prepared\.base64/);
  assert.match(source, /mimeType: prepared\.mimeType/);
});
