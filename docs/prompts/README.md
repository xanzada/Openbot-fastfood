# Prompt System

## 2 деңгейлі prompt жүйесі

### Level 1: instructions.ts (код деңгейінде)

10 қатаң ереже — LLM-ге берілетін инструкциялар. Бұл ережелер ешқашан NocoDB промптымен қайшы келмейді, тек оны күшейтеді.

```
1. Short replies (< 2 sentences for delivery/pickup)
2. Menu-only answers, decline unrelated topics
3. No URLs in text body (always as separate message)
4. No follow-up questions
5. Menu info only after customer asks explicitly, decline unrelated topics
6. No hallucination
7. Fact-check before responding
8. Kitchen status from context
9. No promotional messages
10. Strict language (use customer language, 100% pure)
```

### Level 2: NocoDB system_prompt (Бот промп.txt)

**Жүктеу:** preloadContext() → getRestaurantConfig().system_prompt → buildFactsPrompt()

**Бұл промпттың рөлі:**
- Ресторанның бизнес ережелерін сипаттайды
- Жеткізу аймақтары, төлем әдістері, жұмыс уақыты
- FAQ және типтік жауаптар
- "Біздің мейрамхана — дәмді тағамдар әлемі"

**ЕСКЕРТУ:** Бұл промпт LLM-ге беріледі, бірақ код деңгейіндегі ережелер (instructions.ts) басым тұрады. Егер NocoDB промптында 3 сөйлем болса, finalValidator.ts бәрібір 2 сөйлемге келтіреді.

## FACTS_CONTEXT механизмі

**Құрылымы:** JSON объект, өзінше LLM контексті

```json
{
  "restaurant": { "name", "workHours", "isOpen", "domain", "waitTime" },
  "customer": { "hasActiveOrder", "orderId", "status", "totalAmount" },
  "menu": { "categories", "itemsTotal" },
  "kitchen": { "isEmergency", "waitTime", "isAcceptingOrders" },
  "payment": { "kaspiMethods", ... }
}
```

**Мүмкіндіктері:**
- LLM нақты фактілерді алады, ойлап таппайды
- JSON форматы фактілерді дұрыс өңдеуге көмектеседі
- FACTS_CONTEXT әрбір LLM сұрауына қосылады

## 4 деңгейлі қорғаныс (Hallucination Defense)

```
Layer 1: instructions.ts
Layer 2: Pre-LLM context check (whatsappWebhook.route.ts)
Layer 3: finalValidator.ts post-processing
Layer 4: buildFactsPrompt.ts fact injection
```

## System Prompt (толық)

```typescript
const prompt = `ROLE: Smart assistant for customers of a fastfood restaurant.
STYLE: Friendly, helpful, short.

RULES:
${rulesFromInstructions}

FACTS:
${JSON.stringify(factsContext)}

LANGUAGE: ${detectedLang}

PREVIOUS TURNS:
${chatHistory.map(m => `${m.role}: ${m.text}`).join('\n')}`;
```

## Prompt инъекциясынан қорғаныс

- Клиент мәтіні NocoDB system_prompt-пен араласпайды
- instructions.ts кодта қатты кодирленген, өзгерту мүмкін емес
- inputText клиенттен → user message ретінде беріледі
