# Event Flow

> **Нұсқа:** 1.0
> **Типі:** Engineering — event-driven architecture
> **Автор:** BekzatAI Engineering
> **Статус:** Draft

---

## Purpose

Define how modules communicate through events. Event-driven architecture enables loose coupling, independent scaling, and easy addition of new modules.

---

## Event-Driven vs Direct Call

```
DIRECT CALL:             EVENT-DRIVEN:
Module A → Module B      Module A → Event Bus → Module B
                          Module A → Event Bus → Module C
                          Module A → Event Bus → Module D
```

**When to use direct calls:**
- Within a pipeline (sequential stages)
- Within an engine (internal methods)
- When response is required immediately

**When to use events:**
- Between modules
- When multiple modules need to know
- When the action can be async
- When the action is a side effect

---

## Event Bus

The system uses a lightweight event bus (in-process or Redis pub/sub depending on scale).

```typescript
interface EventBus {
  publish(event: SystemEvent): void
  subscribe(eventType: string, handler: EventHandler): void
}
```

Events are JSON-serializable. No direct object references.

---

## Core Events

### Message Events

| Event | Payload | Publisher | Subscribers |
|-------|---------|-----------|-------------|
| `message.received` | `{ channel, sender, text, timestamp }` | Channel Module | Conversation Orchestrator |
| `message.sent` | `{ channel, recipient, text, timestamp }` | Channel Module | Analytics Engine |
| `message.failed` | `{ channel, recipient, error }` | Channel Module | Recovery Engine |

### Conversation Events

| Event | Payload | Publisher | Subscribers |
|-------|---------|-----------|-------------|
| `conversation.started` | `{ customerId, restaurantId }` | Conversation Engine | Memory Engine |
| `conversation.state.changed` | `{ conversationId, from, to, reason }` | Conversation Engine | Analytics, Memory |
| `conversation.ended` | `{ conversationId, summary }` | Conversation Engine | Memory Engine, Analytics |
| `conversation.escalated` | `{ conversationId, reason, context }` | Conversation Engine | Escalation Orchestrator |

### Decision Events

| Event | Payload | Publisher | Subscribers |
|-------|---------|-----------|-------------|
| `decision.made` | `{ conversationId, decision, confidence }` | Reasoning Engine | Analytics Engine |
| `decision.llm_called` | `{ conversationId, model, latency, tokens }` | LLM Adapter | Analytics, Billing |
| `decision.llm_failed` | `{ conversationId, error }` | LLM Adapter | Recovery Engine |

### Skill Events

| Event | Payload | Publisher | Subscribers |
|-------|---------|-----------|-------------|
| `skill.called` | `{ skill, params, conversationId }` | Skill Orchestrator | Analytics Engine |
| `skill.completed` | `{ skill, result, latency }` | Skill Orchestrator | Conversation Engine, Analytics |
| `skill.failed` | `{ skill, error, attempt }` | Skill Orchestrator | Recovery Engine |

### Order Events

| Event | Payload | Publisher | Subscribers |
|-------|---------|-----------|-------------|
| `order.created` | `{ orderId, customerId, items, total }` | Order System | Analytics, Memory |
| `order.state.changed` | `{ orderId, from, to }` | Order System | Conversation Engine, Analytics |
| `order.cancelled` | `{ orderId, reason }` | Order System | Conversation Engine, Billing |

### Trust Events

| Event | Payload | Publisher | Subscribers |
|-------|---------|-----------|-------------|
| `trust.violation` | `{ type, severity, details }` | Trust Engine | Recovery Engine, Monitoring |
| `trust.injection_detected` | `{ customerId, message }` | Trust Engine | Security, Monitoring |
| `trust.validated` | `{ responseId, passed }` | Trust Engine | Reasoning Engine |

### Recovery Events

| Event | Payload | Publisher | Subscribers |
|-------|---------|-----------|-------------|
| `recovery.started` | `{ error, strategy }` | Recovery Engine | Analytics, Monitoring |
| `recovery.succeeded` | `{ error, strategy }` | Recovery Engine | Analytics |
| `recovery.failed` | `{ error, strategy }` | Recovery Engine | Escalation Orchestrator, Monitoring |

### Identity Events

| Event | Payload | Publisher | Subscribers |
|-------|---------|-----------|-------------|
| `identity.updated` | `{ restaurantId, changes }` | Admin System | All Engines (cache invalidation) |
| `identity.applied` | `{ restaurantId, context }` | Identity Engine | Analytics |

### Billing Events

| Event | Payload | Publisher | Subscribers |
|-------|---------|-----------|-------------|
| `billing.usage.recorded` | `{ restaurantId, usage }` | Billing Engine | Analytics |
| `billing.limit.warning` | `{ restaurantId, current, limit }` | Billing Engine | Notification |
| `billing.limit.exceeded` | `{ restaurantId }` | Billing Engine | Conversation Orchestrator |

### Monitoring Events

| Event | Payload | Publisher | Subscribers |
|-------|---------|-----------|-------------|
| `monitoring.alert` | `{ type, severity, message }` | Monitoring Engine | All |
| `monitoring.metric` | `{ name, value, tags }` | All modules | Analytics |

---

## Event Flow Examples

### Normal Message Flow

```
1. WhatsApp → webhook
2. Channel Module publishes: message.received
3. Conversation Engine subscribes:
   - Loads session
   - Publishes: conversation.state.changed (WAITING → ACTIVE)
4. Reasoning Engine called by pipeline:
   - If LLM needed: publishes decision.llm_called
   - Makes decision: publishes decision.made
5. Response Pipeline sends:
   - Channel Module publishes: message.sent
6. Conversation Engine publishes: conversation.state.changed (ACTIVE → WAITING)
```

### Error Recovery Flow

```
1. LLM call fails
2. LLM Adapter publishes: decision.llm_failed
3. Recovery Engine subscribes:
   - Classifies error
   - Publishes: recovery.started
   - Executes retry
4. If retry succeeds:
   - Publishes: recovery.succeeded
5. If retry fails:
   - Publishes: recovery.failed
   → Escalation Orchestrator triggered
```

### Escalation Flow

```
1. Customer asks for human
2. Reasoning Engine decides: escalate
3. Conversation Engine publishes: conversation.escalated
4. Escalation Orchestrator subscribes:
   - Creates ticket
   - Publishes: conversation.state.changed (ACTIVE → ESCALATED)
5. Operator dashboard picks up escalation
6. On resolution:
   - Escalation Orchestrator publishes: conversation.state.changed (ESCALATED → CLOSED)
```

---

## Event Contracts

Every event has a stable contract:

```typescript
interface SystemEvent {
  eventType: string        // "conversation.state.changed"
  eventId: string          // unique, for deduplication
  timestamp: number        // unix ms
  source: string           // module name
  restaurantId: string     // always included
  payload: Record<string, any>
  metadata: {
    traceId: string        // for tracing across modules
    version: number        // event schema version
  }
}
```

**Backward Compatibility:**
- New fields can be added to payload
- Existing fields cannot be changed or removed
- Subscribers ignore unknown fields
- All events have version number

---

## Event Storage

Events are stored for:
- Debugging (last 7 days in Redis)
- Analytics (permanently in DLE/analytics store)
- Audit trail (permanently, compliance)

---

## Principles

1. **Events are facts** — they represent something that happened, not an instruction
2. **Events are immutable** — once published, they cannot be changed
3. **Events have versions** — schema evolves with versioning
4. **Subscribers are independent** — a failing subscriber does not affect others
5. **Events are traceable** — traceId connects events across modules
6. **Events are bounded** — payload size is limited, large data is referenced by ID

---

## What Should NOT Be Events

- **Internal pipeline stages** — these are function calls, not events
- **Direct responses** — if module A needs module B's response to continue, use direct call
- **Large payloads** — events carry references, not large data

---

**Status:** ❌ Does not exist. System is currently direct-call based.

---

_BekzatAI — Events are facts. Modules are subscribers. Coupling is optional._
