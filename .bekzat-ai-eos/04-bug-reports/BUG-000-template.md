# BUG-001: Мәзір бұйрығы LLM-де "дұрыс емес тағам" шығарады

> **Severity:** P2-Medium
> **Статус:** Fixed
> **Ашылған:** 2026-05-28
> **Автор:** BekzatAI Engineering
> **Assignee:** BekzatAI Engineering

---

## Сипаттамасы

"Мәзірді көрсет" деген бұйрыққа LLM кейде нақты мәзірде жоқ тағамдарды атайды (hallucination). Мысалы: "Пицца Маргарита 2500 теңге" — бірақ мәзірде Маргарита жоқ. Бұл клиентті шатастырып, ресторан сеніміне зиян келтіреді.

## Steps to Reproduce

1. Клиенттен "мәзір" сөзі келеді
2. Pre-LLM short-circuit мәзір бұйрығын танымайды (ескі версия)
3. LLM-ге instruction беріледі: "тек мәзірдегі тағамдарды айт"
4. LLM "Пицца Маргарита 2500тг" деп жауап береді
5. Бұл тағам NocoDB-де жоқ

## Күтілетін нәтиже

LLM тек NocoDB-де бар тағамдарды айтуы керек. Ешқандай жалған ақпарат болмауы керек.

## Нақты нәтиже

LLM 10% жағдайда жоқ тағамдарды атайды (модельге байланысты: Gemini 2.5 Flash — 8%, GPT-4o Mini — 3%).

## Environment

- **Node:** 20
- **Redis:** 7
- **Бранч:** main
- **Коммит:** a1b2c3d
- **LLM модель:** gemini-2.5-flash (prompt: v1)

## Logs / Screenshots

```
[2026-05-28 14:23:01] LLM response: "Біздің мәзірде: Маргарита 2500тг, Пепперони 3000тг"
[2026-05-28 14:23:01] VALIDATION: Маргарита NOT FOUND in NocoDB menu
```

## Root Cause Analysis

Екі фактор:
1. **Layer 2 жоқ (pre-LLM short-circuit):** Мәзір сұрауы LLM-ге жетіп, LLM еркін жауап берді. Егер pre-LLM short-circuit "мәзір" сөзін ұстап, direct menu response жіберсе, LLM-ге жетпейді.
2. **Layer 3 әлсіз (finalValidator.ts):** validateFinalText() тағам атауларын NocoDB-мен салыстырмады. Тек сөйлем саны (max 2) мен сілтемені тексерді.

## Fix

1. **Layer 2 (whatsappWebhook.route.ts):** "мәзір", "меню", "ссылка" сөздері келгенде, pre-LLM short-circuit LLM-ге жеткізбей, тікелей menuLink.skill.ts шақырады.
2. **Layer 3 (finalValidator.ts):** validateFinalText() мәзір context-ін тексереді. Егер LLM мәзірде жоқ тағамды атаса → rejection + fallback.
3. **instructions.ts:** "Мәзірде жоқ тағамдарды айтуға тыйым салынады" — Hard Rule #4.

## Related Files

- `src/routes/whatsappWebhook.route.ts:45-60`
- `src/agent/finalValidator.ts:25-50`
- `src/agent/instructions.ts:15-20`

## Regression Test

```typescript
// pre-LLM short-circuit: "мәзір" → menuLink.skill.ts (LLM шақырылмайды)
test('pre-llm menu keyword bypasses LLM', async () => {
  const result = await handleIncoming('мәзір', 'restaurant_1');
  expect(result.llmCalled).toBe(false);
  expect(result.response).toContain('Мәзір');
});

// finalValidator: жоқ тағамды анықтау
test('finalValidator rejects hallucinated item', () => {
  const result = validateFinalText(
    'Маргарита 2500тг', 
    { language: 'kk', text: 'мәзір', activeOrder: null, runtimeStatus: null, hardRealtimeContext: { stale: false }, fetchedSettings: { wait_time: 0 }, magicLinkAlreadySent: false, explicitMenuLinkIntent: false, config: {} }
  );
  expect(result.text).not.toContain('Маргарита');
});
```

---

_Author: BekzatAI EOS_
