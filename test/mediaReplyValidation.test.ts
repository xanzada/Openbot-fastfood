import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

test("ordinary media replies pass through the customer text validator", async () => {
  const source = await readFile(new URL("../src/routes/whatsappWebhook.route.ts", import.meta.url), "utf8");
  const replyBranch = source.slice(
    source.indexOf('if (mediaAnalysis.type === "reply")'),
    source.indexOf('if (mediaAnalysis.type === "complaint")'),
  );
  assert.match(replyBranch, /validateFinalText\(/);
  assert.match(replyBranch, /mediaPreemptiveReply = mediaReplyValidation\.text/);
});
