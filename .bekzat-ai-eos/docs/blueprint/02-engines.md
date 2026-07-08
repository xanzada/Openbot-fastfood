# Engines

> **Нұсқа:** 1.0
> **Типі:** Engineering — engine architecture
> **Автор:** BekzatAI Engineering
> **Статус:** Draft

---

## Purpose

Engines are the core processing units of the system. Each engine encapsulates a specific capability. Unlike services, engines are:

- **Stateless** — state lives in state machines and storage
- **Composable** — engines can be combined in pipelines
- **Testable** — each engine can be tested in isolation
- **Swappable** — engine implementations can change without affecting others

---

## Engine Architecture

```
┌────────────────────────────────────────────────────────┐
│                    ENGINE CONTRACT                      │
│  interface Engine<TInput, TOutput> {                   │
│    execute(input: TInput): Promise<TOutput>            │
│  }                                                     │
└────────────────────────────────────────────────────────┘
                              │
        ┌─────────────────────┼─────────────────────┐
        │                     │                     │
        ▼                     ▼                     ▼
┌────────────────┐  ┌────────────────┐  ┌────────────────┐
│  CONVERSATION  │  │   REASONING    │  │    MEMORY      │
│    ENGINE      │  │    ENGINE      │  │    ENGINE      │
├────────────────┤  ├────────────────┤  ├────────────────┤
│ Stateless      │  │ LLM-agnostic   │  │ Short + Long   │
│ State-machine  │  │ Decision maker │  │ term storage   │
│ Context window │  │ Response gen   │  │ Retrieval      │
└────────────────┘  └────────────────┘  └────────────────┘
        │                     │                     │
        └─────────────────────┼─────────────────────┘
                              │
        ┌─────────────────────┼─────────────────────┐
        │                     │                     │
        ▼                     ▼                     ▼
┌────────────────┐  ┌────────────────┐  ┌────────────────┐
│   KNOWLEDGE    │  │   IDENTITY     │  │    PROMPT      │
│    ENGINE      │  │    ENGINE      │  │    ENGINE      │
├────────────────┤  ├────────────────┤  ├────────────────┤
│ Product data   │  │ Personality    │  │ Prompt builder │
│ Business rules │  │ Communication  │  │ Context inject │
│ Availability   │  │ Style config   │  │ Safety bounds  │
└────────────────┘  └────────────────┘  └────────────────┘
        │                     │                     │
        └─────────────────────┼─────────────────────┘
                              │
        ┌─────────────────────┼─────────────────────┐
        │                     │                     │
        ▼                     ▼                     ▼
┌────────────────┐  ┌────────────────┐  ┌────────────────┐
│     TRUST      │  │   RECOVERY     │  │    SALES       │
│    ENGINE      │  │    ENGINE      │  │    ENGINE      │
├────────────────┤  ├────────────────┤  ├────────────────┤
│ Output valid.  │  │ Error handling │  │ Recommend.     │
│ Safety check   │  │ Retry + fallbk │  │ Upsell         │
│ Ethics enforce │  │ Escalation     │  │ Promotions     │
└────────────────┘  └────────────────┘  └────────────────┘
```

---

## Engine: Conversation Engine

**Purpose:** Manage the conversation lifecycle — what has been said, what state we're in, what to do next.

```
Input:  IncomingMessage + ConversationState
Process:
  1. Load conversation from Memory Engine
  2. Validate state (is conversation active?)
  3. Update context (add new message)
  4. Determine next action
  5. Return updated state + instruction
Output: ConversationContext + NextAction
```

**Key Methods:**
- `startConversation(customer, restaurant)` — create new session
- `processMessage(message, context)` — add message, update state
- `getContext(customer, restaurant)` — retrieve current context
- `endConversation(context)` — close session, trigger memory storage
- `timeoutCheck()` — check for stale conversations

**Dependencies:**
- Memory Engine (session data)
- State Machine (conversation states)

**Status:** Partially exists. Needs formal state machine and context window management.

---

## Engine: Reasoning Engine

**Purpose:** The decision-making center. Combines business logic, LLM input, and context to decide what to do.

This is the most critical engine. It must be completely LLM-agnostic.

```
Input: ConversationContext + BusinessContext
Process:
  1. Receive full context (conversation, knowledge, identity, memory)
  2. Determine if LLM is needed (simple queries may not need LLM)
  3. If LLM needed:
     a. Call Prompt Engine to construct prompt
     b. Call LLM Provider Adapter
     c. Parse and validate response via Trust Engine
  4. If no LLM needed:
     a. Apply business rules directly
  5. Make decision (respond, execute skill, escalate)
  6. Return decision
Output: Decision (Response | SkillCall | Escalation | Transfer)
```

**Key Methods:**
- `decide(context)` — main decision method
- `needsLLM(context)` — determine if LLM is required
- `fallbackResponse(context)` — non-LLM response for simple cases
- `parseDecision(raw)` — parse LLM output into structured decision

**Dependencies:**
- Prompt Engine
- LLM Provider Adapter (see interfaces.md)
- Trust Engine
- Knowledge Engine

**Status:** ❌ Needs complete redesign. Current logic tightly couples business rules with LLM prompts.

---

## Engine: Memory Engine

**Purpose:** Manage all system memory.

```
Input: MemoryRequest (store | retrieve | forget)
Process:
  1. Determine memory type (short-term vs long-term)
  2. Execute storage/retrieval operation
  3. Index for fast retrieval
  4. Handle expiration (TTL for short-term)
Output: MemoryResult
```

**Key Methods:**
- `storeConversation(context)` — save to short-term (Redis)
- `storeCustomerPreference(customer, data)` — save to long-term (DLE)
- `getRelevantContext(customer, query)` — retrieve relevant memories
- `expireSession(sessionId)` — clean up stale sessions

**Dependencies:**
- Redis (short-term)
- DLE (long-term)

**Status:** ✅ Partially exists. Short-term (Redis) and long-term (DLE) exist. Formal memory retrieval is missing.

---

## Engine: Knowledge Engine

**Purpose:** Provide business data to other engines.

```
Input: KnowledgeQuery (product name, category, price range, etc.)
Process:
  1. Parse query into structured request
  2. Check cache (Redis)
  3. If cache miss, query DLE
  4. Format result
  5. Cache for future
Output: KnowledgeResult
```

**Key Methods:**
- `getProduct(name, restaurant)` — find product by name
- `searchProducts(query, restaurant)` — search by keyword
- `getCategory(categoryId)` — get category with products
- `checkAvailability(productId)` — is product available now?
- `getBusinessRules(restaurant)` — operating hours, delivery zones

**Dependencies:**
- DLE (source of truth)
- Redis (cache)

**Status:** ✅ Partially exists. Needs formal abstraction layer.

---

## Engine: Identity Engine

**Purpose:** Provide restaurant personality and communication style configuration.

```
Input: IdentityRequest (restaurantId, context)
Process:
  1. Load identity config from NocoDB
  2. Apply context-based adjustments (first visit vs VIP)
  3. Validate against Restaurant Values & Ethics
  4. Return style parameters
Output: IdentityContext (tone, style, energy, rules)
```

**Key Methods:**
- `getIdentity(restaurantId)` — load full identity config
- `getCommunicationStyle(restaurantId, context)` — get style params
- `getSalesStyle(restaurantId)` — sales approach config
- `getGreeting(restaurantId, customer)` — contextual greeting
- `validateAction(action, identity)` — does action fit identity?

**Dependencies:**
- NocoDB (identity configuration)
- Restaurant Values & Ethics (bounds)

**Status:** ❌ Does not exist as a formal engine.

---

## Engine: Prompt Engine

**Purpose:** Construct prompts from structured business context, not from hardcoded templates.

```
Input: PromptRequest (context, identity, business data)
Process:
  1. Analyze what needs to be in the prompt
  2. Select prompt structure based on task type
  3. Inject business context (products, rules, memory)
  4. Apply identity parameters (tone, style, rules)
  5. Apply safety constraints
  6. Return constructed prompt + metadata
Output: ConstructedPrompt + PromptMetadata
```

**Key Methods:**
- `constructPrompt(task, context, identity)` — build prompt
- `injectBusinessData(prompt, knowledge)` — add products, rules
- `applyIdentity(prompt, identity)` — add style parameters
- `applySafety(prompt, ethics)` — add constraints
- `validatePrompt(prompt)` — check structure and safety

**Dependencies:**
- Identity Engine
- Knowledge Engine
- Memory Engine
- Restaurant Values & Ethics

**Status:** ❌ Needs redesign. Current prompts are templates. Should be a dynamic construction system.

---

## Engine: Trust Engine

**Purpose:** Ensure all AI output is safe, accurate, and ethical.

```
Input: TrustCheck (LLM output, context, rules)
Process:
  1. Check for hallucinated data (products that don't exist)
  2. Check for policy violations
  3. Check for prompt injection in customer message
  4. Check for identity violations
  5. Validate business rules
  6. Return verdict (approve | reject | modify)
Output: TrustVerdict
```

**Key Methods:**
- `validateOutput(response, context)` — full output validation
- `detectHallucination(response, knowledge)` — check against known data
- `checkPolicy(response)` — policy enforcement
- `detectInjection(message)` — prompt injection detection
- `sanitize(response)` — remove unsafe content

**Dependencies:**
- Knowledge Engine
- Identity Engine
- Restaurant Values & Ethics

**Status:** ❌ Does not exist as a formal engine.

---

## Engine: Recovery Engine

**Purpose:** Handle failures gracefully at every level.

```
Input: Error (exception, timeout, invalid response)
Process:
  1. Classify error type (LLM failure, skill failure, timeout)
  2. Check retry policy (how many retries, backoff)
  3. If retries exhausted, prepare fallback
  4. If cannot recover, prepare escalation
  5. Execute recovery action
Output: RecoveryAction (retry | fallback | escalate | ignore)
```

**Key Methods:**
- `classifyError(error)` — determine error type and severity
- `shouldRetry(error, attemptCount)` — retry policy
- `getFallback(context)` — simplified fallback response
- `escalateToHuman(context, reason)` — transfer to operator
- `trackFailure(error)` — log for analytics

**Dependencies:**
- Conversation Engine
- Analytics Engine

**Status:** ❌ Does not exist as a formal engine.

---

## Engine: Sales Engine

**Purpose:** Generate sales recommendations and upsell opportunities.

```
Input: SalesRequest (customer context, business context)
Process:
  1. Analyze customer history and preferences
  2. Check current promotions and popular items
  3. Apply identity sales style (gentle vs active)
  4. Generate recommendation
  5. Return recommendation + justification
Output: SalesRecommendation
```

**Key Methods:**
- `getRecommendation(customer, context)` — main recommendation
- `getUpsell(currentOrder, customer)` — upsell opportunity
- `getPromotionalMessage() ` — current promotion text
- `trackEffectiveness(recommendation, result)` — learn what works

**Dependencies:**
- Knowledge Engine
- Identity Engine
- Memory Engine

**Status:** ❌ Does not exist as a formal engine.

---

## Engine: Analytics Engine

**Purpose:** Collect, process, and learn from system data.

```
Input: AnalyticsEvent (any system event)
Process:
  1. Receive event
  2. Classify and store
  3. Update metrics
  4. Trigger learning if applicable
  5. Generate insights
Output: Metrics | Insights | LearningSignals
```

**Key Methods:**
- `logEvent(event)` — store event
- `getMetric(name, period)` — retrieve metric
- `generateInsights(restaurantId)` — pattern detection
- `getLearningSignal()` — what should the system learn?

**Dependencies:**
- All engines (as event sources)
- Storage (event store)

**Status:** ✅ Partially exists. Logging exists. Analytics as learning system does not.

---

## Engine: Billing Engine

**Purpose:** Track and enforce usage limits.

```
Input: UsageEvent
Process:
  1. Track LLM tokens, API calls, storage
  2. Check against plan limits
  3. Enforce limits (warn, restrict, block)
  4. Generate billing records
Output: UsageStatus | BillingRecord
```

**Key Methods:**
- `trackUsage(event)` — record usage
- `checkLimit(restaurantId)` — is restaurant within limits?
- `enforceLimit(restaurantId)` — action when limit exceeded

**Dependencies:**
- NocoDB (plan configuration)

**Status:** ✅ Exists. Well-designed.

---

## Engine Composition

Engines should be composed, not nested.

**Wrong:**
```
ReasoningEngine calls ConversationEngine calls MemoryEngine
```

**Right:**
```
Pipeline orchestrates:
  1. ConversationEngine.processMessage()
  2. MemoryEngine.getContext()
  3. ReasoningEngine.decide()
  4. MemoryEngine.store()
```

Engines should not call each other directly. The pipeline/orchestrator controls the flow.

---

## Engine Guidelines

1. **Engines are stateless** — no internal state
2. **Engines receive context, return results** — no side effects outside their scope
3. **Engines are testable in isolation** — mock dependencies, test behavior
4. **Engines throw typed errors** — no generic exceptions
5. **Engines log their decisions** — every decision is traceable
6. **Engines respect identity** — all behavior is filtered through restaurant identity
7. **Engines respect ethics** — all behavior is bounded by Restaurant Values & Ethics

---

## Which Engines Should NOT Exist

Some suggested engines were intentionally excluded:

| Proposed Engine | Reason for Exclusion |
|----------------|---------------------|
| Formatting Engine | This is a pipeline concern, not an engine. Formatting is a transformation step in the Response Pipeline. |
| Learning Engine | This is a cross-cutting concern. Learning happens in Analytics Engine + is applied by other engines. |
| Notification Engine | This is a channel concern. Notifications are sent through Channel Modules. |
| Monitoring Engine | This is infrastructure, not business logic. Belongs in operations layer. |
| Plugin Engine | This is Plugin Manager (a module), not an engine. Plugin management is architectural, not processing. |
| Planning Engine | Future concern. Not needed until multi-step autonomous workflows are required. |

---

_BekzatAI — Engines are pure logic. State is elsewhere. Flow is in pipelines._
