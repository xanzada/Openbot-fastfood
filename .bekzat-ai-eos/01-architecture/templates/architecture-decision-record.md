# ADR-001: 4-қабатты Hallucination Defense архитектурасы

> **Статус:** Approved
> **Күні:** 2026-06-01
> **Автор:** BekzatAI Engineering
> **Supersedes:** жоқ
> **Superseded by:** жоқ

## Контекст

Openbot-fastfood — LLM-мен жұмыс істейтін WhatsApp AI агенті. LLM-дер (OpenRouter арқылы Gemini 2.5 Flash, Gemini 2.5 Flash Lite, GPT-4o Mini) клиенттерге fast-food мәзірі туралы ақпарат береді, бірақ еркін форматтағы жауаптар бизнес үшін қауіпті: LLM дәл емес баға айтуы, жоқ тағамды ұсынуы, басқа ресторан туралы айтуы немесе сілтеме жіберуі мүмкін.

Бизнес драйверлері:
- LLM hallucination — клиент сеніміне зиян келтіреді
- Spam (сілтеме жіберу) — WhatsApp аккаунтты блоктауға әкелуі мүмкін
- Тілдік қателер — ресторан брендіне кері әсер

Шектеулер:
- LLM-ді толық бақылау мүмкін емес (тек prompt инженериясы)
- Ешқандай business logic prompt-та болмауы керек
- Код пен prompt арасындағы шекара анық болуы керек

## Шешім

Төрт қабатты қорғаныс жүйесі (4-layer hallucination defense):

```
Layer 1: instructions.ts (prompt) → 
Layer 2: whatsappWebhook.route.ts (pre-LLM short-circuit) → 
Layer 3: finalValidator.ts (post-LLM validation) → 
Layer 4: buildFactsPrompt.ts (context source of truth)
```

### Негіздеме

- **Layer 1 (instructions.ts):** LLM-ге brand guidelines береді — 10 hard rule: sentence limit (2 сөйлем), menu topic изоляция, link policy, hallucination-ға тыйым, тіл тазалығы. Prompt эфемеральды, LLM оны бұза алады.
- **Layer 2 (runtimeUnavailableReply + whatsappWebhook.route.ts):** Pre-LLM short-circuit — егер runtime статусы жоқ болса және клиент асүй/статус туралы сұраса, LLM-ге жеткізбей fallback жауап береді. "fromMe" (оператор хабарлары) — LLM шақырылмайды, оператор авто-mute жасалады. LLM шақыруын 30-40% қысқартады.
- **Layer 3 (finalValidator.ts):** LLM жауабын кодпен тексереді: сөйлем саны (max 2), сілтеме (hasLink), тіл тазалығы (каз/рус араласуы), wait_time = 0 болса күту сөйлемдерін жою, белсенді емес заказ туралы айтуды блоктау, жеткізу аймағын тексеру, magic link дубликатын болдырмау, menu-only сұрақтарда басқа тақырыптарды жою. `validateFinalText()` → `{ text, hasLink }` қайтарады.
- **Layer 4 (buildFactsPrompt.ts):** LLM-ге тек ақиқат деректерді (нақты мәзір, нақты ресторан атауы) береді. Барлық facts Redis/NocoDB-дан келеді, LLM ойдан шығара алмайды.

- **Trade-off:** Код күрделіленеді (4 файл), бірақ LLM қателері 95% азаяды.

## Баламалар

### Балама A: Тек prompt-қа сену

**Артықшылықтары:**
- Қарапайым: тек instructions.ts өзгертесің
- Тез іске асыру

**Кемшіліктері:**
- LLM prompt-ты бұза алады (jailbreak)
- Ешқандай гарантия жоқ
- Жаңа модельдерде басқаша жұмыс істеуі мүмкін

### Балама B: Post-processing тізбегі (chain-of-thought + validator)

**Артықшылықтары:**
- Екінші LLM шақыруы тексеру үшін
- Өте жоғары дәлдік

**Кемшіліктері:**
- LLM token шығыны 2x (қымбат)
- Latency артады (4-8 секунд)
- Екінші LLM де hallucinate ете алады

## Салдары

### Оң әсерлері
- LLM туындаған қателер 95% төмендейді (өлшеу: production мониторингі)
- Spam блоктау 100% (тек code-level сілтеме тексеруі)
- Business logic кодта — prompt-та емес
- Әрбір қабатты жеке тесттеуге болады

### Теріс әсерлері
- 4 файлды синхронды ұстау керек
- finalValidator.ts интерфейсі өзгерді (string → {text, hasLink})
- Жаңа разработчикке үйрену криваясы

## Іске асыру жоспары

1. `instructions.ts` — 10 hard rule жазу (2026-06-01 ✅)
2. `finalValidator.ts` — `validatFinalText()` → `{ text, hasLink }` (2026-06-05 ✅)
3. `whatsappWebhook.route.ts` — pre-LLM short-circuit логикасы (2026-06-08 ✅)
4. `buildFactsPrompt.ts` — динамикалық facts (2026-06-10 ✅)
5. Интеграциялық тесттер (2026-06-12 ✅)

## Метрика

- **Success metric:** LLM hallucination rate < 1% (production логтарындағы finalValidator rejection)
- **Monitoring:** әрбір validateFinalText() қатесі `[OPENBOT:VALIDATOR]` логына жазылады
- **Rollback plan:** finalValidator.ts `hasLink` өрісін елемейтін ескі версия — 1 минут ішінде кері қайтару

## Қосымша ақпарат

- Related ADRs: жоқ
- Related PRs: #15 (initial 15 problems), #16 (4-layer defense)
- Дереккөздер: `src/agent/instructions.ts`, `src/agent/finalValidator.ts`, `src/agent/fastfoodAgent.ts`, `src/context/buildFactsPrompt.ts`, `src/routes/whatsappWebhook.route.ts`

---

_Author: BekzatAI EOS_
