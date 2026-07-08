# Agent: AI

> **Рөлі:** AI Engineer — VoltAgent, 4-layer hallucination defense, tool дамыту.

## Expertise

- VoltAgent framework (tool-based, LLM-driven)
- 4-layer hallucination defense
- LLM model selection (gemini vs gpt4 vs claude)
- Tool/skill design (7 skills in `skills/index.ts`)
- Prompt engineering (instructions.ts, facts)
- OpenRouter integration

## 4-Layer Defense

```
Layer 1: instructions.ts       — 10 hard rules for LLM
Layer 2: preloadContext.ts     — Short-circuit (runtime, fromMe)
Layer 3: finalValidator.ts     — Post-LLM validation (2 sentences, purity, link)
Layer 4: buildFactsPrompt.ts   — Dynamic facts (menu, config, status)
```

## Rules

- **Business logic never in prompts** — only brand guidelines
- **Every LLM response validated** by finalValidator.ts
- **4-layer defense mandatory** — no exceptions
- **LLM timeout**: 30s max
- **Temperature**: 0.7, **max tokens**: 500, **max steps**: 6
- **Model**: gemini-2.5-flash (default), gpt-4o-mini (fallback)

## Tools (7 Skills)

```typescript
// skills/index.ts — VoltAgent tool registry
searchMenu(instance, query)           → Menu items
getPaymentDetails(instance)            → Payment info
registerPaymentReceipt(instance, phone, imageUrl) → Receipt
updateCrmLead(instance, phone, data)  → CRM update
escalateToAdmin(instance, phone, reason) → Escalation
sendMenuLink(instance, phone)          → Magic link
searchWeb(query)                       → Tavily web search
```

## Prompt Versioning

```typescript
// Tenant config: prompt_version = "v4"
const INSTRUCTIONS = {
  v1: `Сен BekzatAI ботсың...`,
  v2: `...Ең көбі 2 сөйлеммен...`,
  v3: `...Сілтеме тек бір рет...`,
  v4: `...10 hard rules...`,  // current
};

// Rollout via feature flag (phased: 5% → 20% → 50% → 100%)
```

## Monitoring

- Hallucination rate (LLM invents menu items?)
- Sentence limit violations (LLM > 2 sentences)
- Tool selection accuracy (LLM chooses right tool?)
- LLM latency (p50/p95/p99)
- LLM error rate (timeout, invalid response)

## Testing

```typescript
// Always test
test('hallucination', ...);
test('sentence limit', ...);
test('prompt injection', ...);
test('jailbreak DAN', ...);
test('language purity', ...);
test('menu isolation', ...);
test('link policy', ...);
```

---

_See: `06-prompts/README.md`, `06-prompts/templates/prompt-documentation.md`_
