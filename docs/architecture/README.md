# Архитектура

## Жалпы құрылыс

Бұл — WhatsApp арқылы жұмыс істейтін Fast Food AI Agent. Жүйе Node.js/TypeScript стекінде жазылған, VoltAgent фреймворкін қолданады.

## 9 қабатты архитектура (DAG — circular dependency жоқ)

```
Layer 9: server.ts                     ← Entry point
Layer 8: cron/statsCron.ts             ← Күнделікті есеп
Layer 7: routes/                        ← Express роутерлер
Layer 6: agent/                         ← VoltAgent LLM агент
Layer 5: context/                       ← Context жинау
Layer 4: skills/                        ← Tool функциялар
Layer 3: services/                      ← Интеграциялар
Layer 2: transport/                     ← WhatsApp желісі
Layer 1: utils/                         ← Көмекші
Layer 0: types/instructions             ← Таза типтер
```

Әр қабат тек өзінен төменгі қабаттарға тәуелді. Жоғары қабат ешқашан төменгі қабатқа import болмайды.

## Негізгі компоненттер

### Express сервер (server.ts)
- express.json() 15MB лимит
- socket.io (принтер сигналдары үшін)
- 3 main routes: /whatspro-webhook, /health, /kanban-webhook

### WhatsApp Webhook (whatsappWebhook.route.ts)
- verifySecret() — NocoDB конфигтен tenant secret тексеру
- guardIncomingMessage() — спам/дубликат/мут фильтрі
- preloadContext() — 8 параллель шақыру арқылы контекст жинау
- runFastFoodAgent() — LLM агент
- validateFinalText() — жауапты постыңғы өңдеу
- sendWhatsProResponseSequence() — WhatsApp-қа жіберу
- evaluateForShpor() — екінші миға сақтау (async)

### Agent (fastfoodAgent.ts)
- VoltAgent Agent() — createOpenAI адаптер
- Модель: google/gemini-2.5-flash (default)
- 7 skill (tool)
- maxSteps: 6
- markdown: false
- Instructions + FACTS_CONTEXT біріктіреді

### Context (preloadContext.ts → buildFactsPrompt.ts)
- параллель дерек көздері: Tenants platform, Redis, Alemi API
- 20 өрісті FastFoodContext объект
- FACTS_CONTEXT JSON ретінде LLM-ге беріледі

### Skills (7 tool)
1. searchMenu — Alemi каталогын іздеу
2. getPaymentDetails — төлем реквизиттері
3. registerPaymentReceipt — чек тіркеу
4. updateCrmLead — CRM аналитика
5. escalateToAdmin — админге эскалация
6. sendMenuLink — магиялық сілтеме
7. searchWeb — Tavily іздеу

### Services (9 файл)
- alemiApi.service — HMAC-қолтаңбалы Alemi бизнес API клиенті
- platformConfig.service — WhatsPro/Tenants platform конфигі мен жады
- redis.service — Redis клиент
- inboundGuard.service — Кіру фильтрі
- tenantAuth.service — Secret тексеру
- diagnostics.service — Health check
- developerNotify.service — Әзірлеушіге хабарлама
- mediaAnalysis.service — Сурет/аудио/PDF талдау
- kanbanSync.service — n8n вебхук

## Сыртқы жүйелер

| Жүйе | Протокол | Рөлі |
|------|----------|------|
| OpenRouter | HTTP REST | LLM (gemini-2.5-flash, gpt-4o-mini) |
| Alemi API | HMAC HTTP | Ресторан бизнес деректері мен командалары |
| Tenants platform | Bearer HTTP | Конфиг + Shpor |
| Redis | TCP | Кэш/күй/тарих |
| WhatsPro API | HTTP REST | WhatsApp шлюз |
| Tavily | HTTP POST | Веб іздеу |
| n8n | HTTP POST | Kanban синхрондау |

## Қауіпсіздік

- DNS-level private IP блокировка (SSRF қорғаныс)
- 2 деңгейлі аутентификация: глобалды токен + tenant secret
- timingSafeEqual қолданылады
- Spam лимиті: 15 хабар/минут
- Duplicate detection: hash + 5s window

## Кэш стратегиясы

Әрбір сыртқы ресурс үшін қос кэш:
- Fast cache (секунд/минут)
- Stale backup (сағат/күн) — егер негізгі көз қолжетімсіз болса

## Prompt жүйесі

2 деңгейлі:
1. **instructions.ts** — 10 қатаң ереже, код деңгейінде
2. **Tenants platform system_prompt** — бизнес ережелері, tenant-level

Жүйелік код ережелері tenant промптынан жоғары тұрады.
