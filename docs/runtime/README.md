# Runtime Execution Flow

## Startup Flow

```
server.ts
├── dotenv/config (env жүктеу)
├── connectRedis() → Redis-ке қосылу
│   └── fail: warning, сервер жұмысын жалғастырады
├── startDailyCron() → setTimeout chain
├── httpServer.listen(port)
└── logStartupDiagnostics()
    ├── getConfigSummary() → env конфиг көрсету
    └── runDependencyChecks()
        ├── checkRedis() → PING
        ├── checkNocoDB() → GET /records (limit:1)
        ├── checkWhatsPro() → GET /health
        └── checkChatwoot() → егер конфигурацияланса
```

## WhatsApp Message Lifecycle

```
1. POST /webhook/whatsapp
2. verifySecret()
   ├── Authorization: Bearer || x-api-key || body.token
   └── NocoDB tenant secret (арнайы конфиг)
3. isOwnWhatsAppMessage()? → fromMe: skip
4. guardIncomingMessage()
   ├── fromMe check
   ├── bad_instance (regex: /^[a-zA-Z0-9_-]{2,64}$/)
   ├── bad_phone (regex: /^\d{10,15}$/)
   ├── private_contact_keyword (28+ keyword)
   ├── saved_contact (егер BOT_IGNORE_SAVED_CONTACTS=true)
   ├── duplicate_done (msg_done key)
   ├── duplicate_processing (NX lock, 3min)
   ├── operator_mute (max 5min)
   ├── duplicate_text (SHA1 hash, 5s window)
   └── spam_limit (15/min, mute 15min)
5. preloadContext()
   ├── getRestaurantConfig(instanceId) → NocoDB (5min cache, 7d backup)
   ├── getUserLang(instanceId, phone) → Redis (12h TTL)
   ├── getChatHistory(instanceId, phone) → Redis list (120 max, 7d TTL)
   ├── getActiveShiftNotes(instanceId) → Redis scan (24h TTL)
   ├── hasMagicLinkBeenSent(instanceId, phone) → Redis (30d TTL)
   ├── detectLangWithFallback(text, lang)
   │   ├── storedLang → тікелей
   │   ├── regex (кириллица/латын) → "kk" if Kazakh chars
   │   └── gpt-4o-mini → "ru" or "kk"
   ├── getRuntimeStatus(instanceId, domain) → DLE (5s cache, 10min backup)
   ├── getOrderStatus(instanceId, phone, domain) → DLE (24h cache)
   └── getShporContext(instanceId, text) → NocoDB (1h cache)
6. Media Processing
   ├── video → reject immediately
   ├── image/audio/pdf → analyzeMedia()
   │   ├── model: gemini-2.5-flash-lite
   │   ├── temperature: 0
   │   └── returns: receipt | complaint | reply | technical_error
   └── complaint → saveComplaintMedia() (Redis, 5min)
7. syncKanbanEvent() → n8n webhook (async)
8. saveToHistory() → Redis list
9. Pre-LLM short-circuit: егер runtime жоқ және kitchen сұраса → fallback
10. runFastFoodAgent(ctx)
    ├── instructions.ts (10 rules)
    ├── FACTS_CONTEXT JSON
    ├── 7 tools
    ├── model: gemini-2.5-flash
    └── maxSteps: 6
11. validateFinalText(result)
    ├── stripBotTags()
    ├── delivery area check
    ├── language purity
    ├── runtime unavailable → kitchen block
    ├── wait_time=0 → wait sentence removal
    ├── no activeOrder → order mention block
    ├── menu-only → unrelated topic strip
    ├── magic link dedup
    └── enforceMaxSentences(2)
12. saveToHistory() → Redis
13. evaluateForShpor() (async)
    ├── gpt-4o-mini
    ├── save? bool
    ├── category: complaint | complex_order | faq | trash
    └── confidence >= 0.45 → save to NocoDB
14. sendWhatsProResponseSequence()
    ├── splitWhatsProResponse() → 650 char chunks
    ├── typing presence (1.5-3s delay)
    └── send per chunk
15. hasLink → send separate message
16. markInboundDone() → Redis (24h)
```

## LLM Request Lifecycle

```
1. Instructions (10 rules) + FACTS_CONTEXT JSON → system prompt
2. Customer text → user message
3. Agent.generateText()
4. LLM → tool call немесе тікелей жауап
5. Tool execution → result → LLM
6. LLM → final text
7. validateFinalText()
8. Output
```

## Cron Jobs

### statsCron.ts
- setTimeout chain (нақты cron кітапханасыз)
- ANALYTICS_CRON_EXPR (default: "59 23 * * *") — күнді жабатын жүріс
- ANALYTICS_TIMEZONE (default: "Asia/Almaty") — тенант конфигінде `timezone` болса, ол басым
- ANALYTICS_BACKFILL_DAYS (default: 7) — қуып жетуге рұқсат етілген артқы күндер
- ANALYTICS_RECONCILE_INTERVAL_MS (default: 6 сағат) — кепілдік жүрісінің аралығы
- ANALYTICS_BOOT_DELAY_MS (default: 90000) — көтерілгеннен кейінгі бірінші жүріс
- ANALYTICS_MODEL / ANALYTICS_MODEL_TIMEOUT_MS — күндік талдау моделі
- Әр ресторан, әр жетпеген күн үшін:
  1. `crm.today.get` → hub лидтері
  2. `metrics:<instance>:<YYYYMMDD>` → нақты санауыштар
  3. `readLearningNotes()` → ішкі ақаулар
  4. `buildDailyAnalyticsRow()` → сандар фактіден, мәтін моделден (құламаса — эвристикадан)
  5. `analytics.daily.upsert` → hub-тың 14 өрісі
  6. `analytics:sent:<instance>` → күн жабылса «жеткен» деп белгілеу

## Error Handling

| Қабат | Стратегия |
|-------|-----------|
| Redis | safeRedis<T>(fallback, fn) — қате кетсе fallback қайтарады |
| DLE | Cache-first, network-second, stale-backup-third |
| NocoDB | Cache-first, network-second, stale-backup-third |
| Inbound | clearInboundProcessing() — lock тазалау |
| Agent | finishReason арқылы қате анықтау |
| Webhook | notifyDeveloperSystemFailure → WhatsApp әзірлеушіге |
| Global | try/catch әр деңгейде |

## Retry Logic

Жүйеде explicit retry механизмі жоқ. Қайталау тек cache арқылы жүзеге асады:
- Егер DLE сұрауы сәтсіз болса → stale backup қолданылады
- Келесі вебхук келгенде қайта сұралады
