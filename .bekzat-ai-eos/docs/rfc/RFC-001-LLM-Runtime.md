# RFC-001: LLM Runtime

> **Статус:** Draft
> **Автор:** BekzatAI Engineering
> **Қатысты:** AI Engine, Billing Engine
> **Құрылған:** 2026-07-08
> **Жаңартылған:** 2026-07-08

---

## Design Principles

### P1. Provider Abstraction

Restaurant OS must NEVER know which AI provider is being used.

Upper layers request **capabilities**. The Runtime decides the rest.

```
runtime.complete({ capability: 'conversation', messages })
// NOT: runtime.complete({ provider: 'gemini', model: 'gemini-pro', messages })
```

### P2. Architecture > Providers

Every provider is temporary. The architecture is permanent.

When Gemini disappears or a better provider emerges, business logic must not change. Only configuration changes.

### P3. Quality Is Non-Negotiable

Cost optimization is important. Quality degradation is NOT acceptable.

Saving money is allowed. Reducing customer experience is NOT allowed.

### P4. Business Outcomes > Token Usage

The Runtime optimizes for business outcomes. Not token counts. Not latency numbers. Not cost per million tokens.

A slightly more expensive provider that converts customers is better than a cheap provider that frustrates them.

### P5. Complete Provider Replaceability

Every provider must be replaceable without changing business logic.

Adding a provider = new adapter + config. Removing a provider = config change. No code changes.

### P6. Identity Invariance

Every provider must produce the same Restaurant Identity and Brand Voice.

A customer must never detect that the provider changed mid-conversation.

### P7. Business Rules > LLM

Business Rules always have higher priority than LLM reasoning.

If the business says "no delivery after 10PM", the LLM must never override this. Business rules are checked BEFORE the LLM is called.

### P8. Future-Proof

The Runtime must support future providers that do not exist today.

The adapter interface must be generic enough that any future API can be adapted.

### P9. Scale Without Redesign

The Runtime must support thousands of restaurants without redesign.

The same architecture that works for 1 restaurant must work for 10,000.

### P10. Simplicity

If there are multiple possible architectures, always choose the simplest architecture that can scale.

A commercial SaaS succeeds because it is maintainable, not because it has the most components.

---

## Version Strategy

```
MVP ──────────────────── Commercial ──────────────── Enterprise
(minimal viable)         (feature complete)           (global scale)
     │                        │                           │
     ▼                        ▼                           ▼
  1 pool                   4+ pools                  Multi-region
  2 providers              10+ provider accounts     100+ accounts
  Simple priority          Health-weighted           Predictive routing
  1 policy                 5 policies                Custom policies
  Token budget only        Token + Quality budgets   Advanced budgets
  No scoring               Value scoring             ML-based scoring
  No benchmarking          Basic benchmarking        Full benchmarks
```

### MVP Definition

The MVP is what ships first. It must be:
- **Simple** — minimal components, minimal configuration
- **Maintainable** — any engineer can understand it
- **Scalable to Commercial** — adding features, not rewriting
- **Provider-independent** — core principle from day one

---

## Architecture

```
┌──────────────────────────────────────────────────────────────┐
│                     UPPER LAYERS                               │
│  ONLY call: runtime.complete({ capability, messages })        │
│  NEVER know: providers, models, APIs                          │
├──────────────────────────────────────────────────────────────┤
│                        LLM RUNTIME                             │
│                                                                │
│  ┌─────────────────────────────────────────────────────┐     │
│  │                  PUBLIC INTERFACE                    │     │
│  │  complete(request): RuntimeResponse                  │     │
│  └─────────────────────┬───────────────────────────────┘     │
│                        │                                      │
│  ┌─────────────────────▼───────────────────────────────┐     │
│  │               PROVIDER SELECTOR                      │     │
│  │                                                      │     │
│  │  MVP:    priority-based (try #1, fallback #2)        │     │
│  │  Comm:   health-weighted selection                   │     │
│  │  Ent:    ML-predictive routing                       │     │
│  └─────────────────────┬───────────────────────────────┘     │
│                        │                                      │
│  ┌─────────────────────▼───────────────────────────────┐     │
│  │               EXECUTION ENGINE                       │     │
│  │  • Retry (2 attempts)                               │     │
│  │  • Failover (next provider)                         │     │
│  │  • Timeout enforcement                              │     │
│  │  • Token tracking                                   │     │
│  └─────────────────────┬───────────────────────────────┘     │
│                        │                                      │
│  ┌─────────────────────▼───────────────────────────────┐     │
│  │               RESPONSE HANDLER                       │     │
│  │  • Logging                                          │     │
│  │  • Token accounting                                 │     │
│  │  • Health update                                    │     │
│  └─────────────────────────────────────────────────────┘     │
│                                                                │
├──────────────────────────────────────────────────────────────┤
│                     PROVIDER ADAPTERS                           │
│  ┌──────────┐  ┌──────────┐  ┌──────────┐  ┌──────────┐     │
│  │ Provider │  │ Provider │  │ Provider │  │  Future  │     │
│  │   #1     │  │   #2     │  │   #3     │  │    N     │     │
│  └──────────┘  └──────────┘  └──────────┘  └──────────┘     │
└──────────────────────────────────────────────────────────────┘
```

---

## Module Specifications

### Module: LLM Runtime (Public Interface)

**Purpose:** Single entry point for all AI requests. The only API upper layers see.

**Layer:** Top — called by AI Engine

**Responsibilities:**
- Accept requests with capability + messages + optional policy
- Return responses with content + usage info
- Hide all provider logic from callers

**MVP signature:**
```typescript
interface LLMRuntime {
  complete(request: {
    capability: 'conversation'
    messages: { role: string; content: string }[]
    policy?: 'standard' | 'economy'
    restaurantId: string
  }): Promise<{
    content: string
    usage: { promptTokens: number; completionTokens: number }
  }>
}
```

**Who may call it:**
- AI Engine (only)

**Who may NOT call it:**
- Any other module

**Events published:**
- `runtime.request.completed`
- `runtime.request.failed`

---

### Module: Provider Selector

**Purpose:** Choose which provider to use for each request.

**Responsibilities:**
- Maintain ordered list of providers per capability
- Check provider health (is it responding?)
- Select based on priority + policy
- Handle "no healthy provider" case

**MVP logic:**
```
Given: capability = 'conversation', policy = 'standard'

1. Get provider list for conversation pool
2. Filter out unhealthy providers
3. Sort by priority (lower = better)
4. Pick first healthy provider
5. If policy = 'economy': pick cheapest healthy provider
6. If none healthy: return error
```

**MVP config:**
```yaml
pools:
  conversation:
    providers:
      - id: gemini-main
        priority: 1
        model: gemini-2.0-flash
      - id: qwen-fallback
        priority: 2
        model: qwen-max
      - id: openai-emergency
        priority: 3
        model: gpt-4o-mini
        emergency_only: true
```

**Who may call it:**
- Execution Engine

**Who may NOT call it:**
- Upper layers

---

### Module: Execution Engine

**Purpose:** Execute the provider call with retry and failover.

**Responsibilities:**
- Call selected provider adapter
- Handle timeouts
- Retry on failure (max 2 attempts)
- Failover to next provider on persistent failure
- Track latency

**MVP flow:**
```
1. Try Provider #1
   Success? → Return response
   Failure? → Record error, attempt++

2. Retry Provider #1 (after 1s delay)
   Success? → Return response
   Failure? → attempt > max? → FAILOVER

3. Try Provider #2
   Success? → Return response
   Failure? → attempt++

4. Retry Provider #2
   Success? → Return response
   Failure? → attempt > max? → FAILOVER

5. Try Provider #3 (emergency)
   Success? → Return response
   Failure? → Return error to caller
```

**MVP config:**
```yaml
execution:
  max_retries_per_provider: 2
  max_failovers: 3
  base_timeout_ms: 5000
  retry_delay_ms: 1000
```

**Who may call it:**
- LLM Runtime (interface)

**Who may NOT call it:**
- Any module

---

### Module: Provider Adapter (Interface)

**Purpose:** Abstract each AI provider behind a stable interface.

**Responsibilities:**
- Translate internal request to provider API format
- Call provider
- Translate provider response to internal format
- Report health status

**Interface:**
```typescript
interface ProviderAdapter {
  readonly id: string
  readonly provider: string
  readonly model: string
  readonly capabilities: string[]
  readonly priority: number
  readonly isEmergency: boolean

  complete(messages: Message[], options?: {
    timeout?: number
    maxTokens?: number
  }): Promise<ProviderResponse>

  health(): Promise<boolean>
}

interface ProviderResponse {
  content: string
  usage: {
    promptTokens: number
    completionTokens: number
  }
  latency: number
  error?: string
}
```

**Who may implement:**
- One class per provider: `GeminiAdapter`, `QwenAdapter`, `OpenAIAdapter`

**Who may call:**
- Execution Engine (only)

**Who may NOT call:**
- Any upper layer

---

### Module: Token Tracker

**Purpose:** Track token usage per restaurant for billing.

**Responsibilities:**
- Count tokens per request
- Accumulate per restaurant
- Expose current usage

**MVP implementation:**
```typescript
interface TokenTracker {
  track(restaurantId: string, tokens: number): void
  getUsage(restaurantId: string): { used: number; limit: number }
  isWithinLimit(restaurantId: string): boolean
}
```

**MVP config:**
```yaml
token_budget:
  default_limit: 10_000_000 tokens/month
  tracking: redis_counter
  enforcement: soft_block  # return error when exceeded
```

**Who may call:**
- Response Handler

**Who may NOT call:**
- Any other module

---

## What the MVP Does NOT Have

The following are intentionally excluded from the MVP:

| Feature | Reason | Version |
|---------|--------|---------|
| Quality Budget | Over-engineering for MVP. Token-only tracking is sufficient. | Commercial |
| Conversation Value Scoring | Premature optimization. MVP uses static policy. | Commercial |
| Provider Benchmarking | No data to benchmark yet. MVP collects data passively. | Commercial |
| Streaming | Adds significant complexity. MVP uses blocking calls. | Commercial |
| Custom Policies | MVP offers 2 built-in policies. Customization comes later. | Commercial |
| Provider Clusters | MVP uses flat priority list. Clusters are optimization. | Commercial |
| Rate Limiting per Account | MVP assumes provider accounts have sufficient quota. | Commercial |
| Multi-region | MVP is single-region. Scale comes later. | Enterprise |
| Provider Ensembles | Extremely complex. Benefit unproven. | Won't Have |
| Circuit Breaker | Over-engineering. Retry + failover is sufficient for MVP. | Commercial |
| Health-based Weighting | MVP uses simple priority. Health is boolean (up/down). | Commercial |
| A/B Testing | Premature. MVP needs baseline first. | Enterprise |
| Automated Prompt Optimization | Future concern. MVP focuses on provider routing. | Won't Have |
| Predictive Failover | Over-engineering. Simple failover is sufficient. | Enterprise |

---

## Commercial Version Additions

When the MVP proves product-market fit, the following are added:

### Quality Budget

```yaml
quality_budget:
  logic: "Each policy costs quality units. High-quality conversations get more units."
  policies:
    standard: 1 unit/call
    premium: 5 units/call
  enforcement:
    units > 50%: no restriction
    units < 20%: standard only
    units < 5%: economy only
```

### Conversation Value Scoring

```yaml
value_scoring:
  factors:
    - customer_tier: { new: 1, returning: 2, vip: 5 }
    - intent: { greeting: 1, complaint: 5, buying: 3 }
  policy_mapping:
    score >= 4: premium
    score >= 2: standard
    score < 2: economy
```

### Health-Weighted Selection

Provider selection uses weighted scoring:
```typescript
score = (successRate * 0.5) + (1 - latency/p95) * 0.3 + (1 - cost/maxCost) * 0.2
```

### Provider Benchmarking

Run identical test queries against all providers weekly:
- Track response quality (1-5)
- Track latency
- Track cost
- Update quality scores (not used for routing yet, only dashboard)

### Streaming

Expose `runtime.stream()` for real-time token delivery. Optional — upper layer chooses.

---

## Enterprise Version Additions

At global scale:

- **Multi-region deployment** — providers selected by geographic latency
- **Custom policies per restaurant** — override weights, block providers
- **Predictive routing** — ML model predicts best provider per request type
- **Cost anomaly detection** — alert when provider costs spike
- **A/B testing framework** — compare provider performance on live traffic
- **Provider SLA dashboard** — real-time provider health for ops team

---

## Interfaces

### Public Interface (MVP)

```typescript
interface LLMRuntime {
  complete(request: RuntimeRequest): Promise<RuntimeResponse>
}

interface RuntimeRequest {
  capability: 'conversation'
  messages: { role: 'system' | 'user' | 'assistant'; content: string }[]
  policy?: 'standard' | 'economy'    // defaults to standard
  restaurantId: string
  context?: {
    conversationId?: string
    customerId?: string
  }
}

interface RuntimeResponse {
  content: string
  usage: {
    promptTokens: number
    completionTokens: number
    totalTokens: number
  }
}
```

### Provider Adapter Interface (MVP)

```typescript
interface ProviderAdapter {
  readonly id: string
  readonly model: string
  readonly capabilities: string[]
  readonly priority: number

  complete(messages: Message[], options?: {
    timeout?: number
    maxTokens?: number
  }): Promise<ProviderResponse>

  health(): Promise<boolean>
}

interface ProviderResponse {
  content: string
  usage: { promptTokens: number; completionTokens: number }
  latency: number
}
```

---

## Events (MVP)

Published:

| Event | Payload | When |
|-------|---------|------|
| `runtime.request.completed` | `{ restaurantId, provider, latency, tokens, error? }` | Every request |
| `runtime.provider.degraded` | `{ providerId }` | Provider fails 3+ consecutive |
| `runtime.provider.recovered` | `{ providerId }` | Provider succeeds after degradation |

Subscribed:

| Event | Handler | Effect |
|-------|---------|--------|
| `system.startup` | Runtime init | Load config, check provider health |
| `restaurant.config.updated` | Config reload | Rebuild provider pool |

---

## Request Lifecycle (MVP)

```
[1. RECEIVE]
    runtime.complete({ capability: 'conversation', messages, policy: 'standard' })
    │
    ▼
[2. SELECT PROVIDER]
    ├── capability = conversation → conversation pool
    ├── Filter: remove unhealthy providers
    ├── Filter: remove emergency_only (unless no other choice)
    ├── Sort by priority
    ├── policy = standard → pick first
    │   policy = economy → pick cheapest (from config)
    └── No healthy provider? → return error
    │
    ▼
[3. EXECUTE]
    ├── Try selected provider
    ├── Timeout after 5000ms? → RETRY
    ├── Error? → RETRY
    ├── Success? → continue
    │
    ▼
[4. RETRY] (max 2 attempts per provider)
    ├── Wait 1000ms
    ├── Retry same provider
    ├── Success? → continue
    ├── Failure? → FAILOVER to next provider
    │
    ▼
[5. FAILOVER]
    ├── Mark current provider as degraded
    ├── Select next provider from pool
    ├── Execute (with retry)
    ├── Success? → continue
    ├── All providers failed? → return error
    │
    ▼
[6. RESPOND]
    ├── Count tokens
    ├── Track usage per restaurant
    ├── Log request
    ├── Update provider health
    └── Return RuntimeResponse
```

---

## Failure Scenarios (MVP)

### Scenario 1: Provider Timeout

```
Provider #1: request → timeout after 5000ms
  → Retry (1000ms delay)
Provider #1: request → success (3000ms)
  → Return response. Log timeout.
```

### Scenario 2: Provider Down

```
Provider #1: request → 503 error
  → Retry (1000ms delay)
Provider #1: request → 503 error
  → Mark as unhealthy. Failover.
Provider #2: request → success
  → Return response. Log failover.
```

### Scenario 3: All Providers Down

```
Provider #1: fail after 2 retries
Provider #2: fail after 2 retries
Provider #3 (emergency): fail after 2 retries
  → Return RuntimeError to AI Engine
  → AI Engine logs critical alert
  → AI Engine sends fallback: "Кешіріңіз, қазір көмектесе алмаймын. Операторға қосамын."
```

### Scenario 4: Budget Exceeded

```
Token Tracker: restaurant usage > 10M tokens
  → Return BudgetExceeded error
  → AI Engine sends: "Бүгінгі лимит аяқталды."
```

---

## Scale Path

### 1 Restaurant (MVP)

```
One process. All providers in memory.
Priority-based selection. Simple health checks.
```

### 10 Restaurants (MVP)

```
Still one process. Restaurant ID in context.
Per-restaurant token tracking.
```

### 100 Restaurants (Commercial)

```
Horizontal scaling. Shared Redis for health state + token tracking.
Provider selection uses shared health data.
```

### 1,000 Restaurants (Commercial)

```
Multiple runtime instances. Load balanced.
Redis-backed health + token tracking.
Per-region provider affinity (optional).
```

### 10,000+ Restaurants (Enterprise)

```
Regional deployment. Regional provider pools.
Global health aggregation. Predictive routing.
```

---

## Observability (MVP)

### Logs

```
Every request: { timestamp, restaurantId, provider, model, latency, tokens, error? }
Every failover: { from, to, reason }
Every degradation: { provider, consecutiveFailures }
```

### Metrics

| Metric | Type | Purpose |
|--------|------|---------|
| `runtime.requests.total` | Counter | Volume |
| `runtime.requests.success` | Counter | Success rate |
| `runtime.requests.failed` | Counter | Error rate |
| `runtime.latency.p50/p95` | Histogram | Performance |
| `runtime.tokens.total` | Counter | Token usage |
| `runtime.provider.healthy` | Gauge | Provider health |
| `runtime.failovers.total` | Counter | Failover frequency |

### Health Endpoints

```
GET /health/runtime      → { status: 'ok', providers: 3, healthy: 2 }
GET /health/providers    → [{ id, healthy, latency_p50, last_error }]
```

---

## Security (MVP)

```yaml
security:
  api_keys:
    storage: encrypted in NocoDB
    access: Runtime only (never exposed to upper layers)
    logged: never (key value not written to logs)

  isolation:
    - restaurant A cannot see restaurant B's token usage
    - restaurant A cannot access restaurant B's provider config

  audit:
    - every provider call: logged with restaurant ID
    - every error: logged with full context (except API keys)
```

---

## Future Provider Addition

Adding a new provider:

1. Create `class NewProviderAdapter implements ProviderAdapter`
2. Add to provider pool config
3. Deploy

Zero changes to:
- LLM Runtime interface
- AI Engine
- Any business logic
- Prompts
- Identity system

---

## What Makes This Architecture Permanent

The architecture is permanent because:

1. **Upper layers never know about providers** — they only request capabilities
2. **Provider adapters are isolated** — each adapter is a single file
3. **Business logic is upstream** — the Runtime is a gateway, not a decision-maker
4. **Configuration drives behavior** — provider selection is config, not code
5. **MVP scales to Enterprise** — the same interface works from 1 to 10,000 restaurants

When a new AI provider arrives that is 10x better and 10x cheaper:
- Write one adapter file (50 lines)
- Add 5 lines to config
- Deploy
- Done

When today's best provider shuts down:
- Remove 5 lines from config
- Deploy
- Done

---

## Open Questions

| # | Question | Resolution |
|---|----------|------------|
| 1 | Should economy policy use a different model on the same provider, or a different provider? | Separate provider with `priority` and `model` — policy picks by priority offset |
| 2 | Should the Runtime accept a `maxTokens` parameter from upper layers? | Yes — pass through to provider adapter |
| 3 | How does the Runtime detect a "degraded" provider in MVP? | 3 consecutive failures = degraded. Health check on next request. |
| 4 | Should the Runtime expose provider info in the response? | No — upper layers must never know. Provider info is for logging only. |
| 5 | How does billing work when a request crosses failover (multiple providers)? | Count tokens from the successful provider only. Failed attempts are billed to operations, not customer. |
| 6 | Should the Runtime cache identical requests? | No — not in MVP. Cache is a Commercial feature. |

---

## Version Comparison

| Feature | MVP | Commercial | Enterprise |
|---------|-----|-----------|------------|
| Provider abstraction | ✅ | ✅ | ✅ |
| Priority-based selection | ✅ | ✅ | ✅ |
| Health-based selection | ❌ boolean only | ✅ weighted | ✅ predictive |
| Retry (2 attempts) | ✅ | ✅ | ✅ |
| Failover (next provider) | ✅ | ✅ | ✅ |
| Emergency provider | ✅ | ✅ | ✅ |
| Token budget | ✅ | ✅ | ✅ |
| Quality budget | ❌ | ✅ | ✅ |
| Conversation value | ❌ | ✅ | ✅ ML-based |
| Provider benchmarking | ❌ | ✅ basic | ✅ full |
| Streaming | ❌ | ✅ | ✅ |
| Custom policies | ❌ | ✅ | ✅ |
| Multi-region | ❌ | ❌ | ✅ |
| A/B testing | ❌ | ❌ | ✅ |
| Predictive routing | ❌ | ❌ | ✅ |
| Provider ensembles | ❌ | ❌ | ❌ |
| Automated fine-tuning | ❌ | ❌ | ❌ |

---

## MVP Summary (What We Ship First)

```
1. One public interface: runtime.complete()
2. One pool: conversation (vision/reasoning/ocr/translation are future)
3. 2-3 provider adapters (Gemini, Qwen, OpenAI)
4. Priority-based provider selection
5. Simple health tracking (up = healthy, 3 failures = down)
6. 2 retries then failover to next provider
7. Token tracking per restaurant (simple counter)
8. 2 policies: standard (priority pick) + economy (cheapest)
9. Logging every request
10. 0 provider info exposed to upper layers

NOT in MVP:
- Quality budget
- Value scoring
- Benchmarking
- Streaming
- Custom policies
- Any feature listed in Commercial or Enterprise above
```

---

_BekzatAI — Restaurant OS depends on capabilities. Never on providers. Every provider is temporary. The architecture is permanent._
