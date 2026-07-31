import { readFile, writeFile } from "node:fs/promises";
import { generateMediaText } from "../src/services/llm.service.js";

const smokeOutputPath = process.argv[2] || "/tmp/smoke-output.json";
const rawOutput = await readFile(smokeOutputPath, "utf8");
const scenarios = rawOutput.trim().split("\n").filter(Boolean).map(line => JSON.parse(line));

const JUDGE_SYSTEM = `You are a strict AI agent quality judge for a fast-food WhatsApp bot.
Evaluate each scenario reply for:
1. **Relevance**: Does the reply answer the customer's question?
2. **Naturalness**: Does it sound like a human, not a script?
3. **Conciseness**: Is it short enough for WhatsApp (1-4 sentences)?
4. **Tool use**: Did it call the right tools for the intent?
5. **Safety**: Does it avoid inventing facts, prices, or promises?

Return JSON only: {"pass": true|false, "reason": "short explanation", "score": 0-10}`;

let totalScore = 0;
let passCount = 0;
const results: any[] = [];

for (const scenario of scenarios) {
  const prompt = `Scenario ID: ${scenario.scenarioId}
Expected intent: ${scenario.expect}
Customer input: "${scenario.input}"
Bot reply: "${scenario.reply}"
Tools called: ${JSON.stringify(scenario.toolCalls)}
Validation warnings: ${JSON.stringify(scenario.validationWarnings)}

Judge this reply.`;

  try {
    const aiText = await generateMediaText({
      prompt,
      base64: "",
      mimeType: "text/plain",
      systemPrompt: JUDGE_SYSTEM,
    });
    const raw = aiText.trim().replace(/^```(?:json)?\s*/i, "").replace(/```$/i, "").trim();
    const judgment = JSON.parse(raw);
    results.push({ scenarioId: scenario.scenarioId, ...judgment });
    if (judgment.pass) passCount++;
    totalScore += Number(judgment.score || 0);
    console.log(`[${scenario.scenarioId}] ${judgment.pass ? "✓" : "✗"} ${judgment.score}/10 - ${judgment.reason}`);
  } catch (error: any) {
    console.error(`[${scenario.scenarioId}] JUDGE_ERROR: ${error?.message || error}`);
    results.push({ scenarioId: scenario.scenarioId, pass: false, reason: "judge_failed", score: 0 });
  }
}

const avgScore = scenarios.length > 0 ? (totalScore / scenarios.length).toFixed(1) : "0.0";
console.log(`\n=== JUDGE SUMMARY ===`);
console.log(`Passed: ${passCount}/${scenarios.length}`);
console.log(`Average score: ${avgScore}/10`);
console.log(`Judgment: ${Number(avgScore) >= 7 ? "ACCEPTABLE" : "NEEDS_IMPROVEMENT"}`);

await writeFile("/tmp/judge-results.json", JSON.stringify(results, null, 2), "utf8");
process.exit(Number(avgScore) >= 7 ? 0 : 1);
