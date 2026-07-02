# openbot-agent — AI Context Map

> **Stack:** express | none | unknown | typescript

> 5 routes | 0 models | 0 components | 20 lib files | 23 env vars | 0 middleware | 1 events
> **Token savings:** this file is ~2 300 tokens. Without it, AI exploration would cost ~17 700 tokens. **Saves ~15 400 tokens per conversation.**
> **Last scanned:** 2026-07-02 08:06 — re-run after significant changes

---

# Routes

- `GET` `/health` params() [auth, cache, payment]
- `GET` `/health/detailed` params() [auth, cache, payment]
- `POST` `/kanban-webhook` params() [auth, cache, payment]
- `POST` `/api/print_trigger` params() [auth, cache, payment]
- `POST` `/webhook/whatsapp` params() [auth, cache, payment]

---

# Libraries

- `src\agent\fastfoodAgent.ts` — function runFastFoodAgent: (ctx) => void
- `src\agent\finalValidator.ts` — function validateFinalText: (rawText, ctx) => string
- `src\context\buildFactsPrompt.ts` — function buildFactsPrompt: (ctx) => string
- `src\context\preloadContext.ts` — function preloadContext: (input) => Promise<FastFoodContext>, interface InboundMessage
- `src\services\developerNotify.service.ts` — function notifyDeveloperSystemFailure: (instanceId, error, meta, unknown>) => Promise<boolean>
- `src\services\diagnostics.service.ts`
  - function getConfigSummary: () => void
  - function runDependencyChecks: () => void
  - function logStartupDiagnostics: () => void
- `src\services\dle.service.ts`
  - function normalizePhone: (value) => void
  - function normalizeRuntimeStatus: (data, any>) => void
  - function getRuntimeStatus: (instanceId, domain, options) => Promise<Record<string, any> | null>
  - function getOrderStatus: (instanceId, phone, domain) => void
  - function getMenuContext: (instanceId, domain, userLang) => void
  - function updateCrmAction: (actionType, instanceId, phone, data, any>) => void
- `src\services\inboundGuard.service.ts`
  - function extractMessageId: (body) => string
  - function extractInboundText: (body) => string
  - function extractInboundMedia: (body) => InboundMediaContext | null
  - function guardIncomingMessage: (input) => Promise<GuardResult>
  - function markInboundDone: (instanceId, messageId?) => Promise<void>
  - function clearInboundProcessing: (instanceId, messageId?) => Promise<void>
  - _...4 more_
- `src\services\kanbanSync.service.ts` — function syncKanbanEvent: (ctx, event, any>) => Promise<
- `src\services\nocodb.service.ts`
  - function getRestaurantConfig: (instanceId) => Promise<Record<string, any> | null>
  - function getShporContext: (instanceId, query) => Promise<any[]>
  - function saveToShpor: (instanceId, question, answer, category) => Promise<void>
- `src\services\redis.service.ts`
  - function getRedisTarget: () => void
  - function connectRedis: () => Promise<void>
  - function pingRedis: () => Promise<string>
  - function getChatHistory: (instanceId, phone) => Promise<any[]>
  - function saveToHistory: (instanceId, phone, role, text, meta, unknown>) => Promise<void>
  - function getUserLang: (instanceId, phone) => Promise<"kk" | "ru" | null>
  - _...10 more_
- `src\skills\crm.skill.ts` — function createUpdateCrmLeadSkill: (ctx) => void
- `src\skills\escalation.skill.ts` — function createEscalateToAdminSkill: (ctx) => void
- `src\skills\index.ts` — function createFastFoodSkills: (ctx) => void
- `src\skills\menuLink.skill.ts` — function createSendMenuLinkSkill: (ctx) => void
- `src\skills\payment.skill.ts` — function createGetPaymentDetailsSkill: (ctx) => void, function createRegisterPaymentReceiptSkill: (ctx) => void
- `src\skills\searchMenu.skill.ts` — function createSearchMenuSkill: (ctx) => void
- `src\transport\whatspro.client.ts`
  - function splitWhatsProResponse: (text) => string[]
  - function sendWhatsProMessage: (payload) => void
  - function sendWhatsProPresence: (payload) => void
  - function sendWhatsProResponseSequence: (payload) => void
- `src\utils\language.ts` — function detectLang: (text, storedLang?) => "kk" | "ru"
- `src\utils\magicLink.ts` — function buildMagicLink: (domain, phone) => string | null, function hasExplicitMenuLinkIntent: (text) => boolean

---

# Config

## Environment Variables

- `CHATWOOT_ADAPTER_URL` **required** — src\services\diagnostics.service.ts
- `CRM_SECRET_TOKEN` **required** — .env.example
- `N8N_WEBHOOK_TIMEOUT_MS` (has default) — .env.example
- `N8N_WEBHOOK_TOKEN` **required** — .env.example
- `N8N_WEBHOOK_URL` **required** — .env.example
- `NOCODB_SHPOR_TABLE_ID` **required** — .env.example
- `NOCODB_TABLE_ID` **required** — .env.example
- `NOCODB_TOKEN` **required** — .env.example
- `NOCODB_URL` **required** — .env.example
- `OPENBOT_MAX_MEDIA_BYTES` (has default) — .env.example
- `OPENBOT_RESPONSE_CHUNK_MAX` (has default) — .env.example
- `OPENBOT_SPAM_LIMIT_PER_MINUTE` (has default) — .env.example
- `OPENBOT_SPAM_MUTE_SECONDS` (has default) — .env.example
- `OPENBOT_WEBHOOK_SECRET` **required** — .env.example
- `OPENROUTER_AGENT_MODEL` (has default) — .env.example
- `OPENROUTER_API_KEY` **required** — .env.example
- `PORT` (has default) — .env.example
- `REDIS_URL` (has default) — .env.example
- `SHPOR_CONTEXT_LIMIT` (has default) — .env.example
- `WHATSPRO_API_TOKEN` **required** — .env.example
- `WHATSPRO_BASE_URL` **required** — .env.example
- `WHATSPRO_PRESENCE_URL` **required** — .env.example
- `WHATSPRO_SEND_URL` **required** — .env.example

## Config Files

- `.env.example`
- `Dockerfile`
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

- `src\context\types.ts` — imported by **11** files
- `src\services\redis.service.ts` — imported by **8** files
- `src\services\dle.service.ts` — imported by **5** files
- `src\services\nocodb.service.ts` — imported by **4** files
- `src\transport\whatspro.client.ts` — imported by **3** files
- `src\services\diagnostics.service.ts` — imported by **2** files
- `src\services\developerNotify.service.ts` — imported by **2** files
- `src\context\buildFactsPrompt.ts` — imported by **1** files
- `src\skills\index.ts` — imported by **1** files
- `src\agent\instructions.ts` — imported by **1** files
- `src\agent\finalValidator.ts` — imported by **1** files
- `src\utils\language.ts` — imported by **1** files
- `src\utils\magicLink.ts` — imported by **1** files
- `src\context\preloadContext.ts` — imported by **1** files
- `src\agent\fastfoodAgent.ts` — imported by **1** files
- `src\services\kanbanSync.service.ts` — imported by **1** files
- `src\routes\whatsappWebhook.route.ts` — imported by **1** files
- `src\routes\system.route.ts` — imported by **1** files
- `src\skills\searchMenu.skill.ts` — imported by **1** files
- `src\skills\payment.skill.ts` — imported by **1** files

## Import Map (who imports what)

- `src\context\types.ts` ← `src\agent\fastfoodAgent.ts`, `src\agent\finalValidator.ts`, `src\context\buildFactsPrompt.ts`, `src\context\preloadContext.ts`, `src\services\kanbanSync.service.ts` +6 more
- `src\services\redis.service.ts` ← `src\routes\system.route.ts`, `src\routes\whatsappWebhook.route.ts`, `src\server.ts`, `src\services\diagnostics.service.ts`, `src\services\dle.service.ts` +3 more
- `src\services\dle.service.ts` ← `src\context\preloadContext.ts`, `src\routes\system.route.ts`, `src\skills\crm.skill.ts`, `src\skills\payment.skill.ts`, `src\skills\searchMenu.skill.ts`
- `src\services\nocodb.service.ts` ← `src\context\preloadContext.ts`, `src\routes\system.route.ts`, `src\services\developerNotify.service.ts`, `src\skills\escalation.skill.ts`
- `src\transport\whatspro.client.ts` ← `src\routes\system.route.ts`, `src\routes\whatsappWebhook.route.ts`, `src\services\developerNotify.service.ts`
- `src\services\diagnostics.service.ts` ← `src\routes\system.route.ts`, `src\server.ts`
- `src\services\developerNotify.service.ts` ← `src\routes\system.route.ts`, `src\routes\whatsappWebhook.route.ts`
- `src\context\buildFactsPrompt.ts` ← `src\agent\fastfoodAgent.ts`
- `src\skills\index.ts` ← `src\agent\fastfoodAgent.ts`
- `src\agent\instructions.ts` ← `src\agent\fastfoodAgent.ts`

---

# Events & Queues

- `print_new_order` [event] — `src/routes/system.route.ts`

---

_Generated by [codesight](https://github.com/Houseofmvps/codesight) — see your codebase clearly_