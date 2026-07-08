# Pipelines

> **Нұсқа:** 1.0
> **Типі:** Engineering — processing pipelines
> **Автор:** BekzatAI Engineering
> **Статус:** Draft

---

## Purpose

Pipelines define the flow of data through the system. Every message, every decision, every response follows a defined pipeline. Pipelines make the implicit flow explicit.

---

## Pipeline Architecture

```
Incoming Event → Pipeline → Outgoing Event

Each Pipeline is a sequence of Stages.
Each Stage is a function: (input) => output.
Stages are composed, not nested.
```

```typescript
interface Pipeline<TInput, TOutput> {
  execute(input: TInput): Promise<TOutput>
}

interface Stage<TInput, TOutput> {
  execute(input: TInput): Promise<TOutput>
}
```

---

## Pipeline: Message Pipeline

**Path:** Incoming Message → Normalized Internal Event

**Purpose:** Transform external messages into standardized internal events.

```
Incoming Webhook
    │
    ▼
[Stage 1: Channel Adapter]
    Parse platform-specific format
    Extract: text, sender, timestamp, media
    ▼
[Stage 2: Message Validator]
    Validate message structure
    Check for empty/spam/malformed messages
    ▼
[Stage 3: Rate Limiter]
    Check customer rate limit
    Check restaurant rate limit
    ▼
[Stage 4: Session Resolver]
    Find or create conversation session
    Load conversation context
    ▼
[Stage 5: Message Router]
    Route to appropriate handler:
    - Regular message → Conversation Pipeline
    - System command → System Handler
    - Error → Error Handler
    ▼
Normalized Message Event
```

**Stages:**

| Stage | Responsibility | Failure Mode |
|-------|---------------|--------------|
| Channel Adapter | Parse webhook to internal format | Reject + return platform error |
| Message Validator | Check structure, content | Drop message + log |
| Rate Limiter | Enforce rate limits | Queue or reject |
| Session Resolver | Get/create session | Create new session |
| Message Router | Route to correct handler | Route to error handler |

**Status:** ✅ Partially exists. Channel adapter and session management exist. Formal pipeline does not.

---

## Pipeline: Reasoning Pipeline

**Path:** Business Context → Decision

**Purpose:** Combine all context and decide what to do next.

```
Business Context (conversation, identity, knowledge)
    │
    ▼
[Stage 1: Context Assembler]
    Gather context from all engines:
    - Conversation Engine (history, state)
    - Memory Engine (customer profile, past interactions)
    - Knowledge Engine (products, business rules)
    - Identity Engine (personality, style)
    ▼
[Stage 2: Intent Analyzer]
    Determine customer intent:
    - Order placement
    - Menu inquiry
    - Complaint
    - Information request
    - General question
    ▼
[Stage 3: Decision Selector]
    Can this be handled without LLM?
    - Yes → Route to Direct Response
    - No → Route to LLM Processing
    ▼
[Stage 4a: Direct Response]
    Apply business rules directly
    Use templates, cached responses
    For simple, deterministic queries

[Stage 4b: LLM Processing]
    a. Prompt Engine → construct prompt
    b. LLM Adapter → call LLM
    c. Parse → extract structured decision
    d. Trust Engine → validate output
    ▼
[Stage 5: Decision Router]
    Route decision:
    - Response → Response Pipeline
    - Skill Call → Tool Pipeline
    - Escalation → Orchestrator
    - Transfer → Orchestrator
    ▼
Decision
```

**Stages:**

| Stage | Responsibility | Failure Mode |
|-------|---------------|--------------|
| Context Assembler | Gather all context | Partial context + warning |
| Intent Analyzer | Detect customer intent | Default to general query |
| Decision Selector | LLM or direct? | Route to LLM (safe default) |
| Direct Response | Simple rule-based response | Fallback to LLM |
| LLM Processing | Full LLM reasoning | Trust rejection → Recovery Engine |
| Decision Router | Route to next pipeline | Route to error handler |

**Status:** ❌ Does not exist. Logic is scattered across services and prompts.

---

## Pipeline: Tool Pipeline

**Path:** Skill Call Intent → Executed Skill → Result

**Purpose:** Execute restaurant skills (tools) in a controlled, validated manner.

```
Skill Call Intent (from Reasoning Pipeline)
    │
    ▼
[Stage 1: Skill Selector]
    Match intent to appropriate skill
    Validate skill exists for this restaurant
    ▼
[Stage 2: Permission Checker]
    Does this AI have permission to execute this skill?
    Is the action within AI's authority?
    ▼
[Stage 3: Input Validator]
    Validate skill parameters
    Check required fields
    ▼
[Stage 4: Skill Executor]
    Execute the skill
    Monitor execution
    Handle timeout
    ▼
[Stage 5: Result Formatter]
    Format skill result for response
    Handle success and failure cases
    ▼
Skill Result
```

**Stages:**

| Stage | Responsibility |
|-------|---------------|
| Skill Selector | Find matching skill |
| Permission Checker | Authority check |
| Input Validator | Parameter validation |
| Skill Executor | Execute with timeout |
| Result Formatter | Format for response |

**Status:** ✅ Exists. Skill system is well-designed. Needs formal pipeline integration.

---

## Pipeline: Response Pipeline

**Path:** Raw Response → Formatted Outgoing Message

**Purpose:** Transform internal responses into customer-ready messages.

```
Raw Response (from Reasoning or Tool Pipeline)
    │
    ▼
[Stage 1: Trust Validator]
    Final safety check on outgoing content
    Check against Restaurant Values & Ethics
    ▼
[Stage 2: Identity Applicator]
    Apply restaurant identity style:
    - Adjust tone
    - Apply greeting/farewell style
    - Apply humor level
    - Apply emoji rules
    ▼
[Stage 3: Content Formatter]
    Apply formatting rules:
    - Split long messages
    - Separate links
    - Apply message structure rules
    ▼
[Stage 4: Channel Formatter]
    Format for specific channel:
    - WhatsApp: markdown, buttons
    - Telegram: formatting, keyboards
    - SMS: plain text only
    ▼
[Stage 5: Send Adapter]
    Send through channel API
    Handle delivery confirmation
    ▼
Sent Message
```

**Stages:**

| Stage | Responsibility | Failure Mode |
|-------|---------------|--------------|
| Trust Validator | Final safety check | Block + Recovery Engine |
| Identity Applicator | Apply restaurant personality | Skip identity (safe default) |
| Content Formatter | Format structure | Default formatting |
| Channel Formatter | Platform-specific format | Default to plain text |
| Send Adapter | Deliver message | Retry + notify |

**Status:** ❌ Does not exist as a formal pipeline. Formatting and sending are ad-hoc.

---

## Pipeline: Memory Pipeline

**Path:** Conversation Events → Stored Memories

**Purpose:** Extract and store important information from conversations.

```
Conversation Events (messages, decisions, outcomes)
    │
    ▼
[Stage 1: Event Collector]
    Collect all events from conversation
    ▼
[Stage 2: Relevance Filter]
    What is worth remembering?
    - Customer preferences
    - Order details
    - Issues and resolutions
    - Important context
    ▼
[Stage 3: Memory Classifier]
    Classify memory type:
    - Short-term (recent context)
    - Episodic (specific events)
    - Semantic (facts, preferences)
    ▼
[Stage 4: Storage Distributor]
    Store in appropriate system:
    - Redis for short-term
    - DLE for long-term
    - Analytics for learning
    ▼
Stored Memory Confirmation
```

**Status:** ❌ Does not exist. Memory storage is ad-hoc.

---

## Pipeline: Recommendation Pipeline

**Path:** Customer Context → Recommendation

**Purpose:** Generate personalized product recommendations.

```
Customer Context (profile, history, current need)
    │
    ▼
[Stage 1: Profile Analyzer]
    Analyze customer profile:
    - Past orders
    - Preferences
    - Frequency
    - Average spend
    ▼
[Stage 2: Context Analyzer]
    Analyze current context:
    - Time of day
    - Day of week
    - Current promotions
    - Popular items
    ▼
[Stage 3: Recommendation Generator]
    Apply recommendation rules:
    - Suggest complementary items
    - Apply upsell logic
    - Consider identity sales style
    ▼
[Stage 4: Personalization Applicator]
    Personalize recommendation:
    - Customer name
    - Past preferences
    - Special occasions
    ▼
Recommendation
```

**Status:** ❌ Does not exist.

---

## Pipeline Composition Rules

1. **Stages are stateless** — all state comes from context
2. **Stages can be skipped** — pipeline supports conditional execution
3. **Stages can fail independently** — failure in one stage does not break the pipeline (unless critical)
4. **Pipelines can be nested** — a stage can invoke another pipeline
5. **Pipelines are observable** — every stage logs input, output, and duration
6. **Pipelines have timeout** — total pipeline execution time is bounded

---

## Pipeline Observability

Every pipeline execution produces:

```typescript
interface PipelineTrace {
  pipelineId: string
  pipelineName: string
  startTime: timestamp
  endTime: timestamp
  stages: StageTrace[]
  result: Success | Failure
}

interface StageTrace {
  stageName: string
  startTime: timestamp
  endTime: timestamp
  inputSize: number
  outputSize: number
  error?: Error
}
```

This allows:
- Debugging any message flow
- Performance monitoring per stage
- Failure attribution
- Optimization targeting

---

## Status Summary

| Pipeline | Status | Priority |
|----------|--------|----------|
| Message Pipeline | Partial | Critical |
| Reasoning Pipeline | Missing | Critical |
| Tool Pipeline | Exists | Low |
| Response Pipeline | Missing | High |
| Memory Pipeline | Missing | Medium |
| Recommendation Pipeline | Missing | Medium |

---

_BekzatAI — Explicit pipelines are debuggable pipelines. Implicit flows are untraceable chaos._
