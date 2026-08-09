# 1. Executive Architecture Summary

Бұл — DLE (DataLife Engine) CMS-іне орнатылған SPA интернет-магазиннің үстіне салынған **multi-tenant WhatsApp AI Agent**. Әрбір ресторан бір DLE инстансындағы жеке instance_id арқылы бөлінген.

**Технологиялық стек:**
- Node.js 20 + TypeScript 5.9 + VoltAgent 2.8
- Express 5 (REST) + Socket.IO (принтер)
- Redis 5.x (state/cache/queue)
- NocoDB (config + shpor)
- DLE (MySQL) — PHP 8.x
- OpenRouter → gemini-2.5-flash / gpt-4o-mini
- WhatsPro HTTP API (WhatsApp шлюз)
- n8n (вебхук/оркестрация)
- Tavily (веб іздеу)

**Құрылыс:** 29 TypeScript файлы, 9 қабат, 0 circular dependency.

---

# 2. System Architecture

## Физикалық құрылыс

```
Internet
  │
  ▼
WhatsPro ───→ Express :4100 ───→ Redis
  │                                │
  │                                ▼
  │                              NocoDB
  │                                │
  │                                ▼
  │                              DLE + MySQL
  │
  └──→ n8n (kanban) ──→ Принтер (Socket.IO)

OpenRouter (LLM) ←── Express →─→ Tavily
```

## 9 қабат (Top-Down)

```
   ┌──────────────────────────────────────┐
 9 │ server.ts (entry point)              │
   ├──────────────────────────────────────┤
 8 │ cron/statsCron.ts                    │
   ├──────────────────────────────────────┤
 7 │ routes/ (whatsappWebhook, system)    │
   ├──────────────────────────────────────┤
 6 │ agent/ (fastfoodAgent, instructions, │
   │        finalValidator)               │
   ├──────────────────────────────────────┤
 5 │ context/ (preloadContext,             │
   │          buildFactsPrompt, types)     │
   ├──────────────────────────────────────┤
 4 │ skills/ (7 tool)                     │
   ├──────────────────────────────────────┤
 3 │ services/ (9 файл)                   │
   ├──────────────────────────────────────┤
 2 │ transport/ (whatspro.client)         │
   ├──────────────────────────────────────┤
 1 │ utils/ (language, magicLink)         │
   ├──────────────────────────────────────┤
 0 │ types/ instructions (no runtime dep) │
   └──────────────────────────────────────┘
```

## Dependency Graph

```
server.ts
├── routes/whatsappWebhook.route.ts
│   ├── agent/fastfoodAgent
│   │   ├── agent/instructions.ts (leaf)
│   │   ├── agent/finalValidator.ts
│   │   ├── context/buildFactsPrompt
│   │   └── skills/index
│   │       ├── skills/searchMenu
│   │       │   └── services/dle.service
│   │       │       └── services/redis.service
│   │       ├── skills/payment → services/dle.service
│   │       ├── skills/crm → services/dle.service
│   │       ├── skills/escalation
│   │       │   ├── services/nocodb.service
│   │       │   │   ├── services/redis.service
│   │       │   │   └── ai (gpt-4o-mini)
│   │       │   ├── services/redis.service
│   │       │   └── transport/whatspro.client
│   │       ├── skills/menuLink → services/redis.service
│   │       └── skills/tavilySearch → fetch
│   ├── context/preloadContext
│   │   ├── utils/language
│   │   ├── utils/magicLink
│   │   ├── services/dle.service
│   │   ├── services/nocodb.service
│   │   └── services/redis.service
│   ├── services/redis.service
│   ├── services/inboundGuard.service
│   │   └── services/redis.service
│   ├── services/kanbanSync.service → axios
│   ├── services/developerNotify.service
│   │   ├── services/nocodb.service
│   │   └── transport/whatspro.client
│   ├── services/tenantAuth.service (leaf)
│   ├── services/mediaAnalysis.service → fetch
│   └── transport/whatspro.client → axios
├── routes/system.route.ts
│   ├── services/dle.service
│   ├── services/nocodb.service
│   ├── services/redis.service
│   ├── services/diagnostics.service
│   │   ├── services/redis.service
│   │   └── axios
│   ├── services/tenantAuth.service
│   ├── transport/whatspro.client
│   └── services/developerNotify.service
└── cron/statsCron.ts
    ├── services/redis.service
    ├── services/dle.service
    └── services/nocodb.service
```

---

# 3. Data Flow

## WhatsApp → Жауап (Full Lifecycle)

```
1. POST /webhook/whatsapp
2. verifySecret() — глобал токен немесе tenant secret
3. guardIncomingMessage() — 10 гвард (spam, dup, mute, etc.)
4. preloadContext() — 8 параллель сұрау
   ├── getRestaurantConfig (NocoDB, 5min cache, 7d backup)
   ├── getUserLang (Redis, 12h TTL)
   ├── getChatHistory (Redis, 120 items, 7d)
   ├── getActiveShiftNotes (Redis SCAN, 24h)
   ├── hasMagicLinkBeenSent (Redis, 30d)
   ├── getRuntimeStatus (DLE api_bot.php, 5s cache, 10min backup)
   ├── getOrderStatus (DLE, 24h cache)
   └── getShporContext (NocoDB, 1h cache)
5. mediaAnalysis (егер media бар болса → gemini-2.5-flash-lite)
6. syncKanbanEvent → n8n (async fire-and-forget)
7. saveToHistory → Redis
8. Pre-LLM short-circuit (runtime жоқ + kitchen сұрағы → fallback)
9. runFastFoodAgent()
   ├── instructions.ts + FACTS_CONTEXT + tools → LLM
   ├── max 6 tool steps
   └── output: { text, hasLink, link, rawText, usage, finishReason }
10. validateFinalText()
    ├── stripBotTags
    ├── delivery area check
    ├── language purity
    ├── runtime unavailable → kitchen block
    ├── wait_time=0 → strip wait sentences
    ├── no active order → block order status
    ├── menu-only → strip unrelated
    ├── magic link dedup
    └── enforce max 2 sentences
11. saveToHistory → Redis
12. evaluateForShpor → gpt-4o-mini (async)
13. sendWhatsProResponseSequence()
    ├── split 650 char chunks
    ├── typing presence + delay
    └── send per chunk
14. hasLink → send separate message
15. markInboundDone → Redis (24h)
```

## DLE (PHP) Data Flow

```
Bot (Node.js)                    DLE (PHP)                  MySQL
     │                              │                         │
     │── POST /api_bot.php ─────────→│                         │
     │   { action: "get_runtime_status", token, restaurant_id }│
     │                              │── SELECT spa_settings ──→│
     │                              │←── settings (JSON) ──────│
     │←── { kitchen_status,         │                         │
     │      is_accepting_orders,    │                         │
     │      payment_details, ... }  │                         │
```

## SPA Интернет-магазин (DLE Plugin)

Толық checkout flow:
1. spa_api.php?action=get_menu → кэштелген мәзір
2. Cookie-based auth (phone + signature)
3. POST checkout → kitchen_status тексеру → emergency block → wait_time consent → bonus validation → order INSERT → n8n webhook
4. Принтер тікелей Node.js-ке POST /api/print_trigger (https://openbot.alemi.kz)

---

# 4. Redis Usage (18 Key Patterns)

| Префикс | Түрі | TTL | Рөлі |
|---------|------|-----|------|
| `history:` | List | 7d | Сөйлесу тарихы |
| `lang:` | String | 12h | Тіл кэші |
| `has_sent_link:` | String | 30d | Сілтеме жіберілді ме |
| `shift_note:` | String | 24h | Ауысым жазбасы |
| `runtime_status:` | String | 5s | Асхана статусы |
| `runtime_status_backup:` | String | 10min | Fallback |
| `config:` | String | 5min | Ресторан конфигі |
| `config_backup:` | String | 7d | Fallback |
| `menu_context:` | String | 5min | Мәзір кэші |
| `menu_context_backup:` | String | 1d | Fallback |
| `shpor_context_100:` | String | 1h | Shpor кэші |
| `spam:` | Counter | 1min | Спам есептегіш |
| `mute:` | String | 15min | Блок |
| `anti_dup:` | String | 5s | Дубликат хэш |
| `msg_done:` | String | 24h | Өңделген |
| `msg_processing:` | String | 3min | Lock |
| `complaint_media:` | String | 5min | Шағым медиасы |
| `media_context:` | String | 1min | Медиа контекст |
| `daily_logs:` | List | 2d | Есептер |

---

# 5. Weak Points

## Архитектуралық

| # | Мәселе | Сипаттама | Қауіп |
|---|--------|-----------|-------|
| 1 | **No message queue** | Барлық webhook setImmediate арқылы өңделеді | Жоғары жүктемеде event loop бітеліп қалуы мүмкін |
| 2 | **Single-process Node.js** | Ешқандай cluster/worker жоқ | CPU-bound операцияда (LLM) басқа request-тер күтіп қалады |
| 3 | **No circuit breaker** | DLE/NocoDB сәтсіздік кезінде қайталау жоқ | Cascading failure |
| 4 | **No request timeout chain** | Әрбір компонентте жеке timeout, бірақ жалпы timeout жоқ | Webhook 30+ секундқа ілініп қалуы мүмкін |
| 5 | **Cron setTimeout chain** | statsCron.ts setTimeout арқылы жұмыс істейді | Сервер қайта іске қосылғанда cron жоғалады |
| 6 | **No graceful shutdown** | process.on('SIGTERM') жоқ | Redis lock-тар тазаланбай қалады |

## Қауіпсіздік

| # | Мәселе | Сипаттама |
|---|--------|-----------|
| 7 | **No input validation on OpenRouter response** | GPT-4o-mini шығарған мәтін тікелей NocoDB-ге сақталады |
| 8 | **Redis password in URL** | REDIS_URL ішінде пароль ашық тұр |
| 9 | **No request body size limit validation** | 15MB limit бар, бірақ минималды чек жоқ |
| 10 | **No message signing** | WhatsApp хабарламаларының integrity check жоқ |

## Надежность

| # | Мәселе | Сипаттама |
|---|--------|-----------|
| 11 | **Shpor evaluation fire-and-forget** | Ешқандай retry немесе dead letter queue жоқ |
| 12 | **Developer notification single-path** | Тек WhatsApp арқылы хабарлама — егер WhatsPro өлі болса, notify жоғалады |
| 13 | **No health check on DLE** | Diagnostics DLE-ді тексермейді |
| 14 | **Kanban webhook response ignored** | n8n жауабы өңделмейді |
| 15 | **daily_logs біртіндеп өседі** | Ешқандай cleanup механизмі жоқ |

## Мониторинг

| # | Мәселе | Сипаттама |
|---|--------|-----------|
| 16 | **Тек console.log** | Structured logging, log levels, JSON logs жоқ |
| 17 | **No metrics** | Prometheus counters, histograms жоқ |
| 18 | **No distributed tracing** | Request lifecycle бақыланбайды |
| 19 | **No error aggregation** | Sentry/DataDog т.б. жоқ |

---

# 6. Technical Debt

| # | Міндет | Файл | Баға |
|---|--------|------|------|
| 1 | `safeRedis<T>(fallback, fn)` әр жерде catch жұтады — қателерді жасырады | redis.service.ts | Жоғары |
| 2 | `setImmediate` — webhook асинхронды, бірақ error handling `res.status(202)` жіберілгеннен кейін болады | whatsappWebhook.route.ts:256 | Орташа |
| 3 | `any` типтері көп (ctx.runtimeStatus, ctx.config т.б.) — TypeScript толық пайдаланылмаған | Барлық жерде | Орташа |
| 4 | `hardRealtimeContext.stale` — runtime stale болуы мүмкін, бірақ stale flag әрдайым reliable емес | preloadContext.ts:92 | Орташа |
| 5 | Magic link regex-те mojibake (кириллица UTF-8 байттары) — көшіру қатесі | magicLink.ts:2-4 | Төмен |
| 6 | `console.warn/warn` екеуі де қолданылған (typo: warn vs warn) | inboundGuard.service.ts:366 | Төмен |
| 7 | DLE PHP-де `Ssl verifypeer false` — бұл security issue емес (internal network), бірақ кодта қалған | api_bot.php:700-701 | Төмен |
| 8 | Cookie-based auth для SPA — signature небәрі 1 сөзден тұратын salt | spa-internet-magazin.xml:131 | Орташа |
| 9 | daily_logs: нақты TTL expires, бірақ ешкім оқымайды | redis.service.ts:162-172 | Төмен |
| 10 | `process.env` қайта-қайта оқылады — startup-та бір рет оқып, config объектісіне салған дұрыс | Барлық файлдар | Орташа |

---

# 7. Scalability Risks

| # | Тәуекел | Себебі | Шешім |
|---|---------|--------|-------|
| 1 | **100 restaurants** жеткенде NocoDB 100-record limit shpor үшін жетпейді | nocodb.service.ts:206 | Pagination + жақсырақ кэш |
| 2 | Redis SCAN shift_note:* — 1000+ restaurant + 1000+ key = 1M+ key scan | redis.service.ts:216-224 | Lua script немесе Redis Stream |
| 3 | LLM қатарынан 6 tool step — 1 request = 30+ секунд | fastfoodAgent.ts:25 | maxSteps қысқарту немесе параллель |
| 4 | Әрбір webhook 8 параллель сыртқы сұрау — upstream жүйелерге жүктеме | preloadContext.ts:44-65 | Connection pooling + rate limit |
| 5 | Redis single-node — SPOF | .env | Redis Sentinel/Cluster |
| 6 | Socket.IO принтер — белгілі бір серверге tied | server.ts | Redis adapter негізіндегі Socket.IO |

---

# 8. Security Risks

| # | Қауіп | Дәреже | Түзету |
|---|-------|--------|--------|
| 1 | SSRF protection тек DLE үшін, басқа сыртқы сұрауларда жоқ | Жоғары | Tavily, NocoDB, OpenRouter да тексеру керек |
| 2 | NocoDB xc-token ашық — егер токен ұрланса, барлық конфиг қолжетімді | Жоғары | Tenant-level API ключ |
| 3 | GPT-4o-mini шығарған мәтінді SQL injection-ге тексермей NocoDB-ге сақтау | Орташа | Sanitize LLM output |
| 4 | Redis пароль .env файлында ашық | Орташа | Docker secrets / encrypted env |
| 5 | Шағым медиасы base64 Redis-те 5 минут — үлкен файлдар Redis жадын алады | Төмен | Уақытша файл негізінде сақтау |

---

# 9. Improvement Opportunities

## Жақын арада (1-2 апта)

1. **Structured logging** — console.log → pino/bunyan
2. **Graceful shutdown** — process.on('SIGTERM') + Redis lock cleanup
3. **Request timeout** — 20 секундтық жалпы webhook timeout
4. **LLM output sanitization** — NocoDB-ге сақтар алдында тексеру
5. **Docker healthcheck** — READY endpoint + liveness probe

## Орта мерзім (1-2 ай)

6. **Message queue** — Bull/BullMQ немесе Redis Stream
7. **Circuit breaker** — Opossum для DLE/NocoDB
8. **Metrics** — Prometheus histograms
9. **Redis Cluster** — Horizontal scaling
10. **Request tracing** — OpenTelemetry
11. **Тесттер** — unit (vitest) + integration (supertest)

## Ұзақ мерзім (3-6 ай)

12. **Multi-process** — cluster модулі немесе PM2
13. **GraphQL API** — skills үшін
14. **Tenant isolation** — әрбір ресторанға жеке Redis namespace
15. **A/B testing framework** — промпттарды тестілеу үшін
16. **Auto-scaling** — Horizontal Pod Autoscaler (Kubernetes)

---

# 10. Missing Information Checklist

Төмендегі ақпараттар қажет. Әрқайсысы үшін **неге керек**, **қай компонентке керек**, **Required/Optional** деп көрсетілген.

| # | Не | Неге керек | Компонент | Міндетті |
|---|-----|-----------|-----------|----------|
| 1 | **NocoDB Restaurant Config толық схемасы** | getRestaurantConfig қай өрістерді қайтаратынын білу; типті қатайту үшін | context/types.ts, preloadContext.ts | Required |
| 2 | **NocoDB Shpor таблицасының толық схемасы** | ideal_answer JSON құрылымын, катгориялар тізімін білу | nocodb.service.ts | Required |
| 3 | **DLE spa_settings толық тізімі** | kitchen_status, payment_details, work_start/work_end т.б. нақты өрістер | dle.service.ts, api_bot.php | Required |
| 4 | **Нақты WhatsApp трафик** (күніне қанша хабар, peak MPS) | Rate limiting, auto-scaling есептеу үшін | server.ts, inboundGuard | Required |
| 5 | **Docker Compose / EasyPanel конфигурациясы** | Deployment архитектурасын түсіну, Redis/NocoDB орналасуын білу | Барлық инфра | Required |
| 6 | **Redis persistence конфигурациясы** (RDB/AOF, snapshot frequency) | Деректердің жоғалу қаупін бағалау | redis.service.ts | Required |
| 7 | **Принтер құрылғысы/желісі** | Socket.IO reliability, reconnection логикасын түсіну | system.route.ts | Optional |
| 8 | **n8n workflow .json файлдары** | Kanban webhook-тан не келетінін, shift_note логикасын түсіну | system.route.ts, kanbanSync.service.ts | Required |
| 9 | **Chatwoot adapter конфигурациясы** | diagnostics.service.ts-те сілтеме бар, бірақ ешқайда қолданылмайды | diagnostics.service.ts | Optional |
| 10 | **SSL/TLS терминациясы** | Traefik/Nginx/Caddy? | Инфрақұрылым | Required |
| 11 | **Monitoring/Alerting** (Prometheus/Grafana, Uptime Kuma, т.б.) | Өнімділікті бақылау, alert-тар | Инфрақұрылым | Required |
| 12 | **Backup стратегиясы** | Redis, NocoDB, MySQL backup | Infra | Required |
| 13 | **CI/CD pipeline** | Deploy процесін түсіну | Infra | Optional |
| 14 | **Тесттер** (қандай да бір тесттер бар ма?) | Регрессияны болдырмау | Барлық модуль | Optional |
| 15 | **Әрбір ресторанның жұмыс уақыты, жеңілдіктері** | LLM контекстіне қосу үшін | NocoDB, Бот промп.txt | Optional |
| 16 | **Kaspi/Halyk нақты төлем интеграциясы** | payment_details көрінбесе не болады | payment.skill.ts | Optional |
| 17 | **WhatsApp Business API шектеулері** (24h window, template) | Marketing хабарламалары жіберу үшін | whatspro.client.ts | Optional |
| 18 | **Mute/Block/Complaint auto-escalation иерархиясы** | Шағымдар қайда түседі, кім өңдейді | escalation.skill.ts | Required |
| 19 | **License management** (SPA license_until) | Bot өшіп қалмас үшін | spa-internet-magazin.xml | Optional |
| 20 | **Developers командасы** (кім, қанша адам) | Code review, on-call ротация | — | Optional |
