# openbot-agent — AI Context Map

> **Stack:** express, php | none | unknown | typescript

> 5 routes | 0 models | 0 components | 26 lib files | 52 env vars | 0 middleware | 1 events
> **Token savings:** this file is ~0 tokens. Without it, AI exploration would cost ~0 tokens. **Saves ~0 tokens per conversation.**
> **Last scanned:** 2026-07-16 08:09 — re-run after significant changes

---

# Routes

- `GET` `/health` params() [auth, payment]
- `GET` `/health/detailed` params() [auth, payment]
- `POST` `/kanban-webhook` params() [auth, payment]
- `POST` `/api/print_trigger` params() [auth, payment]
- `POST` `/webhook/whatsapp` params() [auth, cache, payment]

---

# Libraries

- `src\agent\fastfoodAgent.ts` — function runFastFoodAgent: (ctx) => void
- `src\agent\finalValidator.ts` — function validateFinalText: (rawText, ctx) => void
- `src\agent\modelRouter.ts` — function resolveModel: (ctx) => void
- `src\context\buildFactsPrompt.ts` — function buildFactsPrompt: (ctx) => string
- `src\context\preloadContext.ts`
  - function preloadContext: (input) => Promise<FastFoodContext>
  - interface InboundMessage
  - interface ContextHealth
- `src\cron\statsCron.ts` — function processDailyAnalytics: () => void, function startDailyCron: () => void
- `src\services\developerNotify.service.ts` — function notifyDeveloperSystemFailure: (instanceId, error, meta, unknown>) => Promise<boolean>
- `src\services\diagnostics.service.ts`
  - function getConfigSummary: () => void
  - function runDependencyChecks: () => void
  - function logStartupDiagnostics: () => void
- `src\services\dle.service.ts`
  - function isPrivateIp: (ipValue) => void
  - function normalizeKazakhstanPhone: (digits) => void
  - function isGroupOrStatusJid: (value) => void
  - function extractPhoneCandidate: (rawValue) => void
  - function normalizePhone: (value) => void
  - function normalizePhoneFromCandidates: (candidates) => void
  - _...10 more_
- `src\services\inboundGuard.service.ts`
  - function extractMessageId: (body) => string
  - function extractInboundText: (body) => string
  - function extractSenderMeta: (body) => void
  - function extractInboundMedia: (body) => InboundMediaContext | null
  - function getBase64Media: (body, mediaContext) => void
  - function hydrateInboundMedia: (body, mediaContext) => Promise<InboundMediaContext | null>
  - _...8 more_
- `src\services\kanbanSync.service.ts` — function syncKanbanEvent: (ctx, event, any>) => Promise<
- `src\services\mediaAnalysis.service.ts` — function analyzeMedia: (base64Media, mimeType, caption, userLang, isPdf) => void
- `src\services\nocodb.service.ts`
  - function getRestaurantConfig: (instanceId) => Promise<Record<string, any> | null>
  - function getAllRestaurantConfigs: () => Promise<Record<string, any>[]>
  - function getShporContext: (instanceId, query) => Promise<any[]>
  - function saveToShpor: (instanceId, question, answer, category, memoryPayload, any> | null) => Promise<void>
  - function evaluateForShpor: (question, answer) => Promise<
- `src\services\redis.service.ts`
  - function getRedisTarget: () => void
  - function connectRedis: () => Promise<void>
  - function pingRedis: () => Promise<string>
  - function getChatHistory: (instanceId, phone) => Promise<any[]>
  - function saveToHistory: (instanceId, phone, role, text, meta, unknown>) => Promise<void>
  - function getUserLang: (instanceId, phone) => Promise<"kk" | "ru" | null>
  - _...14 more_
- `src\services\tenantAuth.service.ts`
  - function safeCompare: (a, b) => boolean
  - function getIncomingTenantSecret: (req) => void
  - function getTenantSecret: (config, any> | null | undefined, channel) => void
  - function assertTenantSecret: (req, config, any> | null | undefined, channel) => void
- `src\skills\checkOrderStatus.skill.ts` — function createCheckOrderStatusSkill: (ctx) => void
- `src\skills\crm.skill.ts` — function createUpdateCrmLeadSkill: (ctx) => void
- `src\skills\escalation.skill.ts` — function createEscalateToAdminSkill: (ctx) => void
- `src\skills\index.ts` — function createFastFoodSkills: (ctx) => void
- `src\skills\menuLink.skill.ts` — function createSendMenuLinkSkill: (ctx) => void
- `src\skills\payment.skill.ts` — function createGetPaymentDetailsSkill: (ctx) => void, function createRegisterPaymentReceiptSkill: (ctx) => void
- `src\skills\searchMenu.skill.ts` — function createSearchMenuSkill: (ctx) => void
- `src\skills\tavilySearch.skill.ts` — function searchWeb: (query, options) => void, function createTavilySearchSkill: (_ctx) => void
- `src\transport\whatspro.client.ts`
  - function splitWhatsProResponse: (text) => string[]
  - function sendWhatsProMessage: (payload) => void
  - function sendWhatsProPresence: (payload) => void
  - function sendWhatsProResponseSequence: (payload) => void
- `src\utils\language.ts`
  - function detectLang: (text, storedLang?) => "kk" | "ru"
  - function detectLanguageWithAI: (text) => Promise<"kk" | "ru">
  - function detectLangWithFallback: (text, storedLang?) => Promise<"kk" | "ru">
- `src\utils\magicLink.ts`
  - function normalizeMenuDomain: (domain) => string | null
  - function generateSecureMenuUrl: (domain, phone) => string | null
  - function isMenuLinkResendRequest: (text) => boolean
  - function hasExplicitMenuLinkIntent: (text) => boolean

---

# Config

## Environment Variables

- `ANALYTICS_CRON_EXPR` (has default) — .env.example
- `ANALYTICS_TIMEZONE` (has default) — .env.example
- `BOT_IGNORE_SAVED_CONTACTS` (has default) — .env.example
- `CHATWOOT_ADAPTER_URL` **required** — src\services\diagnostics.service.ts
- `CRM_SECRET_TOKEN` **required** — .env.example
- `DEVELOPER_PHONE` **required** — .env.example
- `ENABLE_AUTO_FAILOVER` (has default) — .env
- `ENABLE_KEY_ROTATION` (has default) — .env
- `ENABLE_MODEL_ROTATION` (has default) — .env
- `GEMINI_API_KEY_1` **required** — .env
- `GEMINI_API_KEY_2` **required** — .env
- `GEMINI_API_KEY_3` **required** — .env
- `GEMINI_API_KEY_4` **required** — .env
- `GEMINI_API_KEY_5` **required** — .env
- `GEMINI_API_KEY_6` **required** — .env
- `GEMINI_API_KEYS` **required** — src\agent\modelRouter.ts
- `GEMINI_MAX_RETRIES` (has default) — .env
- `GEMINI_MEDIA_MODEL` (has default) — .env
- `GEMINI_MODEL` (has default) — .env
- `GEMINI_ROTATION_ENABLED` (has default) — .env
- `LLM_FALLBACK_PROVIDER` (has default) — .env
- `LLM_PROVIDER` (has default) — .env
- `MAX_RETRY_PER_KEY` (has default) — .env
- `N8N_WEBHOOK_TIMEOUT_MS` (has default) — .env.example
- `N8N_WEBHOOK_TOKEN` **required** — .env.example
- `N8N_WEBHOOK_URL` **required** — .env.example
- `NOCODB_SHPOR_TABLE_ID` **required** — src\services\nocodb.service.ts
- `NOCODB_TABLE_ID` (has default) — .env.example
- `NOCODB_TOKEN` (has default) — .env.example
- `NOCODB_URL` (has default) — .env.example
- `OPENBOT_MAX_MEDIA_BYTES` (has default) — .env.example
- `OPENBOT_RESPONSE_CHUNK_MAX` (has default) — .env.example
- `OPENBOT_SPAM_LIMIT_PER_MINUTE` (has default) — .env.example
- `OPENBOT_SPAM_MUTE_SECONDS` (has default) — .env.example
- `OPENBOT_WEBHOOK_SECRET` **required** — .env.example
- `OPENROUTER_AGENT_MODEL` (has default) — .env.example
- `OPENROUTER_API_KEY` **required** — .env.example
- `OPENROUTER_FALLBACK_ENABLED` (has default) — .env
- `OPENROUTER_MEDIA_MODEL` (has default) — .env.example
- `OPENROUTER_MODEL` (has default) — .env
- `OPERATOR_MUTE_MAX_SECONDS` (has default) — .env.example
- `PORT` (has default) — .env.example
- `PRIVATE_CONTACT_KEYWORDS` (has default) — .env.example
- `REDIS_URL` (has default) — .env.example
- `SHPOR_CONTEXT_LIMIT` **required** — src\services\nocodb.service.ts
- `TAVILY_API_KEY` **required** — .env.example
- `WHATSPRO_API_TOKEN` **required** — .env.example
- `WHATSPRO_BASE_URL` **required** — .env.example
- `WHATSPRO_PASSWORD` (has default) — .env
- `WHATSPRO_PRESENCE_URL` **required** — .env.example
- `WHATSPRO_SEND_URL` **required** — .env.example
- `WHATSPRO_USER` (has default) — .env

## Config Files

- `.env.example`
- `Dockerfile`
- `docker-compose.yml`
- `tsconfig.json`

## Key Dependencies

- ai: ^6.0.208
- express: ^5.2.1
- redis: ^5.10.0
- socket.io: ^4.8.1
- zod: ^4.4.3

---

# Dependency Graph

## Most Imported Files (change these carefully)

- `src\context\types.ts` — imported by **15** files
- `src\services\redis.service.ts` — imported by **10** files
- `src\services\dle.service.ts` — imported by **9** files
- `src\services\nocodb.service.ts` — imported by **7** files
- `src\transport\whatspro.client.ts` — imported by **5** files
- `src\services\diagnostics.service.ts` — imported by **2** files
- `src\services\tenantAuth.service.ts` — imported by **2** files
- `src\services\developerNotify.service.ts` — imported by **2** files
- `src\context\buildFactsPrompt.ts` — imported by **1** files
- `src\skills\index.ts` — imported by **1** files
- `src\agent\instructions.ts` — imported by **1** files
- `src\agent\finalValidator.ts` — imported by **1** files
- `src\agent\modelRouter.ts` — imported by **1** files
- `src\utils\language.ts` — imported by **1** files
- `src\utils\magicLink.ts` — imported by **1** files
- `src\controllers\kanban.ts` — imported by **1** files
- `src\context\preloadContext.ts` — imported by **1** files
- `src\agent\fastfoodAgent.ts` — imported by **1** files
- `src\services\kanbanSync.service.ts` — imported by **1** files
- `src\services\mediaAnalysis.service.ts` — imported by **1** files

## Import Map (who imports what)

- `src\context\types.ts` ← `src\agent\fastfoodAgent.ts`, `src\agent\finalValidator.ts`, `src\agent\modelRouter.ts`, `src\context\buildFactsPrompt.ts`, `src\context\preloadContext.ts` +10 more
- `src\services\redis.service.ts` ← `src\controllers\kanban.ts`, `src\cron\statsCron.ts`, `src\routes\whatsappWebhook.route.ts`, `src\server.ts`, `src\services\diagnostics.service.ts` +5 more
- `src\services\dle.service.ts` ← `src\context\preloadContext.ts`, `src\controllers\kanban.ts`, `src\cron\statsCron.ts`, `src\routes\system.route.ts`, `src\routes\whatsappWebhook.route.ts` +4 more
- `src\services\nocodb.service.ts` ← `src\context\preloadContext.ts`, `src\controllers\kanban.ts`, `src\cron\statsCron.ts`, `src\routes\system.route.ts`, `src\routes\whatsappWebhook.route.ts` +2 more
- `src\transport\whatspro.client.ts` ← `src\controllers\kanban.ts`, `src\routes\system.route.ts`, `src\routes\whatsappWebhook.route.ts`, `src\services\developerNotify.service.ts`, `src\skills\escalation.skill.ts`
- `src\services\diagnostics.service.ts` ← `src\routes\system.route.ts`, `src\server.ts`
- `src\services\tenantAuth.service.ts` ← `src\routes\system.route.ts`, `src\routes\whatsappWebhook.route.ts`
- `src\services\developerNotify.service.ts` ← `src\routes\system.route.ts`, `src\routes\whatsappWebhook.route.ts`
- `src\context\buildFactsPrompt.ts` ← `src\agent\fastfoodAgent.ts`
- `src\skills\index.ts` ← `src\agent\fastfoodAgent.ts`

---

# Events & Queues

- `print_new_order` [event] — `src/routes/system.route.ts`

---

_Generated by [codesight](https://github.com/Houseofmvps/codesight) — see your codebase clearly_