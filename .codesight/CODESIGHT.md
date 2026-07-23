# openbot-agent — AI Context Map

> **Stack:** express, php | none | unknown | typescript

> 5 routes (1 inferred) | 0 models | 0 components | 32 lib files | 66 env vars | 0 middleware | 42 events
> **Token savings:** this file is ~0 tokens. Without it, AI exploration would cost ~0 tokens. **Saves ~0 tokens per conversation.**
> **Last scanned:** 2026-07-23 06:52 — re-run after significant changes

---

# Routes

- `GET` `io` [db, cache, payment] `[inferred]`
- `POST` `/` params() [auth, payment]
- `GET` `/health` params() [auth, payment]
- `GET` `/health/detailed` params() [auth, payment]
- `POST` `/api/print_trigger` params() [auth, payment]

---

# Libraries

- `src\agent\fastfoodAgent.ts` — function runFastFoodAgent: (ctx) => void
- `src\agent\finalValidator.ts` — function validateFinalText: (rawText, ctx) => void
- `src\agent\modelRouter.ts` — function getTextModelId: () => void, function resolveModel: (_ctx) => void
- `src\agent\persona.ts` — function buildTenantInstructionsFromConfig: (config, any>, instanceId) => void, function buildTenantInstructions: (ctx) => void
- `src\context\buildFactsPrompt.ts` — function buildFactsPrompt: (ctx) => string
- `src\context\preloadContext.ts`
  - function preloadContext: (input) => Promise<FastFoodContext>
  - interface InboundMessage
  - interface ContextHealth
- `src\controllers\kanban.ts`
  - function buildLegacyNewOrderMessage: (body, unknown>, lang, orderId, isPickup) => string
  - function formatLegacyPaymentMessage: (totalAmount, paymentInfo, lang) => string
  - function buildLegacyRejectedMessage: (body, unknown>, lang) => string
  - function handleKanbanWebhook: (req, res) => Promise<void>
  - const legacyStatusTemplates: Record<Language, Record<string, string>>
- `src\cron\statsCron.ts` — function processDailyAnalytics: () => void, function startDailyCron: () => void
- `src\services\auditLogger.service.ts`
  - function isNewDleAction: (action) => boolean
  - function auditInbound: (message, fields, unknown>) => void
  - function auditProcessing: (message, fields, unknown>) => void
  - function auditDecision: (message, fields, unknown>) => void
  - function auditOutbound: (message, fields, unknown>) => void
  - function auditError: (message, error, fields, unknown>) => void
- `src\services\complaintRouting.service.ts`
  - function hasEscalateAdminSignal: (text) => void
  - function hasEscalateDeveloperSignal: (text) => void
  - function stripEscalationSignals: (text) => void
  - function isLikelyComplaintText: (text) => void
  - function buildComplaintClarificationReply: (language) => void
  - function buildComplaintAckReply: (language) => void
  - _...5 more_
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
  - _...12 more_
- `src\services\inboundGuard.service.ts`
  - function extractMessageId: (body) => string
  - function extractInboundText: (body) => string
  - function extractSenderMeta: (body) => void
  - function extractInboundMedia: (body) => InboundMediaContext | null
  - function getBase64Media: (body, mediaContext) => void
  - function hydrateInboundMedia: (body, mediaContext) => Promise<InboundMediaContext | null>
  - _...8 more_
- `src\services\kanbanSync.service.ts` — function syncKanbanEvent: (ctx, event, any>) => Promise<
- `src\services\llm.service.ts`
  - function getMediaPrimaryKeys: () => void
  - function getTextModels: () => TextModelPair
  - function getMediaPrimaryModel: () => void
  - function getMediaFallbackModel: () => void
  - function getOpenRouterProvider: () => void
  - function callGemini: (request) => void
  - _...6 more_
- `src\services\mediaAnalysis.service.ts`
  - function receiptFilterEnabled: (env, string | undefined>) => void
  - function validateReceiptAnalysis: (analysis, any>, context) => void
  - function createReceiptFingerprint: (base64Media, analysis, any>) => void
  - function analyzeMedia: (base64Media, mimeType, caption, userLang, isPdf, systemPrompt, receiptContext) => void
  - interface ReceiptValidationContext
- `src\services\nocodb.service.ts`
  - function getRestaurantConfig: (instanceId) => Promise<Record<string, any> | null>
  - function getAllRestaurantConfigs: () => Promise<Record<string, any>[]>
  - function getRestaurantConfigByWhatsAppPhone: (phone) => Promise<Record<string, any> | null>
  - function getShporContext: (instanceId, query) => Promise<any[]>
  - function saveToShpor: (instanceId, question, answer, category, memoryPayload, any> | null) => Promise<void>
  - function evaluateForShpor: (question, answer) => Promise<
- `src\services\redis.service.ts`
  - function getRedisTarget: () => void
  - function connectRedis: () => Promise<void>
  - function pingRedis: () => Promise<string>
  - function getChatHistory: (instanceId, phone) => Promise<any[]>
  - function saveToHistory: (instanceId, phone, role, text, meta, unknown>) => Promise<void>
  - function languageKey: (instanceId, phone) => void
  - _...24 more_
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
- `src\skills\payment.skill.ts` — function createGetPaymentDetailsSkill: (ctx) => void
- `src\skills\runtimeStatus.skill.ts` — function createGetKitchenStatusSkill: (ctx) => void, function createGetShiftNotesSkill: (ctx) => void
- `src\skills\searchMenu.skill.ts` — function createSearchMenuSkill: (ctx) => void
- `src\skills\tavilySearch.skill.ts` — function searchWeb: (query, options) => void, function createTavilySearchSkill: (_ctx) => void
- `src\transport\whatspro.client.ts`
  - function splitWhatsProResponse: (text) => string[]
  - function sendWhatsProMessage: (payload) => void
  - function sendWhatsProPresence: (payload) => void
  - function sendWhatsProResponseSequence: (payload) => void
- `src\utils\language.ts`
  - function detectLang: (text, storedLang?) => "kk" | "ru"
  - function resolveLockedLanguage: (storedLang, detected) => "kk" | "ru"
  - function detectLanguageWithAI: (text) => Promise<"kk" | "ru">
  - function detectLangWithFallback: (text, storedLang?) => Promise<"kk" | "ru">
- `src\utils\magicLink.ts`
  - function normalizeMenuDomain: (domain) => string | null
  - function generateSecureMenuUrl: (domain, phone, tenantSecret) => string | null
  - function isMenuLinkResendRequest: (text) => boolean
  - function hasExplicitMenuLinkIntent: (text) => boolean

---

# Config

## Environment Variables

- `ADMIN_PHONE` **required** — src\services\complaintRouting.service.ts
- `ANALYTICS_CRON_EXPR` (has default) — .env.example
- `ANALYTICS_TIMEZONE` (has default) — .env.example
- `BOT_IGNORE_SAVED_CONTACTS` (has default) — .env.example
- `CHATWOOT_ADAPTER_URL` **required** — src\services\diagnostics.service.ts
- `CRM_SECRET_TOKEN` **required** — .env.example
- `DEVELOPER_PHONE` **required** — .env
- `DLE_WEBHOOK_AUTH_REQUIRED` (has default) — .env.example
- `DLE_WEBHOOK_PATH` **required** — src\server.ts
- `DLE_WEBHOOK_SECRET` **required** — .env.example
- `ENABLE_AUTO_FAILOVER` (has default) — .env
- `ENABLE_KEY_ROTATION` (has default) — .env
- `ENABLE_MODEL_ROTATION` (has default) — .env
- `GEMINI_API_KEY_1` **required** — .env
- `GEMINI_API_KEY_2` **required** — .env
- `GEMINI_API_KEY_3` **required** — .env
- `GEMINI_API_KEY_4` **required** — .env
- `GEMINI_API_KEY_5` **required** — .env
- `GEMINI_API_KEY_6` **required** — .env
- `GEMINI_API_KEYS` **required** — src\services\llm.service.ts
- `GEMINI_MAX_RETRIES` (has default) — .env
- `GEMINI_MEDIA_MODEL` (has default) — .env
- `GEMINI_MODEL` (has default) — .env
- `GEMINI_ROTATION_ENABLED` (has default) — .env
- `LLM_FALLBACK_PROVIDER` (has default) — .env
- `LLM_PROVIDER` (has default) — .env
- `MAX_RETRY_PER_KEY` (has default) — .env
- `MEDIA_FALLBACK_MODEL` (has default) — .env.example
- `MEDIA_PRIMARY_KEYS` **required** — .env.example
- `MEDIA_PRIMARY_MODEL` (has default) — .env.example
- `N8N_WEBHOOK_TIMEOUT_MS` (has default) — .env.example
- `N8N_WEBHOOK_TOKEN` **required** — .env.example
- `N8N_WEBHOOK_URL` **required** — .env.example
- `NOCODB_SHPOR_TABLE_ID` **required** — src\services\nocodb.service.ts
- `NOCODB_TABLE_ID` **required** — .env.example
- `NOCODB_TOKEN` **required** — .env.example
- `NOCODB_URL` **required** — .env.example
- `OPENAI_API_KEY` (has default) — .env
- `OPENAI_BASE_URL` (has default) — .env
- `OPENBOT_MAX_MEDIA_BYTES` (has default) — .env.example
- `OPENBOT_RESPONSE_CHUNK_MAX` (has default) — .env.example
- `OPENBOT_SPAM_LIMIT_PER_MINUTE` (has default) — .env.example
- `OPENBOT_SPAM_MUTE_SECONDS` (has default) — .env.example
- `OPENBOT_WEBHOOK_SECRET` **required** — .env.example
- `OPENROUTER_API_KEY` **required** — .env.example
- `OPENROUTER_FALLBACK_ENABLED` (has default) — .env
- `OPENROUTER_MEDIA_MODEL` (has default) — .env
- `OPENROUTER_MODEL` (has default) — .env
- `OPERATOR_ACTIVE_SECONDS` (has default) — .env.example
- `OPERATOR_MUTE_MAX_SECONDS` (has default) — .env.example
- `PORT` (has default) — .env.example
- `PRIVATE_CONTACT_KEYWORDS` (has default) — .env.example
- `RECEIPT_AI_FILTER_ENABLED` (has default) — .env.example
- `REDIS_URL` (has default) — .env.example
- `SHPOR_CONTEXT_LIMIT` **required** — src\services\nocodb.service.ts
- `TAVILY_API_KEY` **required** — .env.example
- `TEST_MODE_ENABLED` (has default) — .env.example
- `TEXT_FALLBACK_MODEL` (has default) — .env.example
- `TEXT_PRIMARY_MODEL` (has default) — .env.example
- `WHATSPRO_API_TOKEN` **required** — .env.example
- `WHATSPRO_BASE_URL` **required** — .env.example
- `WHATSPRO_PASSWORD` (has default) — .env
- `WHATSPRO_PRESENCE_URL` **required** — .env.example
- `WHATSPRO_SEND_URL` **required** — .env.example
- `WHATSPRO_USER` (has default) — .env
- `WHATSPRO_WEBHOOK_PATH` **required** — src\server.ts

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

- `src\context\types.ts` — imported by **18** files
- `src\services\nocodb.service.ts` — imported by **11** files
- `src\services\dle.service.ts` — imported by **9** files
- `src\services\redis.service.ts` — imported by **9** files
- `src\services\developerNotify.service.ts` — imported by **4** files
- `src\transport\whatspro.client.ts` — imported by **4** files
- `src\services\auditLogger.service.ts` — imported by **4** files
- `src\services\llm.service.ts` — imported by **4** files
- `src\services\tenantAuth.service.ts` — imported by **3** files
- `src\utils\language.ts` — imported by **2** files
- `src\services\diagnostics.service.ts` — imported by **2** files
- `src\context\buildFactsPrompt.ts` — imported by **1** files
- `src\skills\index.ts` — imported by **1** files
- `src\agent\instructions.ts` — imported by **1** files
- `src\agent\finalValidator.ts` — imported by **1** files
- `src\agent\modelRouter.ts` — imported by **1** files
- `src\agent\persona.ts` — imported by **1** files
- `src\utils\magicLink.ts` — imported by **1** files
- `src\controllers\kanban.ts` — imported by **1** files
- `src\context\preloadContext.ts` — imported by **1** files

## Import Map (who imports what)

- `src\context\types.ts` ← `src\agent\fastfoodAgent.ts`, `src\agent\finalValidator.ts`, `src\agent\modelRouter.ts`, `src\agent\persona.ts`, `src\context\buildFactsPrompt.ts` +13 more
- `src\services\nocodb.service.ts` ← `src\context\preloadContext.ts`, `src\controllers\kanban.ts`, `src\cron\statsCron.ts`, `src\routes\dleWebhook.route.ts`, `src\routes\system.route.ts` +6 more
- `src\services\dle.service.ts` ← `src\context\preloadContext.ts`, `src\controllers\kanban.ts`, `src\cron\statsCron.ts`, `src\routes\whatsappWebhook.route.ts`, `src\skills\checkOrderStatus.skill.ts` +4 more
- `src\services\redis.service.ts` ← `src\cron\statsCron.ts`, `src\server.ts`, `src\services\complaintRouting.service.ts`, `src\services\diagnostics.service.ts`, `src\services\inboundGuard.service.ts` +4 more
- `src\services\developerNotify.service.ts` ← `src\controllers\kanban.ts`, `src\routes\dleWebhook.route.ts`, `src\routes\system.route.ts`, `src\routes\whatsappWebhook.route.ts`
- `src\transport\whatspro.client.ts` ← `src\controllers\kanban.ts`, `src\routes\whatsappWebhook.route.ts`, `src\services\complaintRouting.service.ts`, `src\services\developerNotify.service.ts`
- `src\services\auditLogger.service.ts` ← `src\controllers\kanban.ts`, `src\routes\dleWebhook.route.ts`, `src\services\dle.service.ts`, `src\transport\whatspro.client.ts`
- `src\services\llm.service.ts` ← `src\routes\whatsappWebhook.route.ts`, `src\services\diagnostics.service.ts`, `src\services\mediaAnalysis.service.ts`, `src\utils\language.ts`
- `src\services\tenantAuth.service.ts` ← `src\routes\dleWebhook.route.ts`, `src\routes\system.route.ts`, `src\routes\whatsappWebhook.route.ts`
- `src\utils\language.ts` ← `src\context\preloadContext.ts`, `test\languageAndReceipt.test.ts`

---

# Events & Queues

- `Payment details resolved` [event] — `src/controllers/kanban.ts`
- `Complaint notification skipped: admin phone missing` [event] — `src/controllers/kanban.ts`
- `Print trigger skipped: status is not paid` [event] — `src/controllers/kanban.ts`
- `Print trigger emitted for paid status` [event] — `src/controllers/kanban.ts`
- `print_new_order` [event] — `src/controllers/kanban.ts`
- `Print trigger skipped: socket server unavailable` [event] — `src/controllers/kanban.ts`
- `Print trigger skipped: action is not new_order` [event] — `src/controllers/kanban.ts`
- `Print trigger emitted for new order` [event] — `src/controllers/kanban.ts`
- `Saving bot notification to Redis history` [event] — `src/controllers/kanban.ts`
- `Rejected webhook: invalid instance` [event] — `src/controllers/kanban.ts`
- `Rejected webhook: invalid action` [event] — `src/controllers/kanban.ts`
- `Updating kitchen status in Redis` [event] — `src/controllers/kanban.ts`
- `Kitchen status updated` [event] — `src/controllers/kanban.ts`
- `Reading kitchen status from Redis` [event] — `src/controllers/kanban.ts`
- `Kitchen status read complete` [event] — `src/controllers/kanban.ts`
- `Loading restaurant config` [event] — `src/controllers/kanban.ts`
- `Restaurant config loaded` [event] — `src/controllers/kanban.ts`
- `Triggering developer alert` [event] — `src/controllers/kanban.ts`
- `Routing complaint to admin` [event] — `src/controllers/kanban.ts`
- `Complaint routing complete` [event] — `src/controllers/kanban.ts`
- `Rejected webhook: invalid order id` [event] — `src/controllers/kanban.ts`
- `Rejected webhook: invalid phone` [event] — `src/controllers/kanban.ts`
- `Order payload validated` [event] — `src/controllers/kanban.ts`
- `Shift note payload detected` [event] — `src/controllers/kanban.ts`
- `Connecting Redis for lock and memory operations` [event] — `src/controllers/kanban.ts`
- `Attempting idempotency lock` [event] — `src/controllers/kanban.ts`
- `Found existing order/signal lock; ignoring duplicate` [event] — `src/controllers/kanban.ts`
- `Creating new processing record via Redis lock` [event] — `src/controllers/kanban.ts`
- `Saving shift note to AI memory` [event] — `src/controllers/kanban.ts`
- `Shift note saved` [event] — `src/controllers/kanban.ts`
- `Deleting shift note from AI memory` [event] — `src/controllers/kanban.ts`
- `Shift note deleted` [event] — `src/controllers/kanban.ts`
- `Building new_order WhatsApp template` [event] — `src/controllers/kanban.ts`
- `Building request_payment WhatsApp template` [event] — `src/controllers/kanban.ts`
- `Building order_rejected WhatsApp template` [event] — `src/controllers/kanban.ts`
- `Resolving status_changed template` [event] — `src/controllers/kanban.ts`
- `Status ignored: no client template configured` [event] — `src/controllers/kanban.ts`
- `Triggering WhatsApp notification path` [event] — `src/controllers/kanban.ts`
- `Cleaning completed/cancelled order Redis history` [event] — `src/controllers/kanban.ts`
- `No outbound WhatsApp template produced` [event] — `src/controllers/kanban.ts`
- `Kanban webhook processed successfully` [event] — `src/controllers/kanban.ts`
- `Releasing idempotency lock after failure` [event] — `src/controllers/kanban.ts`

---

_Generated by [codesight](https://github.com/Houseofmvps/codesight) — see your codebase clearly_