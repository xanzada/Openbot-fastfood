# openbot-agent — AI Context Map

> **Stack:** express, php | none | unknown | typescript

> 7 routes (1 inferred) | 0 models | 0 components | 48 lib files | 96 env vars | 0 middleware | 44 events
> **Token savings:** this file is ~0 tokens. Without it, AI exploration would cost ~0 tokens. **Saves ~0 tokens per conversation.**
> **Last scanned:** 2026-08-02 17:44 — re-run after significant changes

---

# Routes

- `GET` `io` [db, cache, payment] `[inferred]`
- `POST` `/` params() [auth, payment]
- `GET` `/health` params() [auth, cache, payment]
- `GET` `/health/detailed` params() [auth, cache, payment]
- `POST` `/api/maintenance/language` params() [auth, cache, payment]
- `POST` `/api/maintenance/notes` params() [auth, cache, payment]
- `POST` `/api/print_trigger` params() [auth, cache, payment]

---

# Libraries

- `src\agent\fastfoodAgent.ts` — function runFastFoodAgent: (ctx) => void
- `src\agent\finalValidator.ts` — function validateFinalText: (rawText, ctx, grounding?) => void
- `src\agent\modelRouter.ts` — function getTextModelId: () => void, function resolveModel: (_ctx) => void
- `src\agent\persona.ts` — function buildTenantInstructionsFromConfig: (config, any>, instanceId) => void, function buildTenantInstructions: (ctx) => void
- `src\agent\toolPolicy.ts`
  - function resolveAgentToolPlan: (ctx) => AgentToolPlan
  - function createAgentStepPolicy: (plan) => void
  - interface AgentToolPlan
  - type AgentToolName
- `src\context\buildFactsPrompt.ts`
  - function tenantInstructionsEntry: (config, any>) => void
  - function compactConversationHistory: (history) => void
  - function buildFactsPrompt: (ctx) => string
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
- `src\services\agentThinking.service.ts`
  - function shouldThink: (ctx, toolPlan?) => boolean
  - function analyzeTurnSituation: (ctx, toolPlan?) => Promise<TurnAnalysis | null>
  - function critiqueDraftReply: (input) => Promise<DraftCritique | null>
  - interface TurnAnalysis
  - interface DraftCritique
- `src\services\auditLogger.service.ts`
  - function isNewDleAction: (action) => boolean
  - function auditInbound: (message, fields, unknown>) => void
  - function auditProcessing: (message, fields, unknown>) => void
  - function auditDecision: (message, fields, unknown>) => void
  - function auditOutbound: (message, fields, unknown>) => void
  - function auditError: (message, error, fields, unknown>) => void
- `src\services\bufferBrain.service.ts`
  - function mergePartsDeterministic: (parts) => string
  - function needsSmartMerge: (parts) => boolean
  - function mergeBufferedParts: (parts, language) => Promise<string>
- `src\services\complaintRouting.service.ts`
  - function hasEscalateAdminSignal: (text) => void
  - function hasEscalateDeveloperSignal: (text) => void
  - function stripEscalationSignals: (text) => void
  - function isLikelyComplaintText: (text) => void
  - function isLikelyOperatorRequestText: (text) => void
  - function complaintHasActionableDetail: (text) => void
  - _...9 more_
- `src\services\customerMemory.service.ts`
  - function profileKey: (instanceId, phone) => void
  - function conversationSummaryKey: (instanceId, phone) => void
  - function getCustomerProfile: (instanceId, phone) => Promise<CustomerProfile | null>
  - function getConversationSummary: (instanceId, phone) => Promise<ConversationSummary | null>
  - function saveCustomerProfile: (instanceId, phone, profile) => Promise<void>
  - function saveConversationSummary: (instanceId, phone, summary) => Promise<void>
  - _...6 more_
- `src\services\customerOrder.service.ts`
  - function classifyOrderStage: (status, aiComment) => CustomerOrderStage
  - function describeOrderStage: (stage, language) => void
  - function describeOrderStatus: (status, language, aiComment) => void
  - function customerOrderFromRecord: (value, any>|null|undefined, expectedPhone, language) => CustomerOrderLookup
  - function orderMentionedByItems: (context, any>|null|undefined, text) => void
  - function pickConversationOrder: (context, any>|null|undefined, discussedNumber) => void
  - _...7 more_
- `src\services\developerNotify.service.ts` — function notifyDeveloperSystemFailure: (instanceId, error, meta, unknown>) => Promise<boolean>, function notifyAllDevelopersSystemFailure: (error, meta, unknown>) => Promise<number>
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
  - _...13 more_
- `src\services\goalTracker.service.ts`
  - function goalKey: (instanceId, phone) => void
  - function getActiveGoal: (instanceId, phone) => Promise<ActiveGoal | null>
  - function saveActiveGoal: (instanceId, phone, goal) => Promise<void>
  - function resolveGoalKind: (ctx, analysis) => GoalKind
  - function updateGoalAfterTurn: (input) => Promise<void>
  - interface ActiveGoal
  - _...2 more_
- `src\services\inboundGuard.service.ts`
  - function extractMessageId: (body) => string
  - function extractInboundText: (body) => string
  - function extractSenderMeta: (body) => void
  - function extractInboundMedia: (body) => InboundMediaContext | null
  - function safeMediaMetadata: (mediaContext) => void
  - function detectOggOpusDurationSeconds: (base64Value) => void
  - _...21 more_
- `src\services\kanbanSync.service.ts` — function syncKanbanEvent: (ctx, event, any>) => Promise<
- `src\services\kitchenPolicy.service.ts`
  - function formatKitchenWait: (minutesValue, language) => void
  - function classifyKitchenSalesPolicy: (runtime, any> | null, nowMs) => void
  - function detectKitchenConsentAnswer: (text) => "yes" | "no" | "unknown"
  - function detectRequestedServiceChannel: (text) => "delivery" | "pickup" | "unknown"
  - interface KitchenSalesPolicy
  - type KitchenSalesMode
- `src\services\languagePolicy.service.ts`
  - function textCarriesDecisiveLanguageSignal: (text, language) => void
  - function shouldSwitchLockedLanguage: (lockedLanguage, previousCustomerLanguage, currentCustomerLanguage, currentTextIsDecisive) => void
  - function normalizeSiteLanguage: (value) => CustomerLanguage | null
  - function resolveSiteOutboundLanguage: (lockedLanguage, payloadLanguage, siteLanguageHint) => CustomerLanguage
  - function detectNameLanguage: (name) => CustomerLanguage | null
  - function resolveOrganicLanguage: (input) => void
  - _...1 more_
- `src\services\learningLoop.service.ts`
  - function learningEventsKey: (instanceId) => void
  - function recordLearningEvent: (instanceId, event, "at">) => Promise<void>
  - function readLearningEvents: (instanceId, limit) => Promise<LearningEvent[]>
  - interface LearningEvent
- `src\services\llm.service.ts`
  - function getMediaPrimaryKeys: () => void
  - function getTextModels: () => TextModelChain
  - function getMediaPrimaryModel: () => void
  - function getMediaFallbackModel: () => void
  - function getMediaProKeys: () => void
  - function getMediaProModel: () => void
  - _...10 more_
- `src\services\mediaAnalysis.service.ts`
  - function receiptFilterEnabled: (env, string | undefined>) => void
  - function validateReceiptAnalysis: (analysis, any>, context) => void
  - function createReceiptFingerprint: (base64Media, analysis, any>) => void
  - function analyzeMedia: (base64Media, mimeType, caption, userLang, isPdf, systemPrompt, receiptContext) => void
  - interface ReceiptValidationContext
- `src\services\metrics.service.ts`
  - function metricsKey: (instanceId, day) => void
  - function bumpMetric: (instanceId, name, amount) => Promise<void>
  - function recordLatency: (instanceId, elapsedMs) => Promise<void>
  - function snapshotMetrics: (instanceId, days) => Promise<Record<string, Record<string, number>>>
  - type MetricName
- `src\services\noteProvenance.service.ts`
  - function noteConstraintTerms: (text) => string[]
  - function matchingNoteIds: (notes, value) => string[]
  - function noteHistoryMeta: (ctx, value) => void
  - function menuItemBlockedByNotes: (notes, item, any>) => void
  - function publicNoteConstraints: (notes) => void
- `src\services\operatorCase.service.ts`
  - function sosIndexKey: (instanceId) => void
  - function sosMarkerKey: (instanceId, customerPhone) => void
  - function sosUnreadKey: (instanceId, customerPhone) => void
  - function detectOperatorCaseKind: (text) => OperatorCaseKind | null
  - function createOperatorCase: (input) => void
  - function decideCaseFlag: (data, now) => void
  - _...6 more_
- `src\services\platformConfig.service.ts`
  - function normalizeRestaurantConfig: (record, any> | null, expectedInstanceId) => Record<string, any> | null
  - function isTenantBotEnabled: (instanceId) => Promise<boolean>
  - function getRestaurantConfig: (instanceId) => Promise<Record<string, any> | null>
  - function getAllRestaurantConfigs: () => Promise<Record<string, any>[]>
  - function getRestaurantConfigByWhatsAppPhone: (phone) => Promise<Record<string, any> | null>
  - function getShporContext: (instanceId, query) => Promise<any[]>
  - _...2 more_
- `src\services\proactiveSignals.service.ts`
  - function orderSignature: (order, any> | null) => string
  - function statusWord: (order, any> | null) => string
  - function computeProactiveSignals: (ctx) => Promise<ProactiveSignals | null>
  - interface ProactiveSignals
- `src\services\receiptDelivery.service.ts`
  - function deliverReceiptToClient: (input, sendReceipt) => Promise<ReceiptDeliveryResult>
  - interface ReceiptDeliveryInput
  - type ReceiptDeliveryResult
- `src\services\redis.service.ts`
  - function getRedisTarget: () => void
  - function connectRedis: () => Promise<void>
  - function pingRedis: () => Promise<string>
  - function savePendingKitchenConsent: (instanceId, phone, policyFingerprint, kind) => Promise<boolean>
  - function getPendingKitchenConsent: (instanceId, phone) => Promise<
  - function clearPendingKitchenConsent: (instanceId, phone) => Promise<void>
  - _...43 more_
- `src\services\tenantAuth.service.ts`
  - function safeCompare: (a, b) => boolean
  - function getIncomingTenantSecret: (req) => void
  - function getTenantSecret: (config, any> | null | undefined, channel) => void
  - function assertTenantSecret: (req, config, any> | null | undefined, channel) => void
- `src\skills\businessInfo.skill.ts` — function createGetBusinessInfoSkill: (ctx) => void
- `src\skills\checkOrderStatus.skill.ts` — function createCheckOrderStatusSkill: (ctx) => void
- `src\skills\crm.skill.ts` — function createUpdateCrmLeadSkill: (ctx) => void
- `src\skills\escalation.skill.ts` — function buildHandoffDigest: (ctx, reason) => string, function createEscalateToAdminSkill: (ctx) => void
- `src\skills\index.ts` — function createFastFoodSkills: (ctx) => void, const FAST_FOOD_SKILL_NAMES
- `src\skills\menuLink.skill.ts` — function createSendMenuLinkSkill: (ctx) => void
- `src\skills\payment.skill.ts` — function createGetPaymentDetailsSkill: (ctx) => void
- `src\skills\runtimeStatus.skill.ts` — function createGetKitchenStatusSkill: (ctx) => void, function createGetShiftNotesSkill: (ctx) => void
- `src\skills\searchMenu.skill.ts` — function selectPublicMenuItems: (items, any>[], query, category, limit) => void, function createSearchMenuSkill: (ctx) => void
- `src\skills\tavilySearch.skill.ts` — function searchWeb: (query, options) => void, function createTavilySearchSkill: (_ctx) => void
- `src\transport\whatspro.client.ts`
  - function splitWhatsProResponse: (text) => string[]
  - function sendWhatsProMessage: (payload) => void
  - function getWhatsProOutboxSummary: () => void
  - function drainWhatsProOutbox: (limit) => void
  - function startWhatsProOutboxWorker: () => void
  - function sendWhatsProPresence: (payload) => void
  - _...3 more_
- `src\utils\language.ts`
  - function isLanguageBearingCustomerText: (text) => void
  - function parseGeminiLanguageDecision: (value) => void
  - function detectLang: (text, storedLang?) => "kk" | "ru"
  - function resolveLockedLanguage: (storedLang, detected) => "kk" | "ru"
  - function detectLanguageDecision: (text, classifier) => void
  - function detectLanguageWithAI: (text) => Promise<"kk" | "ru">
  - _...2 more_
- `src\utils\magicLink.ts`
  - function normalizeMenuDomain: (domain) => string | null
  - function generateSecureMenuUrl: (domain, phone, tenantSecret) => string | null
  - function isMenuLinkResendRequest: (text) => boolean
  - function hasExplicitMenuLinkIntent: (text) => boolean
- `src\utils\orderIntent.ts`
  - function isOrderTimingQuestion: (text) => void
  - function requestedOrderNumber: (text) => void
  - function isCustomerOrderStatusQuestion: (text) => void
  - function hasMenuBrowsingIntent: (text) => void
  - function isLikelyOrderStatusFollowUp: (text) => void
  - function lastDiscussedOrderNumber: (history) => string

---

# Config

## Environment Variables

- `ANALYTICS_CRON_EXPR` (has default) — .env.example
- `ANALYTICS_TIMEZONE` (has default) — .env.example
- `BOT_IGNORE_SAVED_CONTACTS` (has default) — .env.example
- `BUFFER_BRAIN_TIMEOUT_MS` **required** — src\services\bufferBrain.service.ts
- `CHATWOOT_ADAPTER_URL` **required** — src\services\diagnostics.service.ts
- `CRITIC_BUDGET_MS` **required** — src\agent\fastfoodAgent.ts
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
- `LEARN_INSTANCE_ID` **required** — scripts\learnFromFailures.ts
- `LLM_FALLBACK_PROVIDER` (has default) — .env
- `LLM_PROVIDER` (has default) — .env
- `MAX_RETRY_PER_KEY` (has default) — .env
- `MEDIA_FALLBACK_MODEL` (has default) — .env.example
- `MEDIA_PRIMARY_KEYS` **required** — .env.example
- `MEDIA_PRIMARY_MODEL` (has default) — .env.example
- `MEDIA_PRO_ENABLED` (has default) — .env.example
- `MEDIA_PRO_KEYS` **required** — .env.example
- `MEDIA_PRO_MODEL` (has default) — .env.example
- `MEDIA_USE_FREE_KEYS` (has default) — .env.example
- `N8N_WEBHOOK_TIMEOUT_MS` (has default) — .env.example
- `N8N_WEBHOOK_TOKEN` **required** — .env.example
- `N8N_WEBHOOK_URL` **required** — .env.example
- `NODE_ENV` **required** — src\transport\whatspro.client.ts
- `NODE_TEST_CONTEXT` **required** — src\services\redis.service.ts
- `OPENAI_API_KEY` (has default) — .env
- `OPENAI_BASE_URL` (has default) — .env
- `OPENBOT_DEV_ALERT_DEDUPE_SECONDS` (has default) — .env.example
- `OPENBOT_DEVELOPER_PHONE` **required** — .env.example
- `OPENBOT_INBOUND_BUFFER_MS` (has default) — .env.example
- `OPENBOT_MAX_AUDIO_BYTES` (has default) — .env.example
- `OPENBOT_MAX_DOCUMENT_BYTES` (has default) — .env.example
- `OPENBOT_MAX_IMAGE_BYTES` (has default) — .env.example
- `OPENBOT_MAX_MEDIA_BYTES` (has default) — .env.example
- `OPENBOT_MAX_VOICE_SECONDS` (has default) — .env.example
- `OPENBOT_MEDIA_AI_LIMIT_PER_5_MINUTES` (has default) — .env.example
- `OPENBOT_OUTBOX_DIR` (has default) — .env.example
- `OPENBOT_OUTBOX_INTERVAL_MS` (has default) — .env.example
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
- `REDIS_CONNECT_TIMEOUT_MS` (has default) — .env.example
- `REDIS_OPERATION_TIMEOUT_MS` (has default) — .env.example
- `REDIS_PASSWORD` (has default) — .env.example
- `REDIS_URL` (has default) — .env.example
- `REGEN_BUDGET_MS` **required** — src\agent\fastfoodAgent.ts
- `SHPOR_CONTEXT_LIMIT` **required** — src\services\platformConfig.service.ts
- `SMOKE_INSTANCE_ID` **required** — scripts\agentSmoke.ts
- `SMOKE_JSONL_PATH` **required** — scripts\agentSmoke.ts
- `SMOKE_TIMEOUT_MS` **required** — scripts\agentSmoke.ts
- `TAVILY_API_KEY` **required** — .env.example
- `TENANTS_PLATFORM_API_TOKEN` **required** — .env.example
- `TENANTS_PLATFORM_BASE_URL` **required** — .env.example
- `TEST_MODE_ENABLED` (has default) — .env.example
- `TEXT_FALLBACK_MODEL` (has default) — .env.example
- `TEXT_FALLBACK_TIMEOUT_MS` (has default) — .env.example
- `TEXT_PRIMARY_MODEL` (has default) — .env.example
- `TEXT_PRIMARY_TIMEOUT_MS` (has default) — .env.example
- `TEXT_RESERVE_MODEL` (has default) — .env.example
- `TEXT_RESERVE_TIMEOUT_MS` (has default) — .env.example
- `THINK_MODEL` **required** — src\services\agentThinking.service.ts
- `THINK_TIMEOUT_MS` **required** — src\services\agentThinking.service.ts
- `WHATSPRO_API_TOKEN` **required** — .env.example
- `WHATSPRO_BASE_URL` **required** — .env.example
- `WHATSPRO_PASSWORD` (has default) — .env
- `WHATSPRO_PRESENCE_URL` **required** — .env.example
- `WHATSPRO_READ_STATE` **required** — src\transport\whatspro.client.ts
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

- `src\context\types.ts` — imported by **24** files
- `src\services\redis.service.ts` — imported by **22** files
- `src\services\platformConfig.service.ts` — imported by **11** files
- `src\services\dle.service.ts` — imported by **10** files
- `src\services\llm.service.ts` — imported by **8** files
- `src\context\buildFactsPrompt.ts` — imported by **8** files
- `src\services\auditLogger.service.ts` — imported by **7** files
- `src\services\developerNotify.service.ts` — imported by **6** files
- `src\transport\whatspro.client.ts` — imported by **6** files
- `src\agent\instructions.ts` — imported by **5** files
- `src\utils\orderIntent.ts` — imported by **5** files
- `src\services\customerOrder.service.ts` — imported by **5** files
- `src\services\agentThinking.service.ts` — imported by **4** files
- `src\agent\finalValidator.ts` — imported by **4** files
- `src\services\noteProvenance.service.ts` — imported by **4** files
- `src\services\kitchenPolicy.service.ts` — imported by **4** files
- `src\services\operatorCase.service.ts` — imported by **4** files
- `src\agent\toolPolicy.ts` — imported by **3** files
- `src\services\paymentPolicy.service.ts` — imported by **3** files
- `src\utils\language.ts` — imported by **3** files

## Import Map (who imports what)

- `src\context\types.ts` ← `src\agent\fastfoodAgent.ts`, `src\agent\finalValidator.ts`, `src\agent\modelRouter.ts`, `src\agent\persona.ts`, `src\agent\toolPolicy.ts` +19 more
- `src\services\redis.service.ts` ← `src\cron\statsCron.ts`, `src\routes\system.route.ts`, `src\server.ts`, `src\services\complaintRouting.service.ts`, `src\services\customerMemory.service.ts` +17 more
- `src\services\platformConfig.service.ts` ← `src\context\preloadContext.ts`, `src\controllers\kanban.ts`, `src\cron\statsCron.ts`, `src\routes\dleWebhook.route.ts`, `src\routes\system.route.ts` +6 more
- `src\services\dle.service.ts` ← `src\context\preloadContext.ts`, `src\controllers\kanban.ts`, `src\cron\statsCron.ts`, `src\routes\whatsappWebhook.route.ts`, `src\services\customerOrder.service.ts` +5 more
- `src\services\llm.service.ts` ← `scripts\judgeSmoke.ts`, `src\routes\whatsappWebhook.route.ts`, `src\services\agentThinking.service.ts`, `src\services\bufferBrain.service.ts`, `src\services\customerMemory.service.ts` +3 more
- `src\context\buildFactsPrompt.ts` ← `src\agent\fastfoodAgent.ts`, `test\conversationBrain.test.ts`, `test\internalConfidentiality.test.ts`, `test\mandatoryConstraints.test.ts`, `test\menuSnapshotContext.test.ts` +3 more
- `src\services\auditLogger.service.ts` ← `src\controllers\kanban.ts`, `src\routes\dleWebhook.route.ts`, `src\services\complaintRouting.service.ts`, `src\services\customerOrder.service.ts`, `src\services\dle.service.ts` +2 more
- `src\services\developerNotify.service.ts` ← `src\controllers\kanban.ts`, `src\cron\statsCron.ts`, `src\routes\dleWebhook.route.ts`, `src\routes\system.route.ts`, `src\routes\whatsappWebhook.route.ts` +1 more
- `src\transport\whatspro.client.ts` ← `src\controllers\kanban.ts`, `src\routes\whatsappWebhook.route.ts`, `src\server.ts`, `src\services\developerNotify.service.ts`, `src\services\diagnostics.service.ts` +1 more
- `src\agent\instructions.ts` ← `src\agent\fastfoodAgent.ts`, `test\conversationBrain.test.ts`, `test\internalConfidentiality.test.ts`, `test\mandatoryConstraints.test.ts`, `test\paymentPolicy.test.ts`

---

# Events & Queues

## eventemitter

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
- `Rejected shift note: empty text` [event] — `src/controllers/kanban.ts`
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

## redis-pub-sub

- `chatwoot:events:${input.instanceId}` [channel] — `src/services/operatorCase.service.ts`

---

_Generated by [codesight](https://github.com/Houseofmvps/codesight) — see your codebase clearly_