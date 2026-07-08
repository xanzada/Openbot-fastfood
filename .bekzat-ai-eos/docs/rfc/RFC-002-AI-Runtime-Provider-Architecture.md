# RFC-002: AI Runtime & Provider Architecture

> **Статус:** Draft
> **Автор:** BekzatAI Engineering
> **Қатысты:** AI Engine, LLM Runtime (RFC-001), Billing Engine
> **Құрылған:** 2026-07-08
> **Жаңартылған:** 2026-07-08

---

## Purpose

RFC-001 defined the **LLM Runtime interface** — how upper layers request AI capabilities without knowing providers. RFC-002 defines the **provider architecture** inside that Runtime — how providers are organized, how keys are managed, how rate limits are handled, how capabilities are routed, and how the system survives provider failures without degrading the customer experience.

RFC-001 and RFC-002 together form the complete specification of the AI Runtime.

---

## Table of Contents

1. [Provider Tier Architecture](#1-provider-tier-architecture)
2. [Account Key Manager](#2-account-key-manager)
3. [Rate Limit Manager](#3-rate-limit-manager)
4. [Capability Router](#4-capability-router)
5. [Fleet Manager](#5-fleet-manager)
6. [Business Rules Gateway](#6-business-rules-gateway)
7. [Style Preservation System](#7-style-preservation-system)
8. [Cost Optimization Engine](#8-cost-optimization-engine)
9. [Complete Request Flow](#9-complete-request-flow)
10. [Failure Scenarios](#10-failure-scenarios)
11. [Provider-Specific Adapters](#11-provider-specific-adapters)
12. [Routing Configuration Reference](#12-routing-configuration-reference)
13. [Version Roadmap](#13-version-roadmap)

---

## 1. Provider Tier Architecture

Providers are organized into tiers. Each tier represents a cost and reliability level.

```
Cost
 ↑
 │   TIER 3: Emergency Fallback (paid Gemini API)     ← highest cost, always available
 │   TIER 2: OpenRouter Providers (multiple models)   ← competitive pricing, diverse
 │   TIER 1: Paid Gemini Studio (quota account)       ← moderate cost, reliable
 │   TIER 0: Free Gemini Studio (multiple keys)       ← zero cost, rate-limited
 └─────────────────────────────────────────────────────→ Reliability
```

### Tier 0 — Free Gemini Studio

Multiple Google API keys from free-tier Gemini Studio accounts.

| Property | Value |
|----------|-------|
| Cost | $0 (within free quota) |
| Rate limit | ~60 requests/min per key, varies by model |
| Models | `gemini-2.0-flash`, `gemini-2.0-flash-lite` |
| Best for | High-volume, low-criticality conversations |
| Keys | Many (one per Google account) |

**Strategy:** Round-robin across keys. When a key hits rate limit, skip it until the cooldown period expires.

```
key_1 → key_2 → key_3 → ... → key_N → key_1
```

### Tier 1 — Paid Gemini Studio

A paid Google Cloud project with a Gemini API quota.

| Property | Value |
|----------|-------|
| Cost | ~$0.15-1.00/1M tokens depending on model |
| Rate limit | Higher, pay-as-you-go |
| Models | `gemini-2.0-flash`, `gemini-1.5-pro` |
| Best for | When all free keys are rate-limited or unavailable |

**Strategy:** Single key (paid quota). Called when Tier 0 is exhausted.

### Tier 2 — OpenRouter Providers

OpenRouter provides access to 200+ models from many providers.

| Property | Value |
|----------|-------|
| Cost | Variable, competitive pricing |
| Rate limit | Per-model, typically generous |
| Models | Claude, GPT-4o, Llama, Mistral, DeepSeek, Qwen, etc. |
| Best for | Quality-critical conversations, vision tasks, emergency |

**Strategy:** OpenRouter handles cross-provider billing. The Runtime selects OpenRouter models by capability + price.

### Tier 3 — Emergency Fallback (Paid Gemini API)

Direct paid Google Gemini API (not through Studio). Highest reliability tier.

| Property | Value |
|----------|-------|
| Cost | Highest |
| Rate limit | 99.9% SLA |
| Models | `gemini-2.0-flash` |
| Best for | Last resort when all other providers fail |

### Tier Selection Logic

```
For each request:

1. Try Tier 0 (free Gemini keys)
   → Success? Done.
   → All keys rate-limited or failing? → Go to Tier 1.

2. Try Tier 1 (paid Gemini Studio)
   → Success? Done.
   → Failing? → Go to Tier 2.

3. Try Tier 2 (OpenRouter)
   → Success? Done.
   → Failing? → Go to Tier 3.

4. Try Tier 3 (emergency Gemini API)
   → Success? Done.
   → Failing? → Return error to upper layer.
```

---

## 2. Account Key Manager

The Account Key Manager owns all API keys. Upper layers never see them.

### Responsibilities

- Store API keys securely (encrypted at rest + in memory)
- Track key health (rate-limited? expired? revoked?)
- Track key usage (requests/min, tokens/min)
- Provide "next available key" for a given tier
- Rotate keys automatically when rate-limited

### Data Model

```typescript
interface ApiKey {
  id: string
  tier: 'free' | 'paid' | 'openrouter' | 'emergency'
  provider: 'gemini' | 'openai' | 'openrouter'
  keyHash: string       // stored encrypted; only decrypted at send time
  model: string
  
  // Rate limit tracking
  requestsThisMinute: number
  requestsPerMinuteLimit: number
  lastRateLimitedAt: Date | null
  
  // Health
  isEnabled: boolean
  isDegraded: boolean
  lastError: string | null
  consecutiveFailures: number
}
```

### Key Pool per Tier

```
Tier 0 (free Gemini):
  key_1 → gemini-2.0-flash    (60 rpm)
  key_2 → gemini-2.0-flash    (60 rpm)
  key_3 → gemini-2.0-flash    (60 rpm)
  key_4 → gemini-2.0-flash    (60 rpm)
  ...

Tier 1 (paid Gemini):
  key_paid → gemini-2.0-flash (10,000 rpm)
  key_paid → gemini-1.5-pro   (10,000 rpm)

Tier 2 (OpenRouter):
  key_or → openrouter         (varies by model)

Tier 3 (emergency):
  key_emergency → gemini-2.0-flash (SLA)
```

### Key Selection Algorithm

```text
Given: tier, model

1. Filter by tier + model
2. Filter out disabled keys
3. Filter out rate-limited keys (within cooldown window)
4. Sort by priority (lower = better)
5. Pick the key with lowest recent usage

Returns: ApiKey or null
```

### Rate-Limited Key Handling

When a 429 (rate limit) or 503 (quota exhausted) is received:

```text
1. Mark key as rate-limited
2. Set cooldown: 60 seconds (configurable)
3. Log: key_id, tier, model, timestamp
4. Select next available key
5. If all keys rate-limited → escalate to next tier
```

---

## 3. Rate Limit Manager

The Rate Limit Manager is a subsystem of the Account Key Manager. It tracks rate limit state and predicts when keys will be available.

### Per-Key State Machine

```
                 ┌──────────┐
        ┌───────→│  HEALTHY │←──────┐
        │        └─────┬────┘       │
        │              │             │
   key expires    rate limit    cooldown
   or revoked        hit        expires
        │              │             │
        │        ┌─────▼────┐       │
        └───────→│ COOLDOWN │───────┘
                 └──────────┘
                 
        ┌──────────────┐
        │   DISABLED    │
        └──────────────┘
```

### Cooldown Policy

```yaml
rate_limit:
  cooldown_seconds: 60           # wait after 429
  max_consecutive_cooldowns: 5   # disable key after 5 consecutive rate limits
  key_revival_interval: 300      # try disabled keys every 5 minutes
```

### Predictive Rate Limiting

Before calling a key, the Rate Limit Manager estimates whether the key will be rate-limited:

```typescript
function predictRateLimit(key: ApiKey): boolean {
  const rpm = key.requestsThisMinute
  const limit = key.requestsPerMinuteLimit
  const utilization = rpm / limit
  
  // If utilization > 80%, prefer another key to be safe
  return utilization > 0.8
}
```

---

## 4. Capability Router

Not all providers support all capabilities. The Capability Router ensures each request goes to a provider that can handle it.

### Capability Definitions

| Capability | Description | Supported By |
|------------|-------------|-------------|
| `conversation` | Text-only chat | All providers |
| `vision_photo` | Image understanding | Gemini (all tiers), GPT-4o (OpenRouter), Claude 3.5 (OpenRouter) |
| `vision_audio` | Audio transcription/understanding | Gemini, Whisper (OpenRouter) |
| `vision_pdf` | Document analysis | Gemini (native), Claude (OpenRouter), GPT-4o (OpenRouter) |
| `reasoning` | Complex multi-step reasoning | Gemini 1.5 Pro, Claude Opus, GPT-4o |

### Routing Rules

```yaml
routing:
  conversation:
    preferred: [tier_0]          # free Gemini first
    allowed:   [tier_0, tier_1, tier_2, tier_3]
    
  vision_photo:
    preferred: [tier_0]          # Gemini Free can handle images
    allowed:   [tier_0, tier_1, tier_2, tier_3]
    
  vision_audio:
    preferred: [tier_2]          # OpenRouter for Whisper/Gemini Audio
    allowed:   [tier_0, tier_1, tier_2, tier_3]
    note: "Tier 0/1 work if Gemini supports audio; fallback to OpenRouter"
    
  vision_pdf:
    preferred: [tier_0]          # Gemini Free can handle PDFs
    allowed:   [tier_0, tier_1, tier_2, tier_3]
    
  reasoning:
    preferred: [tier_2]          # OpenRouter for premium reasoning models
    allowed:   [tier_2, tier_1, tier_3]
    note: "Tier 0 lacks strong reasoning models"
```

### Dynamic Model Mapping

The Runtime maintains a map of capability → model per tier:

```
conversation:
  tier_0: gemini-2.0-flash
  tier_1: gemini-2.0-flash
  tier_2: openrouter/auto        # OpenRouter decides cheapest capable model
  tier_3: gemini-2.0-flash

vision_photo:
  tier_0: gemini-2.0-flash
  tier_1: gemini-2.0-flash
  tier_2: openrouter/anthropic/claude-3.5-sonnet
  tier_3: gemini-2.0-flash
```

### Capability-Only Upper Layer Interface

The upper layers specify what they need, not which provider:

```
// Upper layer calls:
runtime.complete({ 
  capability: 'vision_photo',
  content: [base64_image, "What's in this photo?"],
  policy: 'standard'
})

// NOT:
runtime.complete({ provider: 'gemini', model: 'gemini-pro-vision', ... })
```

---

## 5. Fleet Manager

The Fleet Manager groups multiple API keys per capability into a logical "fleet" and manages them as a unit.

### Fleet Concept

A fleet is a group of provider accounts that serve the same capability. The Fleet Manager treats the fleet as a single logical provider.

```
fleet: conversation
├── tier_0: free_gemini_fleet
│   ├── key_1 (gemini-2.0-flash, 60 rpm)
│   ├── key_2 (gemini-2.0-flash, 60 rpm)
│   ├── key_3 (gemini-2.0-flash, 60 rpm)
│   └── key_4 (gemini-2.0-flash, 60 rpm)
├── tier_1: paid_gemini_fleet
│   └── key_paid (gemini-2.0-flash, 10,000 rpm)
├── tier_2: openrouter_fleet
│   └── key_or (multiple models)
└── tier_3: emergency_fleet
    └── key_emergency (gemini-2.0-flash)
```

### Fleet Health

```typescript
interface FleetHealth {
  name: string
  capability: string
  totalKeys: number
  healthyKeys: number
  rateLimitedKeys: number
  currentTier: number       // which tier is active
  requestsPerMinute: number
  errorRate: number
  status: 'healthy' | 'degraded' | 'critical'
}
```

### Fleet Escalation

When a fleet tier is unhealthy, the Fleet Manager escalates:

```
fleet.conversation.health()
→ Tier 0: 6/10 keys healthy (degraded but usable)
→ Tier 1: 1/1 key healthy
→ Tier 2: available
→ Tier 3: available but expensive

Decision: 
  - Keep Tier 0 for most requests (cost optimization)
  - Route quality-critical requests directly to Tier 2
  - Route to Tier 1 when Tier 0 confidence < 50%
```

---

## 6. Business Rules Gateway

Business Rules are checked BEFORE any AI provider is called. They are not negotiable.

### Architecture

```
                  ┌─────────────────────┐
                  │   Business Rules     │
                  │   Engine             │
                  └──────────┬──────────┘
                             │
Request ──→ [RULE CHECK] ──→ ALLOWED? ──→ LLM Runtime
                 │                        │
           NOT ALLOWED                    │
                 │                        │
                 ▼                        ▼
          Return Rule-based          Execute request
          Response (no LLM)
```

### Rule Types

```typescript
type BusinessRule =
  | BlockingRule      // "Never serve alcohol after 11PM"
  | ModifyingRule     // "If customer is VIP, include loyalty discount"
  | RoutingRule       // "Complaints should use highest quality provider"
  | ShortCircuitRule  // "If customer says 'menu', return menu directly"
```

### MVP Rule Set

```yaml
rules:
  - name: no_delivery_after_10pm
    type: blocking
    condition: current_hour > 22 && intent == 'order'
    response: "Кешіріңіз, қазір жеткізу қызметі жұмыс істемейді. Таңғы 8-ден бастап қабылдаймыз."
    priority: 1000            # very high — always enforced

  - name: business_hours_check
    type: blocking
    condition: !is_business_hours && intent != 'info'
    response: "Біз қазір жабықпыз. Жұмыс уақытымыз: 8:00 - 23:00."
    priority: 900

  - name: complaint_priority
    type: routing
    condition: sentiment == 'negative' && intent == 'complaint'
    action: force_policy('premium')   # highest quality provider
    priority: 500

  - name: menu_query
    type: short_circuit
    condition: intent == 'menu'
    action: return_menu_data()         # no LLM needed
    priority: 800
```

### Rule Enforcement Point

Rules are checked at the **AI Engine** level, before the request reaches the LLM Runtime:

```
AI Engine receives request
  → Check Business Rules Engine
    → Rule blocks? Return rule response immediately (no LLM call)
    → Rule modifies? Modify request payload
    → Rule redirects? Change policy/capability
    → No rule matches? Pass to LLM Runtime normally
```

This means:
- **Blocking rules** reduce LLM costs to zero for those requests
- **Short-circuit rules** (menu, hours, address) handle common queries without any AI
- **Routing rules** ensure quality-critical requests get the best provider

---

## 7. Style Preservation System

Every provider must produce the same restaurant identity. A customer must never detect that the provider changed.

### Architecture

```
         ┌──────────────────────────────┐
         │       Style Injector          │
         │  (pre-request modification)   │
         └────────────┬─────────────────┘
                      │
Request ──→ Injects system prompt ──→ LLM Provider
         │  with restaurant identity    │
         │  + conversation context      │
         │  + business rules summary    │
         │                              │
         │         ┌────────────────────┐
         └────────→│   Style Validator   │
                    │  (post-response)    │
                    └────────────────────┘
                              │
                    Response passes? → Deliver
                    Response fails?  → Retry with stronger prompt
```

### Style Injector

The Style Injector builds the system prompt dynamically from the restaurant's identity profile:

```typescript
function buildSystemPrompt(restaurant: RestaurantProfile): string {
  return `
You are a customer service representative for ${restaurant.name}.
${restaurant.identity.archetype}  // e.g., "You are a friendly neighborhood cafe"
${restaurant.identity.tone}       // e.g., "Warm, conversational, use Kazakh phrases naturally"
${restaurant.identity.voice}      // e.g., "Speak like a local, not a corporation"

Business Rules:
${restaurant.rules.summary}       // e.g., "No delivery after 10PM. Vip customers get priority."

Menu Context:
${restaurant.menu.summary}        // e.g., "Signature dish: besbarmak. Vegan options available."

Conversation History:
${conversation.context}           // last 10 messages

Instructions:
- You serve the customer, not corporate interests.
- If you don't know something, say so honestly.
- Never reveal that you are an AI language model.
- Respond in Kazakh unless the customer speaks Russian.
  `.trim()
}
```

### Style Validator

The Style Validator checks the provider's response for identity violations:

```typescript
interface StyleValidationResult {
  passed: boolean
  violations: StyleViolation[]
}

interface StyleViolation {
  type: 'wrong_tone' | 'wrong_language' | 'corporate_voice' | 'ai_disclosure'
  severity: 'low' | 'medium' | 'high'
  snippet: string
}
```

In MVP, the Style Validator is a set of simple heuristics:
- Response contains Kazakh/Russian language when expected? (regex check)
- Response contains "as an AI" or similar disclosure? (blocklist)
- Response uses formal tone when casual is expected? (keyword check)

### Identity Invariance Guarantee

```
Provider A (Gemini Free)  ──→ "Бүгін не ішесіз? Бізде жаңа шырындар бар!" ✓
Provider B (OpenRouter)   ──→ "Бүгін не ішесіз? Бізде жаңа шырындар бар!" ✓
Provider C (Emergency)    ──→ "Бүгін не ішесіз? Бізде жаңа шырындар бар!" ✓
```

The customer sees the same restaurant regardless of which provider processed the request.

---

## 8. Cost Optimization Engine

The Cost Optimization Engine tracks spending across all providers and selects the most cost-effective option that meets quality requirements.

### Cost Per Provider Type

| Provider | Cost per 1M input tokens (flash) | Cost per 1M output tokens |
|----------|----------------------------------|--------------------------|
| Gemini Free (Tier 0) | $0 | $0 |
| Gemini Paid (Tier 1) | ~$0.075 | ~$0.30 |
| OpenRouter (varies) | $0.05 - $15.00 | $0.15 - $75.00 |
| Gemini Emergency (Tier 3) | ~$0.075 | ~$0.30 |

### Cost Optimization Rules

```yaml
cost_optimization:
  # Always prefer free tier unless it cannot handle the request
  prefer_free: true
  
  # If free tier is rate-limited, prefer OpenRouter over paid Gemini
  # when OpenRouter has comparable models at lower price
  prefer_openrouter_over_paid_gemini: true
  
  # When all free keys are rate-limited but some will recover soon:
  wait_for_recovery: true
  max_wait_ms: 500         # wait up to 500ms for a free key to become available
                           # before falling back to paid
  
  # Emergency tier cost cap
  emergency_only_for:
    - policy: 'premium'    # only premium-critical requests use Tier 3
    - no_other_provider    # all others degrade instead of using Tier 3
```

### Quality-Cost Matrix

| Request Type | Preferred | Cost | Quality | Fallback |
|-------------|-----------|------|---------|----------|
| Casual chat | Free Gemini | $0 | Good | Paid Gemini |
| Order placement | Free Gemini | $0 | Good | Paid Gemini |
| Complaint | OpenRouter (Claude) | ~$0.01 | Best | Paid Gemini |
| VIP customer | OpenRouter (Claude) | ~$0.01 | Best | Emergency |
| Menu query | Short-circuit | $0 | Perfect | N/A |
| Business hours | Short-circuit | $0 | Perfect | N/A |

---

## 9. Complete Request Flow

This flow shows how all components work together.

```
[1. RECEIVE REQUEST]
    AI Engine receives customer message
    │
    ▼
[2. BUSINESS RULES]
    Business Rules Gateway checks:
    ├── Blocking rule matches? → Return rule response (no LLM call)
    ├── Short-circuit rule matches? → Return data response (no LLM call)
    ├── Modifying rule matches? → Modify request payload
    └── No rule matches? → Continue
    │
    ▼
[3. PREPARE REQUEST]
    Style Injector builds system prompt with:
    ├── Restaurant identity (archetype, tone, voice)
    ├── Business rules summary
    ├── Menu context
    └── Conversation history
    │
    ▼
[4. ROUTE BY CAPABILITY]
    Determine capability from request content:
    ├── Contains image? → vision_photo
    ├── Contains audio? → vision_audio
    ├── Contains PDF? → vision_pdf
    └── Text only? → conversation
    │
    ▼
[5. SELECT PROVIDER (TIERED)]
    Account Key Manager:
    ├── Try Tier 0 (free Gemini)
    │   ├── Key available? → Use it
    │   └── All keys rate-limited? → Try Tier 1
    ├── Try Tier 1 (paid Gemini)
    │   ├── Available? → Use it
    │   └── Failed? → Try Tier 2
    ├── Try Tier 2 (OpenRouter)
    │   ├── Available? → Use it
    │   └── Failed? → Try Tier 3
    └── Try Tier 3 (emergency)
        ├── Available? → Use it
        └── Failed? → Return error
    │
    ▼
[6. EXECUTE]
    Provider Adapter:
    ├── Translate request to provider format
    ├── Send to provider
    ├── Receive response
    └── Translate response to internal format
    │
    ▼
[7. VALIDATE STYLE]
    Style Validator:
    ├── Checks tone, language, identity
    ├── Passes? → Deliver
    └── Fails? → Retry with stronger prompt (max 2)
    │
    ▼
[8. TRACK USAGE]
    ├── Record tokens used
    ├── Update key usage counters
    ├── Update cost tracking
    └── Log request + response
    │
    ▼
[9. RETURN RESPONSE]
    Return to AI Engine → Customer
```

---

## 10. Failure Scenarios

### Scenario 1: All Free Keys Rate-Limited

```
Request comes in. Policy = standard.

1. Account Key Manager: check Tier 0
   4 keys, all 4 rate-limited (429 in last 60s)
2. Check if any key is about to recover (cooldown < 1s remaining)
   → No, all have 30s+ remaining
3. Escalate to Tier 1 (paid Gemini)
4. Tier 1 key: healthy. Execute request.
5. Cost: $0.0001 (paid) instead of $0 (free)
6. Log: "free_tier_exhausted", 4 keys limited
```

### Scenario 2: Vision Request, Free Tier Doesn't Support It

```
Request: vision_photo (image analysis)

1. Capability Router: vision_photo
2. Preferred tier: 0 (free Gemini)
3. Free Gemini: check if model supports vision
   → gemini-2.0-flash supports vision ✓
4. Use Tier 0 normally
```

### Scenario 3: All Providers Down

```
1. Tier 0: 4 keys all failing (non-rate-limit errors)
2. Tier 1: paid Gemini returning 500 errors
3. Tier 2: OpenRouter returning 503 (provider API down)
4. Tier 3: Emergency Gemini: success
5. Use Tier 3. Log critical alert.
6. Cost: highest tier, but customer gets service.

If Tier 3 also fails:
7. Return error to AI Engine
8. AI Engine sends fallback: "Кешіріңіз, қазір техникалық ақау бар. Операторға қосамын."
```

### Scenario 4: Key Expires Mid-Request

```
1. Tier 0, key_3 selected
2. Request sent to Gemini
3. Response: 401 (invalid API key)
4. Account Key Manager: mark key_3 as disabled
5. Log alert: "key_3 expired or revoked"
6. Retry with key_4 (no delay — different issue than rate limit)
7. key_4 succeeds. Customer sees no disruption.
```

### Scenario 5: Poor Quality Response

```
1. Tier 0 free Gemini returns response
2. Style Validator: checks response
   → Violation: response is in English, restaurant expects Kazakh
   → Severity: high
3. Retry with stronger system prompt (explicit: "Respond in Kazakh only")
4. Provider returns response in Kazakh ✓
5. If retry also fails → escalate to Tier 2 (better quality model)

Note: Full quality scoring (beyond style validation) is a Commercial feature.
In MVP, only basic style validation is enforced.
```

---

## 11. Provider-Specific Adapters

Each provider requires an adapter. The adapter translates between the Runtime's internal format and the provider's API.

### Gemini (Free & Paid)

```typescript
class GeminiAdapter implements ProviderAdapter {
  // Handles both free (API key) and paid (Google Cloud API key)
  // Models: gemini-2.0-flash, gemini-1.5-pro
  // Capabilities: conversation, vision_photo, vision_audio, vision_pdf, reasoning
  
  complete(request: InternalRequest): Promise<ProviderResponse> {
    // 1. Map internal messages → Gemini content parts
    // 2. Handle multi-modal content (text + image + audio)
    // 3. Call Gemini API with key from Account Key Manager
    // 4. Extract text + usage from response
    // 5. Return standardized response
  }
  
  health(): boolean {
    // Check if key is valid by testing a simple prompt
  }
}
```

### OpenRouter

```typescript
class OpenRouterAdapter implements ProviderAdapter {
  // Access to 200+ models via single API
  // Models: auto-select, or specific model
  // Capabilities: all (depends on model selected)
  
  complete(request: InternalRequest): Promise<ProviderResponse> {
    // 1. Map internal messages → OpenRouter chat format
    // 2. Add OpenRouter headers (referer, app name)
    // 3. Call OpenRouter API
    // 4. Handle model-specific response differences
    // 5. Return standardized response
  }
  
  health(): boolean {
    // Check if OpenRouter API is reachable
  }
}
```

### Emergency Gemini (Direct API)

```typescript
class EmergencyGeminiAdapter implements ProviderAdapter {
  // Direct Google Generative AI API (paid)
  // Separate from Studio — different quota, higher reliability
  // Used only when all other providers fail
  
  // Same interface as GeminiAdapter but uses a different
  // Google Cloud project with guaranteed SLA
}
```

---

## 12. Routing Configuration Reference

### Full Production Config

```yaml
ai_runtime:
  version: 1
  
  # --- Account Keys ---
  keys:
    # Tier 0: Free Gemini Studio
    - id: gemini_free_1
      tier: 0
      provider: gemini
      model: gemini-2.0-flash
      rpm_limit: 60
      enabled: true
      
    - id: gemini_free_2
      tier: 0
      provider: gemini
      model: gemini-2.0-flash
      rpm_limit: 60
      enabled: true
      
    - id: gemini_free_3
      tier: 0
      provider: gemini
      model: gemini-2.0-flash-lite
      rpm_limit: 60
      enabled: true

    # Tier 1: Paid Gemini Studio
    - id: gemini_paid_1
      tier: 1
      provider: gemini
      model: gemini-2.0-flash
      rpm_limit: 10000
      enabled: true
      
    - id: gemini_paid_pro
      tier: 1
      provider: gemini
      model: gemini-1.5-pro
      rpm_limit: 5000
      enabled: true

    # Tier 2: OpenRouter
    - id: openrouter_main
      tier: 2
      provider: openrouter
      model: auto  # OpenRouter selects cheapest capable
      rpm_limit: 10000
      enabled: true

    # Tier 3: Emergency Direct Gemini
    - id: gemini_emergency
      tier: 3
      provider: gemini
      model: gemini-2.0-flash
      rpm_limit: 50000
      enabled: true
      emergency_only: true

  # --- Capability Mapping ---
  capabilities:
    conversation:
      tiers: [0, 1, 2, 3]
      preferred_tier: 0
      
    vision_photo:
      tiers: [0, 1, 2, 3]
      preferred_tier: 0
      
    vision_audio:
      tiers: [2, 1, 3]
      preferred_tier: 2
      
    vision_pdf:
      tiers: [0, 1, 2, 3]
      preferred_tier: 0
      
    reasoning:
      tiers: [2, 1, 3]
      preferred_tier: 2

  # --- Rate Limits ---
  rate_limit:
    cooldown_seconds: 60
    max_consecutive_cooldowns: 5
    key_revival_interval_seconds: 300

  # --- Cost Optimization ---
  cost_optimization:
    prefer_free: true
    prefer_openrouter_over_paid_gemini: true
    wait_for_free_slot_ms: 500
    emergency_only_policies: [premium]

  # --- Execution ---
  execution:
    max_retries_per_key: 2
    max_tier_escalations: 4   # 0→1→2→3
    base_timeout_ms: 5000
    retry_delay_ms: 1000

  # --- Style ---
  style:
    max_retries_on_violation: 2
    validation:
      check_language: true
      check_ai_disclosure: true
      check_tone: true
```

---

## 13. Version Roadmap

### MVP

```
Tiers:     Tier 0 only (multiple free Gemini keys)
Keys:      2-5 free Gemini keys
Routing:   conversation, vision_photo
Business:  blocking rules only (hardcoded)
Style:     system prompt injection only (no validation)
Cost:      free only (no cost optimization needed)
```

### Phase 2 (Post-MVP)

```
Tiers:     Tier 0 + Tier 1
Keys:      10+ free Gemini + 1 paid
Routing:   + vision_audio, vision_pdf
Business:  configurable rules (YAML)
Style:     + basic validation (language check, AI disclosure)
Cost:      free-first strategy
```

### Phase 3 (Commercial)

```
Tiers:     Tier 0 + Tier 1 + Tier 2 (OpenRouter)
Keys:      scaled free Gemini + paid + OpenRouter
Routing:   + reasoning
Business:  rule engine with conditions + actions
Style:     full validation + retry
Cost:      prefer_openrouter_over_paid_gemini
```

### Phase 4 (Enterprise)

```
Tiers:     All tiers including Tier 3
Keys:      max coverage across all providers
Routing:   all capabilities, ML-assisted routing
Business:  per-restaurant custom rules
Style:     ML-based style scoring
Cost:     predictive cost optimization, auto-bidding across OpenRouter
```

---

## Relationship to RFC-001

| Aspect | RFC-001 (LLM Runtime) | RFC-002 (Provider Architecture) |
|--------|----------------------|-------------------------------|
| Focus | Interface to upper layers | Internal provider organization |
| Defines | `runtime.complete()` | Account keys, tiers, rate limits |
| Concern | What capabilities are available | How to manage many API keys |
| Abstraction | Full — no provider names seen | Detailed — key management, tier escalation |
| Consumer | AI Engine | LLM Runtime (RFC-001 internal) |

RFC-001 is the **public face** of the Runtime. RFC-002 is the **engine room**.

---

## Open Questions

| # | Question | Resolution |
|---|----------|------------|
| 1 | Should the Runtime wait for a free key to recover, or immediately escalate? | Wait up to 500ms (configurable), then escalate. Short wait saves money. |
| 2 | How are Gemini free keys obtained initially? | Manual setup: operator creates Google accounts, generates API keys, adds to config. Future: automated key management. |
| 3 | Does OpenRouter need fallback models configured, or is auto-sufficient? | MVP: explicit model per capability. Phase 2: auto-fallback in OpenRouter. |
| 4 | How does the Business Rules Engine learn new rules? | MVP: YAML config. Phase 2: Admin UI. Phase 3: self-learning from customer interactions. |
| 5 | Should style validation use an LLM call itself? | No — too expensive and recursive. MVP: regex + keyword heuristics. Commercial: lightweight NLP model. |
| 6 | How are emergency costs tracked and alerted? | Emergency tier usage triggers ops alert + cost report. Separate budget tracking. |
| 7 | What happens when a free Gemini key hits daily quota (not rpm)? | Daily quota = 24h cooldown. Key is disabled until next day. Configurable recovery time. |
| 8 | Can a restaurant choose to skip free tier and use paid always? | Yes — restaurant-level config: `force_paid: true`. For VIP restaurants or testing. |

---

## Summary

RFC-002 defines the provider architecture that powers the LLM Runtime:

1. **Provider Tiers** — Free Gemini → Paid Gemini → OpenRouter → Emergency
2. **Account Key Manager** — Many keys per tier, automatic rotation, rate-limit aware
3. **Capability Router** — Text, vision, audio, PDF, reasoning → different providers
4. **Business Rules Gateway** — Rules checked BEFORE any LLM call
5. **Style Preservation** — Same restaurant identity across all providers
6. **Cost Optimization** — Free-first, escalate only when necessary

The design ensures:
- Restaurant OS never knows which provider is used
- Rate limits are handled transparently
- Emergency fallback works without degrading customer experience
- Adding providers requires only config + adapter code
- Costs are minimized without reducing quality

---

_BekzatAI — Every provider is temporary. The architecture is permanent._
