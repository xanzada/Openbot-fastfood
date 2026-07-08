# AI Engine Architecture

> **Нұсқа:** 1.0
> **Типі:** Engineering — AI Engine specification
> **Автор:** BekzatAI Engineering
> **Статус:** Draft

---

## Purpose

Define the complete internal architecture of the AI Engine — the core reasoning system of Restaurant OS.

The AI Engine is responsible for:
- Understanding customer messages
- Making decisions (with or without LLM)
- Executing skills
- Generating responses
- Ensuring safety and trust

The AI Engine knows nothing about:
- WhatsApp, Telegram, or any channel
- OpenAI, Gemini, or any LLM
- DLE, Redis, or any storage system
- The outside world

Everything external connects through adapters.

---

## Architectural Principles

### Principle 1: Strict Layering

Modules live in layers. A module may only depend on modules in the same layer or below. Never upward.

```
Layer 0: Adapters     (LLM, Storage, Channel — abstracted)
Layer 1: Foundation   (Memory, Knowledge, Tokens)
Layer 2: Understanding (Context, Intent, Business Rules)
Layer 3: Decision     (Decision, Conversation, Skills)
Layer 4: Reasoning    (Prompt construction)
Layer 5: Safety       (Trust, Validation)
Layer 6: Response     (Planning, Formatting)
Layer 7: Orchestration (AI Orchestrator)
Layer 8: Observability (Logging, Analytics)
```

### Principle 2: No Circular Dependencies

If module A calls module B, module B must never call module A — directly or indirectly.

### Principle 3: One Direction

Data flows in one direction: Message → Understanding → Decision → Action → Response.

### Principle 4: Business Rules Are Sacred

Business rules live ONLY in Business Rule Engine. No prompt contains business rules. No LLM is asked to make business decisions.

### Principle 5: LLM Is a Service

The LLM is treated as a reasoning service, not a decision-maker. It receives context and returns suggestions. The system decides what to do with those suggestions.

---

## Layer Diagram

```
┌─────────────────────────────────────────────────────────────────────┐
│                        LAYER 8: OBSERVABILITY                        │
│  Conversation Logger │ Analytics Collector │ Feedback Collector      │
├─────────────────────────────────────────────────────────────────────┤
│                        LAYER 7: ORCHESTRATION                        │
│                         AI Orchestrator                              │
├─────────────────────────────────────────────────────────────────────┤
│                        LAYER 6: RESPONSE                             │
│           Response Planner │ Response Formatter                      │
├─────────────────────────────────────────────────────────────────────┤
│                        LAYER 5: SAFETY                               │
│                Trust Engine │ Safety Layer                           │
├─────────────────────────────────────────────────────────────────────┤
│                        LAYER 4: REASONING                            │
│          Prompt Engine │ Prompt Loader │ Prompt Composer             │
├─────────────────────────────────────────────────────────────────────┤
│                        LAYER 3: DECISION                             │
│  Decision Engine │ Conversation Engine │ Skill Engine │ Skill Router │
├─────────────────────────────────────────────────────────────────────┤
│                        LAYER 2: UNDERSTANDING                        │
│     Context Builder │ Intent Engine │ Business Rule Engine           │
├─────────────────────────────────────────────────────────────────────┤
│                        LAYER 1: FOUNDATION                           │
│              Memory Engine │ Knowledge Engine │ Token Manager        │
├─────────────────────────────────────────────────────────────────────┤
│                        LAYER 0: ADAPTERS                             │
│   LLM Provider Adapter │ Plugin Manager │ Tool Executor              │
└─────────────────────────────────────────────────────────────────────┘
```

---

## Dependency Graph

```
AI Orchestrator (L7)
  │
  ├──→ Context Builder (L2)
  │     ├──→ Memory Engine (L1)
  │     └──→ Knowledge Engine (L1)
  │
  ├──→ Intent Engine (L2)
  │     └──→ Context Builder (L2)
  │
  ├──→ Business Rule Engine (L2)
  │     └──→ Knowledge Engine (L1)
  │
  ├──→ Decision Engine (L3)
  │     ├──→ Context Builder (L2)
  │     ├──→ Intent Engine (L2)
  │     └──→ Business Rule Engine (L2)
  │
  ├──→ Conversation Engine (L3)
  │     └──→ Memory Engine (L1)
  │
  ├──→ Skill Engine (L3)
  │     ├──→ Skill Router (L3)
  │     └──→ Tool Executor (L0)
  │
  ├──→ Prompt Engine (L4)
  │     ├──→ Prompt Loader (L4)
  │     ├──→ Prompt Composer (L4)
  │     ├──→ Context Builder (L2)
  │     └──→ Decision Engine (L3)
  │
  ├──→ LLM Provider Adapter (L0)
  │     └──→ Token Manager (L1)
  │
  ├──→ Trust Engine (L5)
  │     ├──→ Safety Layer (L5)
  │     ├──→ Knowledge Engine (L1)
  │     └──→ Business Rule Engine (L2)
  │
  ├──→ Response Planner (L6)
  │     ├──→ Trust Engine (L5)
  │     └──→ Context Builder (L2)
  │
  ├──→ Response Formatter (L6)
  │     └──→ Plugin Manager (L0)
  │
  └──→ Conversation Logger (L8)
        └──→ Analytics Collector (L8), Feedback Collector (L8)
```

**Key rule:** Arrow direction = dependency. If A → B, A calls B. B never calls A.

---

## Complete Request Lifecycle

```
1. INCOMING
   Channel Adapter → NormalizedMessage → AI Orchestrator

2. CONTEXT
   AI Orchestrator → Context Builder
   Context Builder → Memory Engine (load history)
   Context Builder → Knowledge Engine (load products)
   Context Builder returns: full context

3. UNDERSTAND
   AI Orchestrator → Intent Engine (determine intent)
   AI Orchestrator → Business Rule Engine (check hard rules)

4. DECIDE
   AI Orchestrator → Decision Engine
   Decision Engine returns: decision type
     (direct_response | llm_reasoning | skill_only | escalate)

5. EXECUTE
   if direct_response:
     → Business Rule Engine → Response Planner

   if llm_reasoning:
     → Prompt Engine → Prompt Loader → Prompt Composer
     → LLM Provider Adapter → raw response
     → Trust Engine → validated response
     → Decision Engine (re-parse LLM output)
     → if skill_needed: → Skill Engine → Skill Router → Tool Executor
     → Response Planner

   if skill_only:
     → Skill Engine → Skill Router → Tool Executor
     → Response Planner

   if escalate:
     → Escalation Orchestrator (external)

6. RESPOND
   Response Planner → Response Plan
   Response Formatter → FormattedResponse
   AI Orchestrator → Channel Adapter (for sending)

7. OBSERVE
   Conversation Logger → log everything
   Analytics Collector → update metrics
   Feedback Collector → store for learning
```

---

## Module Specifications

---

### Module: AI Orchestrator

**Layer:** 7 (Orchestration)

**Purpose:** The entry point and controller of the AI Engine. It receives incoming messages and coordinates all other modules to produce a response.

**Responsibilities:**
- Receive normalized messages from Channel Adapter
- Orchestrate the full request lifecycle
- Handle timeout at the top level
- Coordinate error recovery
- Return response to caller

**Inputs:**
- `NormalizedMessage` (from Channel Adapter)

**Outputs:**
- `FormattedResponse` (to Channel Adapter)

**Dependencies:**
- All modules below Layer 7

**Who may call it:**
- Channel Adapter (external, through interface)
- No one internal

**Who may NOT call it:**
- No internal module may call AI Orchestrator

**Events it publishes:**
- `ai.lifecycle.started` — when processing begins
- `ai.lifecycle.completed` — when processing ends
- `ai.lifecycle.failed` — when processing fails

**Events it listens to:**
- None (it is the entry point)

**Implementation:**
```typescript
class AIOrchestrator {
  async process(message: NormalizedMessage): Promise<FormattedResponse> {
    const context = await this.contextBuilder.build(message)
    const intent = await this.intentEngine.determine(context)
    const rules = await this.businessRuleEngine.check(context, intent)
    const decision = await this.decisionEngine.decide(context, intent, rules)

    let response: ResponsePlan
    if (decision.type === 'direct') {
      response = await this.responsePlanner.fromRules(decision)
    } else if (decision.type === 'llm') {
      const prompt = await this.promptEngine.build(decision, context)
      const raw = await this.llmAdapter.complete(prompt)
      const validated = await this.trustEngine.validate(raw, context)
      const result = await this.decisionEngine.parse(validated, context)
      if (result.skill) {
        const toolResult = await this.skillEngine.execute(result.skill)
        response = await this.responsePlanner.fromTool(toolResult, context)
      } else {
        response = await this.responsePlanner.fromLLM(validated, context)
      }
    } else if (decision.type === 'skill') {
      const toolResult = await this.skillEngine.execute(decision.skill)
      response = await this.responsePlanner.fromTool(toolResult, context)
    } else {
      response = await this.responsePlanner.escalate(decision)
    }

    const formatted = await this.responseFormatter.format(response, message.channel)
    await this.conversationLogger.log(message, decision, response, formatted)
    return formatted
  }
}
```

---

### Module: Context Builder

**Layer:** 2 (Understanding)

**Purpose:** Gather all relevant context for the current message — conversation history, customer profile, products, identity, business rules — into a single structured context object.

**Responsibilities:**
- Load conversation history from Memory Engine
- Load customer profile from Memory Engine
- Load restaurant knowledge from Knowledge Engine
- Load identity configuration
- Assemble everything into a unified context
- Ensure context is current (non-stale)

**Inputs:**
- `NormalizedMessage` (customerId, restaurantId, text)
- Message metadata (timestamp, channel)

**Outputs:**
- `UnifiedContext` (all context in one structure)

**Dependencies:**
- Memory Engine (L1)
- Knowledge Engine (L1)
- Identity Engine (external, through interface)

**Who may call it:**
- AI Orchestrator (L7)
- Decision Engine (L3) — read-only access
- Prompt Engine (L4) — read-only access
- Response Planner (L6) — read-only access

**Who may NOT call it:**
- Modules in Layer 0 or 1
- External systems

**Events it publishes:**
- `context.built` — when context is assembled
- `context.failed` — when context assembly fails

**Events it listens to:**
- `customer.updated` — invalidate customer cache
- `product.updated` — invalidate product cache

**Context structure:**
```typescript
interface UnifiedContext {
  customer: {
    id: string
    name?: string
    isFirstVisit: boolean
    isVIP: boolean
    preferences: CustomerPreferences
    recentOrders: OrderSummary[]
  }
  conversation: {
    history: Message[]
    state: ConversationState
    duration: number
    messageCount: number
  }
  knowledge: {
    products: ProductSummary[]
    categories: Category[]
    businessRules: BusinessRules
    identity: IdentityConfig
  }
  message: {
    text: string
    intent?: Intent
    entities?: Entity[]
    language: string
  }
  metadata: {
    timestamp: number
    restaurantId: string
    traceId: string
  }
}
```

---

### Module: Intent Engine

**Layer:** 2 (Understanding)

**Purpose:** Determine what the customer wants — order, question, complaint, greeting, etc.

**Responsibilities:**
- Analyze message text for intent
- Extract entities (product names, quantities, prices)
- Classify intent type
- Provide confidence score
- Handle unclear intents (ask for clarification)

**Inputs:**
- `UnifiedContext` (from Context Builder)

**Outputs:**
- `IntentResult` (intent type, entities, confidence)

**Dependencies:**
- Context Builder (L2) — for context

**Who may call it:**
- AI Orchestrator (L7)
- Decision Engine (L3)

**Who may NOT call it:**
- Any module in Layer 4, 5, 6, 8

**Events it publishes:**
- `intent.determined` — with intent type and confidence

**Events it listens to:**
- None

**Intent types:**
```typescript
type IntentType =
  | 'order'          // wants to place order
  | 'menu_inquiry'   // asks about menu/products
  | 'general_question' // general restaurant info
  | 'complaint'      // has a problem
  | 'greeting'       // saying hello
  | 'farewell'       // ending conversation
  | 'feedback'       // giving feedback
  | 'request_human'  // wants operator
  | 'unknown'        // cannot determine
```

**Implementation guidance:**
- Uses pattern matching + classification (not LLM for common intents)
- Falls back to LLM only for ambiguous cases
- Maintains a list of per-restaurant custom patterns

---

### Module: Business Rule Engine

**Layer:** 2 (Understanding)

**Purpose:** Enforce all business rules. This is the ONLY place where business logic lives.

**Responsibilities:**
- Check operating hours
- Validate product availability
- Check delivery zones
- Apply pricing rules
- Check minimum order amounts
- Verify customer eligibility
- Apply business-specific policies

**Inputs:**
- `UnifiedContext` (from Context Builder)
- `IntentResult` (from Intent Engine)

**Outputs:**
- `RuleCheckResult` (rule violations, warnings, info)

**Dependencies:**
- Knowledge Engine (L1) — for product data, rules

**Who may call it:**
- AI Orchestrator (L7)
- Decision Engine (L3)
- Trust Engine (L5) — for validation

**Who may NOT call it:**
- Prompt Engine (L4)
- LLM Provider Adapter (L0)
- Any external system

**Events it publishes:**
- `rule.violation` — when a business rule is violated
- `rule.checked` — with results

**Events it listens to:**
- `product.availability.changed` — update internal state
- `restaurant.hours.changed` — update operating hours

**Critical constraint:**
```
NEVER:
- This module is NEVER called from Prompt Engine
- Business rules are NEVER embedded in prompts
- LLM is NEVER asked to make business decisions

ALWAYS:
- Business rules are checked BEFORE LLM is called
- LLM only receives rule-checked context
- LLM cannot override business rules
```

---

### Module: Decision Engine

**Layer:** 3 (Decision)

**Purpose:** Determine how to handle the current message — direct response, LLM reasoning, skill execution, or escalation.

**Responsibilities:**
- Evaluate intent and business rules
- Decide if LLM is needed
- Select the processing path
- Parse LLM output into structured decisions
- Handle edge cases (unsure, ambiguous)

**Inputs:**
- `UnifiedContext`
- `IntentResult`
- `RuleCheckResult`

**Outputs:**
- `Decision` (path type, parameters)

**Decision types:**
```typescript
type Decision =
  | { type: 'direct_response'; response: string }
  | { type: 'llm_reasoning'; prompt: Prompt; context: any }
  | { type: 'skill_only'; skill: SkillCall }
  | { type: 'llm_with_skill'; prompt: Prompt; skill: SkillCall }
  | { type: 'escalate'; reason: string }
  | { type: 'clarify'; question: string }
```

**Dependencies:**
- Context Builder (L2)
- Intent Engine (L2)
- Business Rule Engine (L2)

**Who may call it:**
- AI Orchestrator (L7)
- Prompt Engine (L4) — for re-parsing after LLM

**Who may NOT call it:**
- LLM Provider Adapter (L0)
- Response Planner (L6)

**Events it publishes:**
- `decision.made` — with decision type and reasoning

**Events it listens to:**
- None

**Decision rules:**
```
1. If Business Rule Engine returns clear answer:
   → direct_response (no LLM needed)

2. If intent is simple and deterministic:
   → direct_response (no LLM needed)

3. If intent is complex or requires reasoning:
   → llm_reasoning

4. If customer explicitly asks for human:
   → escalate

5. If intent is unclear:
   → clarify (ask question)
```

---

### Module: Conversation Engine

**Layer:** 3 (Decision)

**Purpose:** Manage conversation state and lifecycle. Track where the conversation is and what should happen next.

**Responsibilities:**
- Load and manage conversation state
- Track conversation stage (greeting, ordering, confirming, etc.)
- Detect conversation timeouts
- Handle conversation transitions
- Provide state to other modules

**Inputs:**
- `UnifiedContext`
- `Decision` (to update state)

**Outputs:**
- `ConversationState` (current state)
- State transition events

**Dependencies:**
- Memory Engine (L1) — for state storage

**Who may call it:**
- AI Orchestrator (L7)
- No other module

**Who may NOT call it:**
- All modules below L3

**Events it publishes:**
- `conversation.state.changed` — from/to/reason
- `conversation.timeout` — conversation expired
- `conversation.ended` — conversation closed

**Events it listens to:**
- `decision.made` — to update state
- `message.received` — to track activity

**States:**
```typescript
type ConversationStage =
  | 'opening'    // greeting/opening
  | 'exploring'  // customer exploring options
  | 'ordering'   // in order process
  | 'confirming' // confirming order details
  | 'resolving'  // handling issue
  | 'closing'    // ending conversation
  | 'escalated'  // transferred to human
```

---

### Module: Prompt Engine

**Layer:** 4 (Reasoning)

**Purpose:** Construct the complete prompt for LLM reasoning. This is a prompt engineering system, not a template system.

**Responsibilities:**
- Accept decision and context
- Call Prompt Loader to get base components
- Call Prompt Composer to assemble final prompt
- Ensure prompt follows identity configuration
- Ensure prompt contains no business rules (only contextual data)
- Track prompt version for observability

**Inputs:**
- `Decision` (from Decision Engine)
- `UnifiedContext` (from Context Builder)

**Outputs:**
- `ConstructedPrompt` (ready for LLM)

**Dependencies:**
- Prompt Loader (L4)
- Prompt Composer (L4)
- Context Builder (L2)
- Decision Engine (L3)

**Who may call it:**
- AI Orchestrator (L7)

**Who may NOT call it:**
- Any module in Layer 0, 1, 2, 3, 5, 6

**Events it publishes:**
- `prompt.constructed` — with prompt metadata

**Events it listens to:**
- `identity.updated` — reload identity-based prompt components

**Critical constraints:**
```
NEVER:
- Prompt Engine NEVER generates business rules
- Prompt Engine NEVER asks LLM to make business decisions
- Prompts contain context, not rules

ALWAYS:
- "Here is the menu" (business data from Knowledge Engine)
- "Customer asked: ..." (context from Conversation Engine)
- "Be polite and helpful" (identity from Identity Engine)
- NOT: "If customer orders after 10PM, say no" (that's a Business Rule)
```

---

### Module: Prompt Loader

**Layer:** 4 (Reasoning)

**Purpose:** Load prompt components from storage. Separate prompt storage from prompt construction.

**Responsibilities:**
- Load prompt templates by type and restaurant identity
- Load system instructions from persistent storage
- Manage prompt versioning
- Cache loaded prompts
- Support A/B testing of prompt variants

**Inputs:**
- Prompt type identifier
- Restaurant identity ID

**Outputs:**
- `PromptComponent[]` (base prompt parts)

**Dependencies:**
- Knowledge Engine (L1) — for prompt templates (stored in config)

**Who may call it:**
- Prompt Engine (L4)

**Who may NOT call it:**
- Any module outside L4

**Events it publishes:**
- `prompt.loaded` — prompt loaded from storage

**Events it listens to:**
- `prompt.updated` — invalidate prompt cache

**Prompt storage:**
```
Prompts are stored in NocoDB (or future dedicated config store):
- Separated by: restaurant, language, prompt type, version
- Loaded at startup and cached in Redis
- Hot-reloadable without restart
```

---

### Module: Prompt Composer

**Layer:** 4 (Reasoning)

**Purpose:** Assemble the final prompt from components, context, and identity parameters.

**Responsibilities:**
- Combine base prompt + context + identity
- Apply formatting rules (length, structure)
- Ensure token budget is respected
- Produce final prompt string

**Inputs:**
- `PromptComponent[]` (from Prompt Loader)
- `UnifiedContext` (from Context Builder)
- `IdentityConfig` (from Identity Engine)

**Outputs:**
- `ConstructedPrompt` (final prompt with metadata)

**Dependencies:**
- Prompt Loader (L4)
- Context Builder (L2)

**Who may call it:**
- Prompt Engine (L4)

**Who may NOT call it:**
- Any module outside L4

**Events it publishes:**
- `prompt.composed` — with final prompt size and structure

**Events it listens to:**
- None

**Prompt structure:**
```
[System Instructions]
  → from Prompt Loader (identity, tone, rules of conduct)

[Context]
  → from Context Builder (products, hours, policies)

[Conversation History]
  → from Context Builder (recent messages)

[Customer Message]
  → the current message

[Instructions]
  → what to do with this information
```

---

### Module: LLM Provider Adapter

**Layer:** 0 (Adapter)

**Purpose:** Abstract all LLM providers behind a single interface. This is the ONLY module that knows about LLM providers.

**Responsibilities:**
- Implement the LLM provider interface
- Translate internal requests to provider-specific format
- Handle provider-specific errors
- Implement retry logic for transient failures
- Report token usage

**Inputs:**
- `LLMRequest` (from Prompt Engine via AI Orchestrator)

**Outputs:**
- `LLMResponse` (raw, unvalidated)

**Dependencies:**
- Token Manager (L1)

**Who may call it:**
- AI Orchestrator (L7)

**Who may NOT call it:**
- Any module except AI Orchestrator

**Events it publishes:**
- `llm.started` — LLM call initiated
- `llm.completed` — LLM call returned
- `llm.failed` — LLM call failed
- `llm.tokens.used` — token count

**Events it listens to:**
- None

**Interface:**
```typescript
interface LLMProviderAdapter {
  complete(request: LLMRequest): Promise<LLMResponse>
  stream?(request: LLMRequest): AsyncIterable<LLMResponseChunk>
}

interface LLMRequest {
  messages: { role: 'system' | 'user' | 'assistant'; content: string }[]
  tools?: ToolDefinition[]
  temperature?: number
  maxTokens?: number
  responseFormat?: 'text' | 'json'
}

interface LLMResponse {
  content: string
  toolCalls?: ToolCall[]
  usage: { promptTokens: number; completionTokens: number; totalTokens: number }
  finishReason: 'stop' | 'length' | 'tool_calls' | 'error'
  latency: number
  provider: string
  model: string
}
```

**Provider isolation:**
```
Adapter wraps each provider:
  OpenAIAdapter    → implements LLMProviderAdapter
  GeminiAdapter    → implements LLMProviderAdapter
  QwenAdapter      → implements LLMProviderAdapter
  ClaudeAdapter    → implements LLMProviderAdapter

The rest of the AI Engine has no idea which provider is being used.
Provider selection is configuration, not code.
```

---

### Module: Token Manager

**Layer:** 1 (Foundation)

**Purpose:** Track and manage LLM token usage for cost control and budgeting.

**Responsibilities:**
- Count tokens in requests
- Track running token usage per restaurant
- Enforce token limits per request/period
- Provide token cost estimates
- Report usage to Billing Engine

**Inputs:**
- Token count request
- Usage report from LLM Provider Adapter

**Outputs:**
- Token count
- Usage status (within limits / approaching limit / exceeded)

**Dependencies:**
- None (pure calculation + Redis for counters)

**Who may call it:**
- LLM Provider Adapter (L0)
- AI Orchestrator (L7)

**Who may NOT call it:**
- Modules in L2, L3, L4, L5, L6

**Events it publishes:**
- `token.usage.warning` — approaching limit
- `token.usage.exceeded` — limit hit
- `token.budget.updated` — daily budget changed

**Events it listens to:**
- None

---

### Module: Knowledge Engine

**Layer:** 1 (Foundation)

**Purpose:** Provide access to all restaurant business knowledge. Abstracts the underlying storage (DLE, NocoDB).

**Responsibilities:**
- Load and cache product data
- Provide search by name, category, price
- Answer queries about business rules (hours, location, policies)
- Cache aggressively, invalidate on updates

**Inputs:**
- `KnowledgeQuery` (product name, category, text search)

**Outputs:**
- `KnowledgeResult` (products, business rules, categories)

**Dependencies:**
- None (uses storage adapters internally)

**Who may call it:**
- Context Builder (L2)
- Business Rule Engine (L2)
- Trust Engine (L5)
- Response Planner (L6)

**Who may NOT call it:**
- Prompt Engine (L4)
- LLM Provider Adapter (L0)

**Events it publishes:**
- `knowledge.queried` — query and results
- `knowledge.cache.updated` — cache refresh

**Events it listens to:**
- `product.updated` — invalidate cache
- `restaurant.config.updated` — invalidate business rules cache

---

### Module: Memory Engine

**Layer:** 1 (Foundation)

**Purpose:** Manage all conversation and customer memory. Abstracts short-term (Redis) and long-term (DLE) storage.

**Responsibilities:**
- Store conversation history
- Retrieve conversation history by customer
- Store and retrieve customer preferences
- Manage memory TTL (short-term vs long-term)
- Provide episodic memory (specific past events)

**Inputs:**
- `MemoryQuery` (customer ID, time range, type)

**Outputs:**
- `MemoryResult` (history, preferences, events)

**Dependencies:**
- None (uses storage adapters internally)

**Who may call it:**
- Context Builder (L2)
- Conversation Engine (L3)

**Who may NOT call it:**
- Prompt Engine (L4)
- LLM Provider Adapter (L0)
- Trust Engine (L5)

**Events it publishes:**
- `memory.stored` — new memory saved
- `memory.retrieved` — memory accessed
- `memory.expired` — memory TTL expired

**Events it listens to:**
- `conversation.ended` — trigger memory consolidation

**Memory structure:**
```typescript
interface MemoryQuery {
  customerId: string
  restaurantId: string
  types: ('conversation' | 'preference' | 'order' | 'event')[]
  limit?: number
  timeRange?: { from: number; to: number }
}

interface MemoryResult {
  conversations: ConversationSummary[]
  preferences: CustomerPreferences
  recentOrders: OrderSummary[]
  events: CustomerEvent[]
}
```

---

### Module: Skill Engine

**Layer:** 3 (Decision)

**Purpose:** Manage and execute skills (tools/actions that the AI can perform).

**Responsibilities:**
- Match decision to appropriate skill
- Validate skill parameters
- Execute skill through Tool Executor
- Handle skill results
- Manage skill lifecycle (register, unregister)

**Inputs:**
- `SkillCall` (from Decision Engine or parsed LLM output)

**Outputs:**
- `SkillResult` (success/failure, data, error)

**Dependencies:**
- Skill Router (L3)
- Tool Executor (L0)

**Who may call it:**
- AI Orchestrator (L7)

**Who may NOT call it:**
- Prompt Engine (L4)
- Trust Engine (L5)

**Events it publishes:**
- `skill.started` — skill execution began
- `skill.completed` — skill execution completed
- `skill.failed` — skill execution failed
- `skill.not_found` — no matching skill

**Events it listens to:**
- None

---

### Module: Skill Router

**Layer:** 3 (Decision)

**Purpose:** Route skill calls to the correct skill implementation.

**Responsibilities:**
- Maintain skill registry
- Match skill names to implementations
- Validate skill exists for this restaurant
- Return skill capability info

**Inputs:**
- `SkillCall` (skill name, parameters)

**Outputs:**
- `SkillDefinition` (matched skill, or null)

**Dependencies:**
- None (skill registry is internal)

**Who may call it:**
- Skill Engine (L3)

**Who may NOT call it:**
- Any module not in L3

**Events it publishes:**
- `skill.registered` — new skill added
- `skill.unregistered` — skill removed
- `skill.updated` — skill definition changed

**Events it listens to:**
- `plugin.installed` — load skills from plugin

---

### Module: Tool Executor

**Layer:** 0 (Adapter)

**Purpose:** Execute skill (tool) implementations. This is the bridge between AI Engine and actual business operations.

**Responsibilities:**
- Call the actual skill implementation
- Handle execution timeout
- Handle skill errors
- Return structured results

**Inputs:**
- `SkillDefinition` + parameters (from Skill Engine)

**Outputs:**
- `ExecutionResult` (data, error, latency)

**Dependencies:**
- Plugin Manager (L0) — for plugin-based skills

**Who may call it:**
- Skill Engine (L3)

**Who may NOT call it:**
- Any module except Skill Engine

**Events it publishes:**
- `tool.executed` — with result and latency

**Events it listens to:**
- None

**Skill execution boundary:**
```
Skills are the ONLY way the AI Engine touches the outside world.
Skills can:
  → Query DLE
  → Call external APIs
  → Trigger n8n workflows
  → Send data to plugins

The AI Engine itself NEVER directly accesses:
  → DLE
  → Redis
  → NocoDB
  → External APIs
  → File system
```

---

### Module: Trust Engine

**Layer:** 5 (Safety)

**Purpose:** Validate LLM output before any action is taken or response is sent.

**Responsibilities:**
- Validate LLM output against known data (no hallucinated products)
- Check for policy violations
- Detect prompt injection in customer message
- Verify skill calls are valid
- Block unsafe or inappropriate responses
- Score response quality

**Inputs:**
- `LLMResponse` (raw)
- `UnifiedContext` (for validation reference)

**Outputs:**
- `TrustVerdict` (approved, rejected, modified)

**Dependencies:**
- Safety Layer (L5)
- Knowledge Engine (L1) — for fact-checking
- Business Rule Engine (L2) — for rule compliance

**Who may call it:**
- AI Orchestrator (L7)
- Response Planner (L6)

**Who may NOT call it:**
- Prompt Engine (L4)
- LLM Provider Adapter (L0)

**Events it publishes:**
- `trust.validated` — response passed all checks
- `trust.violation` — response failed a check
- `trust.injection_detected` — prompt injection attempt
- `trust.hallucination_detected` — LLM invented data

**Events it listens to:**
- None

**Validation stages:**
```
1. Hallucination Check:
   → Does the response mention products that don't exist?
   → Does it claim prices that don't match?
   → Does it invent promotions?

2. Policy Check:
   → Does it violate any business rules?
   → Does it promise something we can't deliver?

3. Injection Check:
   → Did the customer try to manipulate the prompt?
   → Is there suspicious content in the message?

4. Identity Check:
   → Does the response match the restaurant's identity?
   → Is the tone appropriate?

5. Safety Check:
   → Is the response safe and appropriate?
   → No harmful, discriminatory, or offensive content.
```

---

### Module: Safety Layer

**Layer:** 5 (Safety)

**Purpose:** Apply safety filters and content moderation.

**Responsibilities:**
- Filter toxic language (incoming and outgoing)
- Implement content moderation rules
- Handle sensitive topics appropriately
- Ensure legal compliance

**Inputs:**
- Text content (message or response)

**Outputs:**
- `SafetyVerdict` (safe, flagged, blocked)

**Dependencies:**
- None (self-contained with configurable rules)

**Who may call it:**
- Trust Engine (L5)
- AI Orchestrator (L7)

**Who may NOT call it:**
- Any module below L5

**Events it publishes:**
- `safety.blocked` — content was blocked
- `safety.flagged` — content was flagged for review

**Events it listens to:**
- `safety.rules.updated` — reload safety configuration

---

### Module: Response Planner

**Layer:** 6 (Response)

**Purpose:** Plan what response to send to the customer. Not the formatting, but the content and structure.

**Responsibilities:**
- Take validated LLM output and plan the response
- Structure multi-part responses (text + link + suggestion)
- Apply conversation stage to response (opening vs closing)
- Determine if a skill call result needs to be communicated
- Plan follow-up questions

**Inputs:**
- `TrustVerdict` (validated response)
- `SkillResult` (if applicable)
- `UnifiedContext` (for context-aware planning)

**Outputs:**
- `ResponsePlan` (structured response plan)

**Dependencies:**
- Trust Engine (L5)
- Context Builder (L2)

**Who may call it:**
- AI Orchestrator (L7)

**Who may NOT call it:**
- Any module below L6

**Events it publishes:**
- `response.planned` — response plan created

**Events it listens to:**
- None

**Response structure:**
```typescript
interface ResponsePlan {
  type: 'direct' | 'suggestive' | 'question' | 'confirmation' | 'farewell' | 'escalation'
  parts: ResponsePart[]
  tone: Tone
  requiresFollowUp: boolean
  suggestedQuestions?: string[]
}

interface ResponsePart {
  type: 'text' | 'link' | 'media' | 'button' | 'suggestion'
  content: string
  priority: number
}
```

---

### Module: Response Formatter

**Layer:** 6 (Response)

**Purpose:** Format the response plan for the specific channel. This is the bridge back to the communication layer.

**Responsibilities:**
- Apply identity style to response text
- Format text for the target channel
- Handle channel-specific features (buttons, markdown, character limits)
- Apply emoji rules
- Split long messages per channel limits

**Inputs:**
- `ResponsePlan` (from Response Planner)
- Channel identifier

**Outputs:**
- `FormattedResponse` (ready for channel adapter)

**Dependencies:**
- Plugin Manager (L0) — for channel-specific formatters

**Who may call it:**
- AI Orchestrator (L7)

**Who may NOT call it:**
- Any module below L6

**Events it publishes:**
- `response.formatted` — with format details

**Events it listens to:**
- None

---

### Module: Plugin Manager

**Layer:** 0 (Adapter)

**Purpose:** Manage all plugins in the system. Provides plugin lifecycle and registry.

**Responsibilities:**
- Register and unregister plugins
- Provide channel-specific formatters
- Manage plugin permissions
- Handle plugin isolation

**Inputs:**
- Plugin registration calls
- Plugin capability queries

**Outputs:**
- Plugin capabilities
- Channel-specific formatters

**Dependencies:**
- None (manages plugins, doesn't depend on them)

**Who may call it:**
- Response Formatter (L6)
- Tool Executor (L0)
- Skill Router (L3)

**Who may NOT call it:**
- Modules in L1-L5

**Events it publishes:**
- `plugin.installed` — plugin added
- `plugin.uninstalled` — plugin removed
- `plugin.error` — plugin encountered error

**Events it listens to:**
- None

---

### Module: Conversation Logger

**Layer:** 8 (Observability)

**Purpose:** Log every conversation for analytics, debugging, and learning.

**Responsibilities:**
- Log all incoming messages
- Log all decisions made
- Log all responses sent
- Log errors and recovery actions
- Store logs for analytics

**Inputs:**
- All events from AI Orchestrator

**Outputs:**
- Logged conversation (to storage)

**Dependencies:**
- Analytics Collector (L8)
- Feedback Collector (L8)

**Who may call it:**
- AI Orchestrator (L7)

**Who may NOT call it:**
- Any module below L8

**Events it publishes:**
- None (it consumes events)

**Events it listens to:**
- All system events

**Logged data:**
```typescript
interface ConversationLog {
  id: string
  customerId: string
  restaurantId: string
  channel: string
  messages: {
    from: 'customer' | 'ai' | 'system'
    text: string
    timestamp: number
    metadata: any
  }[]
  decisions: Decision[]
  skills: SkillExecution[]
  errors: Error[]
  duration: number
  outcome: 'success' | 'escalated' | 'abandoned' | 'error'
}
```

---

### Module: Analytics Collector

**Layer:** 8 (Observability)

**Purpose:** Collect metrics and analytics data from all operations.

**Responsibilities:**
- Track response times
- Track conversation metrics (length, outcome)
- Track LLM usage (tokens, cost)
- Track skill usage
- Track error rates
- Provide metric data

**Inputs:**
- Events from all modules

**Outputs:**
- Analytics data (to analytics store)

**Dependencies:**
- None (pure collector)

**Who may call it:**
- Conversation Logger (L8)

**Who may NOT call it:**
- Any module

**Events it publishes:**
- None (it consumes events)

**Events it listens to:**
- `ai.lifecycle.*`
- `llm.*`
- `skill.*`
- `decision.*`
- `conversation.*`
- `trust.*`
- `recovery.*`

---

### Module: Feedback Collector

**Layer:** 8 (Observability)

**Purpose:** Collect qualitative feedback for learning and improvement.

**Responsibilities:**
- Collect customer feedback (explicit)
- Track implicit feedback (did customer complete order?)
- Tag conversations for learning
- Store feedback for Learning Engine (future)

**Inputs:**
- Conversation outcomes
- Customer feedback messages

**Outputs:**
- Tagged conversation data

**Dependencies:**
- None

**Who may call it:**
- Conversation Logger (L8)

**Who may NOT call it:**
- Any module

**Events it publishes:**
- `feedback.collected` — with feedback data

**Events it listens to:**
- `conversation.ended` — trigger feedback collection

---

## Flow Specifications

---

### Layer Diagram (Simplified)

```
        ┌──────────────────────┐
        │   Channel Adapter    │  (external)
        └──────────┬───────────┘
                   │ NormalizedMessage
        ┌──────────▼───────────┐
        │   AI Orchestrator    │  L7
        └──────────┬───────────┘
                   │
        ┌──────────▼───────────┐
        │   Context Builder    │  L2
        └──────────┬───────────┘
                   │
        ┌──────────▼───────────┐
        │   Intent Engine      │  L2
        └──────────┬───────────┘
                   │
        ┌──────────▼───────────┐
        │ Business Rule Engine │  L2
        └──────────┬───────────┘
                   │
        ┌──────────▼───────────┐
        │   Decision Engine    │  L3
        └──────────┬───────────┘
                   │
           ┌───────┴───────┐
           │               │
           ▼               ▼
   ┌──────────────┐ ┌──────────────┐
   │ Direct Resp  │ │ LLM Needed  │  L4
   └──────┬───────┘ └──────┬───────┘
          │                │
          ▼                ▼
   ┌──────────────┐ ┌──────────────┐
   │ Response     │ │   Prompt     │
   │ Planner (L6) │ │ Engine (L4)  │
   └──────────────┘ └──────┬───────┘
                           │
                           ▼
                   ┌──────────────┐
                   │    LLM Adapter│  L0
                   └──────┬───────┘
                          │
                          ▼
                   ┌──────────────┐
                   │ Trust Engine │  L5
                   └──────┬───────┘
                          │
                    ┌─────┴─────┐
                    │           │
                    ▼           ▼
            ┌──────────┐ ┌──────────┐
            │ Response  │ │  Skill   │
            │ Planner   │ │ Engine   │  L3
            └──────┬────┘ └────┬─────┘
                   │           │
                   ▼           ▼
            ┌──────────┐ ┌──────────┐
            │ Response  │ │   Tool   │
            │ Formatter│ │ Executor │  L0
            └──────┬────┘ └──────────┘
                   │
                   ▼
        ┌──────────────────────┐
        │   FormattedResponse  │
        └──────────────────────┘
```

---

### AI Lifecycle

```
[IDLE]
    │
    ├── new message received ──→ [LOADING CONTEXT]
    │                                   │
    │                                   ▼
    │                           [UNDERSTANDING]
    │                                   │
    │                                   ▼
    │                           [DECIDING]
    │                                   │
    │                         ┌─────────┴─────────┐
    │                         │                   │
    │                         ▼                   ▼
    │                   [RESPONDING]       [REASONING]
    │                         │                   │
    │                         │                   ▼
    │                         │            [LLM CALL]
    │                         │                   │
    │                         │                   ▼
    │                         │            [VALIDATING]
    │                         │                   │
    │                         │            ┌──────┴──────┐
    │                         │            │             │
    │                         │            ▼             ▼
    │                         │      [EXECUTING]  [RESPONDING]
    │                         │            │             │
    │                         └────────────┴─────────────┘
    │                                              │
    │                                              ▼
    │                                        [LOGGING]
    │                                              │
    └──────────────────────────────────────────────┘
                                              [IDLE]
```

**States:**
- `IDLE` — waiting for message
- `LOADING_CONTEXT` — gathering context
- `UNDERSTANDING` — intent + business rules
- `DECIDING` — decision engine
- `REASONING` — prompt construction
- `LLM_CALL` — waiting for LLM
- `VALIDATING` — trust check
- `EXECUTING` — skill execution
- `RESPONDING` — response planning + formatting
- `LOGGING` — observability

---

### Conversation Lifecycle

```
[NEW MESSAGE]
    │
    ▼
[CONTEXT BUILDER]
    ├── Load session from Memory Engine
    ├── Load customer profile
    ├── Load restaurant knowledge
    ├── Load identity config
    └── Return UnifiedContext
    │
    ▼
[INTENT ENGINE]
    ├── Classify intent
    ├── Extract entities
    └── Return IntentResult
    │
    ▼
[BUSINESS RULE ENGINE]
    ├── Check operating hours
    ├── Check product availability
    ├── Check delivery zone
    ├── Check other business rules
    └── Return RuleCheckResult
    │
    ▼
[DECISION ENGINE]
    ├── Evaluate: can we handle without LLM?
    │   YES → [DIRECT RESPONSE PATH]
    │   NO  → [LLM PATH]
    │
    ├── [DIRECT RESPONSE PATH]:
    │   ├── Business Rule Engine returns canned response
    │   └── → [RESPONSE PLANNER]
    │
    └── [LLM PATH]:
        ├── [PROMPT ENGINE]:
        │   ├── Load prompt components
        │   ├── Compose with context
        │   └── Return ConstructedPrompt
        ├── [LLM ADAPTER]:
        │   ├── Call LLM
        │   ├── Track tokens
        │   └── Return LLMResponse
        ├── [TRUST ENGINE]:
        │   ├── Validate output
        │   ├── Check for hallucinations
        │   ├── Check for violations
        │   └── Return TrustVerdict
        ├── [RE-PARSE DECISION]:
        │   ├── Did LLM request a skill?
        │   │   YES → [SKILL ENGINE] → [TOOL EXECUTOR]
        │   │   NO  → continue
        │   └── → [RESPONSE PLANNER]
        │
        └── [RESPONSE PLANNER]:
            ├── Structure response
            ├── Plan parts (text, link, buttons)
            └── Return ResponsePlan
    │
    ▼
[RESPONSE FORMATTER]
    ├── Apply identity style
    ├── Format for channel
    ├── Apply content rules
    └── Return FormattedResponse
    │
    ▼
[CONVERSATION LOGGER]
    ├── Log all data
    ├── Update analytics
    ├── Collect feedback
    └── Return to IDLE
```

---

### Error Flow

```
[ERROR DETECTED] (in any module)
    │
    ├── Is error recoverable?
    │   YES → [RETRY FLOW]
    │   NO  → [FAILURE FLOW]
    │
    ├── [FAILURE FLOW]:
    │   ├── Classify error type:
    │   │   - 'llm_timeout'     → LLM did not respond in time
    │   │   - 'llm_error'       → LLM returned error
    │   │   - 'validation'      → Trust Engine rejected output
    │   │   - 'skill_error'     → Skill execution failed
    │   │   - 'context_error'   → Context could not be built
    │   │   - 'internal_error'  → Unexpected internal error
    │   │
    │   ├── Decide response:
    │   │   - Can we send a simpler response?
    │   │       YES → Fallback response
    │   │   - Should we apologize?
    │   │       YES → Apologize + explain (vague)
    │   │   - Should we escalate?
    │   │       YES → Transfer to human operator
    │   │
    │   └── Log full error context
    │
    └── [ALWAYS]:
        ├── Log error with full context
        ├── Increment error metric
        ├── Alert monitoring if critical
        └── Do not expose internal details to customer
```

**Error classification:**

| Error | Severity | Recovery | Customer Message |
|-------|----------|----------|-----------------|
| LLM timeout | Medium | Retry → Fallback | "Кешіріңіз, қайталап көріңіз" |
| LLM invalid response | Medium | Retry → Fallback | "Кешіріңіз, түсінбедім" |
| Trust rejection | High | Fallback → Escalate | "Операторға қосамын" |
| Skill failure | Medium | Fallback | "Қазір көмектесе алмаймын" |
| Context error | High | Escalate | "Операторға қосамын" |
| Internal error | Critical | Escalate + Alert | "Операторға қосамын" |

---

### Retry Flow

```
[RETRY DECISION]
    │
    ├── Increment attempt counter
    ├── Check max retries:
    │   attempt > maxRetries → [FAILURE FLOW]
    │
    ├── Calculate backoff:
    │   delay = baseDelay * 2^attempt + jitter
    │
    ├── Wait for delay
    │
    ├── Retry operation
    │
    ├── Success? → Continue normal flow
    │
    └── Failure? → [RETRY DECISION] again
```

**Retry configuration:**
```typescript
interface RetryConfig {
  maxRetries: number
  baseDelayMs: number
  maxDelayMs: number
  jitterMs: number
  retryOn: ErrorType[]
}

// Default:
// maxRetries: 2
// baseDelay: 1000ms
// maxDelay: 5000ms
// jitter: 200ms
// retryOn: ['llm_timeout', 'llm_error', 'skill_timeout']
```

---

### Logging Flow

```
[EVERY MODULE] → publishes events
    │
    ▼
[EVENT BUS]
    │
    ├──→ [CONVERSATION LOGGER]
    │     ├── Store full conversation
    │     ├── Index for search
    │     └── Link related events
    │
    ├──→ [ANALYTICS COLLECTOR]
    │     ├── Update counters
    │     ├── Update latency metrics
    │     ├── Update error counts
    │     └── Update token usage
    │
    └──→ [FEEDBACK COLLECTOR]
          ├── Tag conversation outcome
          ├── Extract learning signals
          └── Store for future learning
```

**Logged events per module:**

| Module | Events Logged |
|--------|---------------|
| AI Orchestrator | lifecycle start/end/fail, duration |
| Context Builder | context size, load times |
| Intent Engine | detected intent, confidence |
| Business Rule Engine | rules checked, violations |
| Decision Engine | decision type, reasoning |
| Prompt Engine | prompt size, components |
| LLM Provider Adapter | tokens, latency, model |
| Trust Engine | validation results, violations |
| Skill Engine | skill name, duration, result |
| Response Planner | plan structure, parts count |
| Response Formatter | format type, channel |

---

### Observability Flow

```
[METRICS COLLECTION]
    │
    ├── Real-time metrics (every message):
    │   ├── Response time (p50, p95, p99)
    │   ├── LLM latency
    │   ├── Error rate
    │   ├── Token usage
    │   └── Active conversations
    │
    ├── Aggregated metrics (every hour):
    │   ├── Conversations per restaurant
    │   ├── Intent distribution
    │   ├── Decision distribution
    │   ├── Skill usage
    │   ├── Escalation rate
    │   └── Customer satisfaction (CSAT)
    │
    └── Business metrics (every day):
        ├── Orders placed via AI
        ├── Revenue attributed to AI
        ├── Customer retention
        └── Top customer questions
```

**Health checks:**

| Check | What it verifies | Frequency |
|-------|-----------------|-----------|
| LLM health | LLM provider is responsive | Every 30s |
| Memory health | Redis is reachable | Every 10s |
| Knowledge health | DLE is queryable | Every 30s |
| Engine health | All engines respond | Every 60s |
| Pipeline health | End-to-end message flow | Every 5min |

---

## Future Expansion Strategy

### Adding a New LLM Provider

1. Implement `LLMProviderAdapter` interface
2. Register in configuration
3. No changes to any other module

### Adding a New Channel

1. Implement Channel Adapter (external to AI Engine)
2. Register in Plugin Manager
3. Add channel-specific formatters in Response Formatter
4. No changes to AI Engine core

### Adding a New Skill

1. Create skill implementation
2. Register in Skill Router
3. No changes to any engine module

### Adding a New Business Rule

1. Add rule in Business Rule Engine
2. No changes to prompts, LLM, or other modules

### Adding a New Memory System

1. Implement storage adapter
2. Configure in Memory Engine
3. No changes to other modules

---

## Golden Rules (Summary)

```
1. LLM is a service, not a decision-maker
2. Business rules are NEVER in prompts
3. Business rules are ONLY in Business Rule Engine
4. Modules call DOWNWARD, never upward
5. No circular dependencies
6. Every module has ONE responsibility
7. Adapters isolate the outside world
8. The AI Engine knows NOTHING about channels
9. The AI Engine knows NOTHING about LLM providers
10. Everything is logged, everything is observable
```

---

_BekzatAI — The AI Engine is not a chatbot. It is the brain of the restaurant. Design it accordingly._
