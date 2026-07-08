# Prompt

> **Model:** gemini-2.5-flash (default), gpt-4o-mini (fallback). **Temp:** 0.7.

## 4-Layer Defense

```
Layer 1: instructions.ts
  └─→ 10 hard rules to LLM (brand guidelines only)
Layer 2: preloadContext.ts
  └─→ Short-circuit: runtime unavailable / fromMe / guard
Layer 3: finalValidator.ts
  └─→ Post-LLM: 2 sentences, language, link, menu isolation
Layer 4: buildFactsPrompt.ts
  └─→ Dynamic facts (menu, status, config) as JSON context
```

## Current Prompt (v4)

10 hard rules packed into `instructions.ts`:

```
1. ЕҢ КӨБІ 2 ҚЫСҚА СӨЙЛЕМ
2. ТЕК ҚАЗАҚ НЕМЕСЕ ОРЫС ТІЛІНДЕ
3. Клиентке тікелей "Сіз", "Сен" деп сөйле
4. Сілтеме тек magic link-тен, бір рет
5. "Бас тарту" болса — тағы жіберме
6. Мәзір сұраса — сілтеме. Тағам туралы сұраса — мәзір
7. Жұмыс уақыты/статус туралы айтпа
8. Заказ статусы туралы айтпа
9. Егер төлем туралы сұраса — төлем реквизиттерін айт
10. Егер клиент әкімшіні шақырса — escalation
```

## Versioning

```typescript
// Tenant config: prompt_version = "v4"
// Fallback: v4

const INSTRUCTIONS = {
  v1: `Сен BekzatAI ботсың...`,
  v2: `...Ең көбі 2 сөйлеммен...`,
  v3: `...Сілтеме тек бір рет...`,
  v4: `...10 rules...`,
};
```

## Facts Context

```typescript
// buildFactsPrompt.ts — dynamic JSON
{
  "menu_link": "https://...",
  "payment_details": "Kaspi: ...",
  "work_hours": "10:00-22:00",
  "is_accepting_orders": true,
  "wait_time": "15 мин"
}
```

## Best Practices

- **Never** put business logic in prompts
- **Never** use few-shot examples — add code instead
- **Every** prompt change = version bump + ADR
- **Test**: hallucination, injection, jailbreak, sentence limit

---

_See: `06-prompts/README.md`, `06-prompts/templates/prompt-documentation.md`_
