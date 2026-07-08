# Orchestrators

> **Нұсқа:** 1.0
> **Типі:** Engineering — orchestration layer
> **Автор:** BekzatAI Engineering
> **Статус:** Draft

---

## Purpose

Orchestrators coordinate pipelines, engines, and state machines to accomplish complex goals. While pipelines define the flow for a single message, orchestrators manage multi-step workflows that may span multiple messages or involve multiple systems.

---

## Orchestrator vs Pipeline

```
Pipeline: One message → One flow → One response
Orchestrator: Multiple messages → Complex workflow → Goal completion
```

Pipelines handle individual requests.
Orchestrators handle business processes.

---

## Orchestrator: Conversation Orchestrator

**Purpose:** Manage the entire conversation lifecycle from start to end.

**Responsibilities:**
- Receive normalized messages from Message Pipeline
- Coordinate Reasoning Pipeline, Tool Pipeline, and Response Pipeline
- Manage conversation state transitions
- Handle conversation timeout and expiration
- Trigger memory storage on conversation end

**Flow:**

```
Message Pipeline → Conversation Orchestrator
    │
    ├── Is this a new conversation?
    │   Yes → Start new session
    │       → Initialize context
    │       → Apply identity greeting
    │       → Send greeting through Response Pipeline
    │
    ├── Is this an existing conversation?
    │   Yes → Load context
    │       → Reasoning Pipeline
    │       │   ├── Response → Response Pipeline → Send
    │       │   ├── Skill → Tool Pipeline → Result → Response Pipeline → Send
    │       │   └── Escalation → Escalation Orchestrator
    │       → Update state
    │
    └── Has conversation timed out?
        Yes → Send timeout message
            → Close session
            → Store memory
```

**State Transitions Managed:**
- NEW → ACTIVE (first message received)
- ACTIVE → WAITING (waiting for customer response)
- WAITING → ACTIVE (customer responded)
- ACTIVE → ESCALATED (transferred to human)
- ACTIVE → CLOSED (conversation ended)
- CLOSED → NEW (customer returns later)

**Status:** ❌ Does not exist. Conversation flow is managed implicitly in services.

---

## Orchestrator: Skill Orchestrator

**Purpose:** Execute multi-step skills that require multiple actions.

**Responsibilities:**
- Coordinate execution of complex skills
- Handle skill dependencies (skill A must complete before skill B)
- Manage skill state (is skill running? completed? failed?)
- Provide feedback to Conversation Orchestrator

**Flow:**

```
Skill Call → Skill Orchestrator
    │
    ├── Single-step skill → Tool Pipeline → Result
    │
    └── Multi-step skill
        ├── Step 1 → Tool Pipeline → Intermediate Result
        ├── Step 2 → Tool Pipeline → Intermediate Result
        └── Final Step → Tool Pipeline → Final Result
```

**Example — Order Placement:**
```
Step 1: Validate Order Items (check availability)
Step 2: Calculate Total (apply pricing)
Step 3: Confirm Order (send to kitchen)
Step 4: Notify Customer (send confirmation)
```

**Status:** ✅ Partially exists. Skills can be multi-step but orchestration is within the skill itself, not a separate orchestrator.

---

## Orchestrator: Escalation Orchestrator

**Purpose:** Manage the process of transferring customers from AI to human operators.

**Responsibilities:**
- Determine escalation need
- Create escalation request
- Route to appropriate operator or team
- Monitor escalation status
- Handle handoff back to AI if appropriate
- Manage escalation timeout (if operator doesn't respond)

**Flow:**

```
Escalation Signal → Escalation Orchestrator
    │
    ├── Check escalation policy:
    │   ├── Can AI handle with more context? → Return to Conversation
    │   ├── Need human operator? → Create escalation ticket
    │   └── Emergency? → High-priority escalation
    │
    ├── Create Escalation:
    │   ├── Assign to available operator
    │   ├── Provide full context (conversation history)
    │   └── Notify operator
    │
    ├── Monitor Escalation:
    │   ├── Operator accepted? → Update customer
    │   ├── Timeout? → Reassign or notify supervisor
    │   └── Operator busy? → Queue or notify
    │
    └── Resolution:
        ├── Problem solved → Close escalation
        └── Back to AI → Transfer context back
```

**Escalation Reasons:**
- Customer explicitly requests human
- AI cannot resolve after N attempts
- Financial/payment issue
- Complaint about personnel
- Legal concern
- Customer is angry/abusive
- Complex issue requiring human judgment

**Status:** ✅ Partially exists. Basic escalation exists. Formal orchestration does not.

---

## Orchestrator: Recovery Orchestrator

**Purpose:** Manage system recovery when things go wrong.

**Responsibilities:**
- Receive failure signals from any pipeline or engine
- Classify failure severity
- Execute recovery plan
- Monitor recovery success
- Escalate if recovery fails

**Flow:**

```
Failure Signal → Recovery Orchestrator
    │
    ├── Classify Severity:
    │   ├── Low: LLM timeout → Retry
    │   ├── Medium: Skill failure → Fallback response
    │   ├── High: System error → Escalate to engineering
    │   └── Critical: Data loss → Emergency protocol
    │
    ├── Execute Recovery Plan:
    │   ├── Retry with backoff
    │   ├── Fallback to simpler handler
    │   ├── Cache hit (use cached response)
    │   └── Apologize + escalate
    │
    └── Monitor: recovery successful?
        ├── Yes → Continue normal flow
        └── No → Escalate to human
```

**Status:** ❌ Does not exist.

---

## Orchestrator Visibility

All orchestrators emit events for observability:

```typescript
interface OrchestratorEvent {
  orchestrator: string
  eventType: string
  conversationId: string
  timestamp: Date
  payload: any
  state: string
}
```

This enables:
- Real-time conversation monitoring
- Operator dashboard
- Analytics
- Debugging

---

## Orchestrator Principles

1. **Orchestrators coordinate, not implement** — they call pipelines and engines, they don't replace them
2. **Orchestrators manage state** — they track the state of complex workflows
3. **Orchestrators can timeout** — every orchestration has a bounded execution time
4. **Orchestrators are observable** — every decision is logged
5. **Orchestrators can be interrupted** — escalation can cancel normal orchestration

---

_BekzatAI — Orchestrators are the conductors. Pipelines are the instruments. Engines are the musicians._
