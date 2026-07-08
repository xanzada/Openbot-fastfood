# System Architecture: BekzatAI SaaS Platform

> **Нұсқа:** 2.0
> **Соңғы жаңарту:** 2026-06-22
> **Автор:** BekzatAI Engineering

BekzatAI — коммерческая SaaS платформа для ресторанов быстрого питания. Предоставляет AI-ассистента для автоматизации общения с клиентами через WhatsApp, интеграцию с CRM и системами управления заказами.

---

## 1. Қысқаша сипаттама

Бұл компонент — WhatsApp хабарламаларын қабылдайтын, LLM (OpenRouter арқылы) өңдейтін және WhatsPro API арқылы жауап жіберетін Express 5 HTTP сервері. Сервер 4100 портында жұмыс істейді, Redis кэш ретінде, NocoDB конфигурация/мәзір дерекқоры ретінде, DLE сыртқы API ретінде пайдаланылады. Платформа multi-tenant архитектурасында жұмыс істейді — әр мейрамхана жеке tenant болып табылады, әр tenant үшін жеке конфигурация, rate limit және биллинг қолданылады.

## 2. Component Diagram

```
WhatsApp User
     │
     ▼
┌─────────────────────────────────────────────────┐
│              WhatsPro Cloud API                  │
│  (Webhook → POST /webhook/whatsapp)              │
└─────────────────────┬───────────────────────────┘
                      │
                      ▼
┌─────────────────────────────────────────────────────┐
│              Express Server (port 4100)              │
│                                                      │
│  ┌──────────────┐  ┌──────────────┐  ┌───────────┐  │
│  │ Authentication│  │ Rate Limiter │  │ Spam      │  │
│  │ Middleware    │→ │ (Redis)      │→ │ Detector  │  │
│  └──────────────┘  └──────────────┘  └─────┬─────┘  │
│                                           │          │
│  ┌───────────────────┐                   │          │
│  │ Pre-LLM Short-    │◄──────────────────┘          │
│  │ Circuit (Layer 2) │                              │
│  └─────────┬─────────┘                              │
│            │                                        │
│  ┌─────────▼─────────┐  ┌──────────────────────┐    │
│  │ Preload Context   │  │ LLM Router           │    │
│  │ (Redis + NocoDB)  │→ │ (OpenRouter Client)  │    │
│  └───────────────────┘  └──────────┬───────────┘    │
│                                    │                │
│  ┌───────────────────┐           │                │
│  │ Post-LLM          │◄──────────┘                │
│  │ finalValidator.ts │                            │
│  │ (Layer 3)         │                            │
│  └─────────┬─────────┘                            │
│            │                                      │
│  ┌─────────▼─────────┐                            │
│  │ WhatsPro Client   │                            │
│  │ (send response)   │                            │
│  └───────────────────┘                            │
└─────────────────────┬───────────────────────────────┘
                      │
                      ▼
┌─────────────────────────────────────────────────────┐
│ External Systems                                      │
│                                                      │
│  ┌──────────┐  ┌──────────┐  ┌────────────────────┐  │
│  │  Redis   │  │ NocoDB   │  │ OpenRouter (LLM)    │  │
│  │ (Кэш)    │  │ (Config  │  │ gemini-2.5-flash    │  │
│  │          │  │ + Shpor) │  │ gpt-4o-mini         │  │
│  └──────────┘  └──────────┘  └────────────────────┘  │
│                                                      │
│  ┌────────────────────────────────────────────┐      │
│  │  DLE API (dle-api.php — 7 actions)         │      │
│  │  print_trigger, kanban-webhook             │      │
│  └────────────────────────────────────────────┘      │
└───────────────────────────────────────────────────────┘
```

## 3. Dependency Graph

```
src/
├── agent/
│   ├── instructions.ts          ← 10 hard rules (Layer 1)
│   ├── finalValidator.ts        ← post-LLM validation (Layer 3)
│   └── fastfoodAgent.ts         ← VoltAgent adapter
├── context/
│   ├── types.ts                 ← FastFoodContext интерфейсі
│   ├── preloadContext.ts        ← Redis/NocoDB контекст кэші
│   └── buildFactsPrompt.ts      ← dynamic facts (Layer 4)
├── services/
│   ├── redis.service.ts         ← Redis клиент + барлық операциялар
│   ├── nocodb.service.ts        ← NocoDB клиент + shpor
│   ├── dle.service.ts           ← DLE API клиент (7 actions)
│   ├── inboundGuard.service.ts  ← Spam mute + rate limiting
│   ├── kanbanSync.service.ts    ← Kanban оқиғаларын синхрондау
│   ├── mediaAnalysis.service.ts ← Медиа файлдарды талдау
│   ├── diagnostics.service.ts   ← Health check + startup diagnostics
│   ├── tenantAuth.service.ts    ← Tenant-level аутентификация
│   └── developerNotify.service.ts ← Developer-ге қате туралы хабарлау
├── skills/
│   ├── index.ts                 ← Барлық skill-дерді біріктіру
│   ├── menuLink.skill.ts        ← Мәзір сілтемесін жіберу
│   ├── searchMenu.skill.ts      ← DLE мәзірін іздеу
│   ├── payment.skill.ts         ← Төлем реквизиттері + чек регистрация
│   ├── crm.skill.ts             ← CRM лидтерін жаңарту
│   ├── escalation.skill.ts      ← Админге эскалация (шағымдар)
│   └── tavilySearch.skill.ts    ← Веб іздеу (Tavily API)
├── transport/
│   └── whatspro.client.ts       ← WhatsPro API клиенті (send + presence + chunks)
├── routes/
│   ├── whatsappWebhook.route.ts ← Негізгі webhook (Layer 2 short-circuit)
│   └── system.route.ts          ← /health, /health/detailed, /kanban-webhook, /api/print_trigger
├── utils/
│   ├── magicLink.ts             ← URL extraction + resend regex
│   └── language.ts              ← Тіл анықтау (detectLangWithFallback)
├── cron/
│   └── statsCron.js             ← Күнделікті статистика cron
├── server.ts                    ← Express entry point (port 4100, Socket.io)
├── 26-billing                   ← Billing Service (metering, plans, invoices)
├── 27-plugin-system             ← Plugin Manager + AI Skills Marketplace
├── 28-feature-flags             ← Feature Flag Service
└── 02-adr/ADR-003-saas-architecture.md ← архитектура
```

## 4. API Contract

### Inbound

| Әдіс | Дереккөз | Формат | Кэш |
|------|----------|--------|-----|
| POST /webhook/whatsapp | WhatsPro Cloud | JSON (body: token, instance, phone, event, message) | Жоқ |
| POST /kanban-webhook | n8n | JSON | Жоқ |
| POST /api/print_trigger | DLE | JSON | Жоқ |
| GET /health | Кез келген | JSON | Жоқ |
| GET /health/detailed | Ішкі мониторинг | JSON | Жоқ (5s cache) |

### Outbound

| Әдіс | Бағыт | Формат | Timeout |
|------|-------|--------|---------|
| POST /send/message | WhatsPro API | JSON | 10s |
| POST /v1/chat/completions | OpenRouter API | JSON (streaming) | 30s |
| GET /api/v1/{action} | DLE API | JSON | 5s |
| GET /api/v2/tables/{table}/records | NocoDB API | JSON | 5s |
| Redis commands | Redis | RESP | 2s |

## 5. Data Flow

```
WhatsApp → WhatsPro → Express Webhook
  → 1. Webhook Auth (verifySecret — global webhook secret → tenant auth)
  → 2. fromMe Check (оператор хабары → auto-mute → saveToHistory → END)
  → 3. guardIncomingMessage (spam mute, rate limit, operator override)
     ├── Blocked → 202 accepted:false → END
     └── Pass → continue
  → 4. PreloadContext:
        ├── Redis: {instance}:config, {instance}:shpor, chat history, lang, shift notes, magic link
        ├── DLE: runtime status, order status
        └── NocoDB: shpor context (menu items)
  → 5. Video Check → if video: "видео қабылдай алмаймын" → END
  → 6. Media Analysis → if complaint: save base64 + escalate
  → 7. kanbanSync → syncKanbanEvent
  → 8. Pre-LLM Short-Circuit (runtimeUnavailableReply)
     ├── Runtime unavailable + kitchen question → fallback → END
     └── Pass → continue
  → 9. LLM Call (VoltAgent: OpenRouter, 30s timeout, maxSteps=6)
  → 10. Post-LLM Validation (finalValidator.ts: validateFinalText)
        ├── Delivery area check → delivery reply
        ├── Language purity → fallback
        ├── Runtime unavailable + kitchen mention → runtimeUnavailableText
        ├── wait_time=0 → strip wait sentences
        ├── No active order → noActiveOrderText
        ├── Menu-only question → strip unrelated topics
        ├── Magic link dedup → strip link
        └── Sentence limit → enforceMaxSentences(2)
  → 11. Save to History (assistant)
  → 12. evaluateForShpor (async — NocoDB-ге faq сақтау)
  → 13. Send Response Sequence (WhatsPro Client — chunks with typing delay)
  → 14. Send Link Separately (if hasLink && link)
  → 15. Billing Metering → Redis INCR `billing:{instance}:messages:{date}`, update token usage counter
  → 16. markInboundDone → END
```

## 6. SaaS Components

### 6.1 Billing Service (26-billing)

- **Plan Management** — тарифтік жоспарларды басқару (Starter/Business/Enterprise)
- **Usage Metering** — әр tenant үшін хабарлама санын және LLM токендарын есепке алу (Redis INCR)
- **Payment Gateway** — төлем жүйесімен интеграция (Kaspi, карта)
- **Invoices** — ай сайынғы шот-фактураларды генерациялау

### 6.2 Plugin Manager (27-plugin-system)

- **Plugin Lifecycle** — орнату, іске қосу, тоқтату, жаңарту, жою
- **Sandbox** — әр plugin оқшауланған ортада іске қосылады
- **Hooks** — webhook event stream арқылы plugin-дерге оқиғаларды жіберу
- **Marketplace** — AI Skills Marketplace — үшінші тарап plugin-дерін орнату

### 6.3 Feature Flags (28-feature-flags)

- **Global** — барлық tenant-тарға ортақ флагтар
- **Tenant Override** — жеке tenant үшін флагты өзгерту
- **Phased Rollout** — tenant-тардың белгілі бір пайызына жаңа мүмкіндіктерді кезең-кезеңмен жіберу
- **Kill Switch** — ақаулық кезінде мүмкіндікті дереу өшіру

### 6.4 Prompt Versioning

- **Per-Tenant** — әр tenant өзінің prompt нұсқасын пайдалана алады
- **Version History** — v1-ден v4-ке дейінгі нұсқалар қолдау көрсетіледі
- **A/B Testing** — әр түрлі tenant-тарда әр түрлі prompt нұсқаларын сынау

## 7. Multi-Tenant Architecture

- **Tenant Identification** — әр tenant `instance` өрісі арқылы идентификацияланады (body.instance / query.instance)
- **Redis Key Prefix Isolation** — барлық Redis кілттері `{instance}:*` префиксімен сақталады, бұл tenant-тар арасындағы деректерді толық оқшаулауды қамтамасыз етеді
- **NocoDB Row-Level Filter** — NocoDB сұрауларында `WHERE instance = ?` шарты қолданылады, әр tenant тек өз деректерін көреді
- **Plan-Based Rate Limits**:
  - **Starter** — 500 хабарлама/ай, 15 req/min, 1 admin
  - **Business** — 5000 хабарлама/ай, 30 req/min, 5 admin
  - **Enterprise** — шексіз хабарлама, 60 req/min, шексіз admin

## 8. Scaling Strategy

| Кезең | Tenant саны | Архитектура |
|-------|-------------|-------------|
| **Startup** | 1–100 | Shared Redis + Shared NocoDB, бір Express инстанс |
| **Growth** | 100–500 | Redis Cluster + NocoDB read replicas, PM2 cluster (4 worker) |
| **Scale** | 500–2000 | Redis Cluster + dedicated NocoDB per shard, горизонтальды масштабтау (8+ инстанс) |
| **Enterprise** | 2000+ | Региональды шардинг (kz/ru/other), geo-DNS, dedicated инфрақұрылым |

## 9. Error Handling

| Қате сценарийі | Әрекет | Fallback |
|----------------|--------|----------|
| Redis disconnected | Startup warning, reconnect loop | Redis жоқ кезде NocoDB-дан тікелей оқу, бірақ NocoDB rate limit 100 req/min |
| OpenRouter 5xx | VoltAgent maxSteps=6, модель ауыстыру | Static fallback: finalValidator.ts → `fallback()` |
| NocoDB unavailable | preloadContext-те `.catch(() => null)` | Redis кэшіндегі ескі деректер (stale flag) |
| WhatsPro timeout | 10s timeout, қайталау жоқ | `[OPENBOT:WHATSPRO:FAIL]` лог, developer notify |
| LLM hallucination | finalValidator.ts validateFinalText → fallback | `fallback(ctx)` — "Қалай көмектесе аламын? 😊" |
| Spam (>6 messages) | inboundGuard.service.ts → Mute 15 мин | "Сіз тым көп хабарлама жібердіңіз" |
| Kanban webhook error | notifyKanbanDeveloperSiren → WhatsApp арқылы developer-ге | Developer-ге SMS: "CRITICAL DLE KANBAN ERROR" |
| Video message | WhatsApp: "видео қабылдай алмаймын" | Мәтінмен сипаттауды сұрау |

## 10. Cache Strategy

| Кілт | TTL | Backup TTL | Мақсаты |
|------|-----|------------|---------|
| `{instance}:config` | 300s | 3600s | NocoDB tenant конфигурациясы (name, domain, work_hours, kaspi_info, delivery_areas, admin_phone, developer) |
| `{instance}:shpor` | 120s | 600s | Мәзір деректері (NocoDB shpor таблицасы) |
| `ratelimit:{instance}:{phone}` | 60s | — | Rate limit counter (sliding window) |
| `spam:{instance}:{phone}` | 900s | — | Spam mute (15 min) |
| `context:{instance}:{phone}:history` | 600s | — | LLM conversation history (соңғы 8 хабар) |
| `magiclink:{instance}:{phone}` | 30 күн | — | Magic link жіберілгенін белгілеу |
| `complaint:{instance}:{phone}:media` | 3600s | — | Шағым медиа файлдары |
| `shift:notes:{instance}` | 3600s | — | Ауысым жазбалары |
| `operator_mute:{instance}:{phone}` | 300s | — | Оператор auto-mute (fromMe) |
| `health:dismissed` | 3600s | — | Dismissed health alerts |

## 11. Security

- **Аутентификация:** Global webhook secret (`OPENBOT_WEBHOOK_SECRET` / `CRM_SECRET_TOKEN`) → Bearer header / x-api-key / body.token → tenant auth (`assertTenantSecret` — NocoDB config-тағы secret)
- **Авторизация:** Tenant-level изоляция (Redis prefix `{instance}:*`, NocoDB row-level `WHERE instance = ?`)
- **SSRF қорғаныс:** DNS allowed list (.env), тек NocoDB + OpenRouter + DLE + WhatsPro
- **Rate limiting:** 15 req/min/tenant, 6+ spam → 15 min mute (inboundGuard.service.ts)
- **Secrets:** .env файлында, кодта ешқашан
- **Developer notify:** Қате кезінде developer-ге WhatsApp хабарлама (notifyDeveloperSystemFailure)

## 12. Monitoring

- **Metrics:** request rate, error rate (4xx/5xx), LLM latency (p50/p95/p99), token usage, Redis hit rate, active tenants
- **Alerts:** error rate > 5% for 5 min, LLM timeout > 30s, Redis down, NocoDB unavailable
- **Logs:** stdout JSON structured logging: `{ timestamp, level, tenant, phone, event, latency_ms, error }`

## 13. Known Limitations

- Single-process — масштабтау үшін PM2 cluster немесе горизонтальды көшірмелер қажет
- LLM retry механизмі жоқ (VoltAgent maxSteps=6, бірақ модель ауыстыру автоматты емес)
- Ешқандай dead letter queue жоқ — өңделмеген хабарлар жоғалады
- NocoDB — rate лимиттелген (100 req/min), үлкен жүктемеде cache-ке сүйенеді
- LLM температурасы 0.7 — creativity мен accuracy арасындағы trade-off
- Webhook ответ 202 accepted (асинхронды) — клиентке жауап кешігуі мүмкін
- Video файлдар қабылданбайды (text only)

---

_Author: BekzatAI EOS_
