# State Machines

> **Нұсқа:** 1.0
> **Типі:** Engineering — state management
> **Автор:** BekzatAI Engineering
> **Статус:** Draft

---

## Purpose

State machines model the lifecycle of entities in the system. They make state transitions explicit, predictable, and observable. Every entity that has a lifecycle should have a state machine.

---

## Why State Machines?

**Without state machines:**
- States are scattered across if/else conditions
- Transitions are implicit (hidden in business logic)
- Invalid transitions happen (bugs)
- New team members cannot understand the lifecycle

**With state machines:**
- States are documented
- Transitions are explicit
- Invalid transitions are impossible by design
- Lifecycle is testable

---

## State Machine: Conversation

**Domain:** Conversation Management

**States:**

```
                     ┌─────────────────┐
                     │      NEW        │
                     │ First message   │
                     └────────┬────────┘
                              │ message received
                              ▼
                     ┌─────────────────┐
              ┌──────│     ACTIVE      │──────┐
              │      │ AI & customer   │      │
              │      │ communicating   │      │
              │      └────────┬────────┘      │
              │               │               │
         message        timeout/         escalation
         received       waiting          requested
              │               │               │
              ▼               ▼               ▼
     ┌──────────────┐ ┌──────────────┐ ┌──────────────┐
     │   WAITING    │ │   TIMEOUT    │ │  ESCALATED   │
     │ Awaiting     │ │ Customer     │ │ Transferred  │
     │ customer     │ │ inactive     │ │ to operator  │
     └──────┬───────┘ └──────────────┘ └──────┬───────┘
            │                                 │
       message                            resolved /
       received                            closed
            │                                 │
            ▼                                 ▼
     ┌──────────────┐                 ┌──────────────┐
     │   ACTIVE     │                 │   CLOSED     │
     └──────────────┘                 └──────────────┘
                                            │
                                       new message
                                       (hours/days later)
                                            │
                                            ▼
                                     ┌──────────────┐
                                     │     NEW      │
                                     └──────────────┘
```

**Transitions:**

| From | To | Trigger |
|------|----|---------|
| NEW | ACTIVE | First message received |
| ACTIVE | WAITING | AI response sent, awaiting customer |
| WAITING | ACTIVE | Customer responded |
| ACTIVE | ESCALATED | Escalation requested |
| ESCALATED | CLOSED | Escalation resolved |
| ACTIVE | CLOSED | Customer ended |
| WAITING | TIMEOUT | No response within timeout |
| TIMEOUT | CLOSED | Session expired |
| CLOSED | NEW | Customer sends new message (new session) |

**Data:**
```typescript
interface ConversationState {
  id: string
  customerId: string
  restaurantId: string
  state: 'NEW' | 'ACTIVE' | 'WAITING' | 'ESCALATED' | 'TIMEOUT' | 'CLOSED'
  context: ConversationContext
  startedAt: timestamp
  lastActivityAt: timestamp
  messageCount: number
  escalationReason?: string
}
```

**Status:** ❌ Does not exist. States are managed ad-hoc with simple boolean flags.

---

## State Machine: Order

**Domain:** Order Processing

**States:**

```
PENDING → CONFIRMED → PREPARING → READY → DELIVERED
    │          │          │          │
    │          │          │          │
    └──────────┴──────────┴──────────┴─────────→ CANCELLED
```

| State | Description |
|-------|-------------|
| PENDING | Order created, awaiting confirmation |
| CONFIRMED | Order accepted by restaurant |
| PREPARING | Food is being prepared |
| READY | Food is ready for pickup/delivery |
| DELIVERED | Customer received order |
| CANCELLED | Order cancelled (from any state) |

**Data:**
```typescript
interface OrderState {
  orderId: string
  customerId: string
  restaurantId: string
  state: 'PENDING' | 'CONFIRMED' | 'PREPARING' | 'READY' | 'DELIVERED' | 'CANCELLED'
  items: OrderItem[]
  total: number
  createdAt: timestamp
  stateHistory: StateTransition[]
}
```

**Status:** ❌ Not a formal state machine. Exists implicitly in business logic.

---

## State Machine: Escalation

**Domain:** Human Operator Escalation

**States:**

```
                    ┌──────────────────────────────────┐
                    │           MONITORING              │
                    │   AI is handling, but watching    │
                    └──────────────────────────────────┘
                              │
                    escalation needed
                              │
                              ▼
                    ┌──────────────────────────────────┐
                    │         ESCALATING                │
                    │   Creating ticket, finding op     │
                    └──────────────────────────────────┘
                              │
                    operator assigned
                              │
                              ▼
                    ┌──────────────────────────────────┐
              ┌─────│         ACTIVE                   │──────┐
              │     │   Operator handling customer     │      │
              │     └──────────────────────────────────┘      │
              │               │                               │
        operator           resolved /                    operator
        needs help         customer                     requests AI
              │            satisfied                        │
              ▼               ▼                               ▼
     ┌──────────────┐ ┌──────────────┐             ┌──────────────┐
     │ RE-ESCALATED │ │   RESOLVED   │             │ RETURNED_TO  │
     │ To supervisor │ │              │             │     AI       │
     └──────────────┘ └──────────────┘             └──────────────┘
```

| State | Description |
|-------|-------------|
| MONITORING | AI handling, but monitoring for escalation need |
| ESCALATING | Escalation ticket being created |
| ACTIVE | Operator actively handling |
| RE-ESCALATED | Operator needs supervisor |
| RESOLVED | Issue resolved |
| RETURNED_TO_AI | Operator sent back to AI |

**Status:** ❌ Does not exist.

---

## State Machine: Recovery

**Domain:** System Recovery

**States:**

```
NORMAL → DEGRADED → RECOVERING → NORMAL
                    │
                    ▼
                 CRITICAL → EMERGENCY
```

| State | Description |
|-------|-------------|
| NORMAL | System operating normally |
| DEGRADED | Some functionality reduced |
| RECOVERING | Attempting to restore full functionality |
| CRITICAL | Core functionality affected |
| EMERGENCY | Manual intervention required |

**Status:** ❌ Does not exist.

---

## State Machine: Skill Execution

**Domain:** Skill/Tool Execution

**States:**

```
IDLE → QUEUED → RUNNING → COMPLETED
                  │
                  ▼
               FAILED → RETRYING → RUNNING
                              │
                              ▼
                           RETRY_EXCEEDED
```

| State | Description |
|-------|-------------|
| IDLE | Skill available, not executing |
| QUEUED | Skill execution queued |
| RUNNING | Skill executing |
| COMPLETED | Skill executed successfully |
| FAILED | Skill execution failed |
| RETRYING | Retrying after failure |
| RETRY_EXCEEDED | Max retries exceeded |

**Status:** ✅ Exists. Skill execution states are managed (basic).

---

## State Machine Implementation Principles

1. **Explicit transitions** — every possible transition is defined
2. **No invalid transitions** — state machine prevents impossible transitions
3. **Observable** — every transition is logged
4. **Persisted** — state survives restarts
5. **Timeout-aware** — states can have TTLs
6. **Event-emitting** — transitions emit events

---

## State vs Data

**State** answers: "What phase of the lifecycle are we in?"
**Data** answers: "What information do we have?"

State is stored separately from data.
State transitions trigger behaviors.
Data informs decisions.

---

**Status Summary:**

| State Machine | Status | Priority |
|--------------|--------|----------|
| Conversation | Missing | Critical |
| Order | Implicit | High |
| Escalation | Missing | Medium |
| Recovery | Missing | Medium |
| Skill Execution | Exists | Low |

---

_BekzatAI — Explicit states prevent impossible transitions. If a state transition is impossible, that bug never happens._
