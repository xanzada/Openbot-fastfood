# System Modules

> **Нұсқа:** 1.0
> **Типі:** Engineering — module architecture
> **Автор:** BekzatAI Engineering
> **Статус:** Draft

---

## Purpose

Define every module in the system, its boundaries, responsibilities, and interactions.

A module is a logical grouping of related capabilities. Each module has exactly one responsibility. Modules communicate through stable interfaces (see interfaces.md).

---

## Module Map

```
┌─────────────────────────────────────────────────────────────────┐
│                        CORE MODULES                             │
├──────────────┬──────────────┬──────────────┬───────────────────┤
│ Conversation │  Reasoning   │   Memory     │   Knowledge        │
│  Management  │  Engine      │  Management  │   Management      │
├──────────────┼──────────────┼──────────────┼───────────────────┤
│   Identity   │    Prompt    │    Trust     │    Recovery       │
│   Engine     │    Builder   │    Engine    │    Engine         │
├──────────────┼──────────────┼──────────────┼───────────────────┤
│   Sales      │  Analytics   │  Monitoring  │   Billing         │
│   Engine     │  Engine      │  Engine      │   Engine          │
└──────────────┴──────────────┴──────────────┴───────────────────┘

┌─────────────────────────────────────────────────────────────────┐
│                       CHANNEL MODULES                           │
├──────────────┬──────────────┬──────────────┬───────────────────┤
│  WhatsApp    │  Telegram    │  Instagram   │   Voice           │
│  Channel     │  Channel     │  Channel     │   Channel         │
├──────────────┼──────────────┼──────────────┼───────────────────┤
│  Mobile App  │  Web Widget  │  Facebook    │   API             │
│  Channel     │  Channel     │  Messenger   │   Gateway         │
└──────────────┴──────────────┴──────────────┴───────────────────┘

┌─────────────────────────────────────────────────────────────────┐
│                     INFRASTRUCTURE MODULES                      │
├──────────────┬──────────────┬──────────────┬───────────────────┤
│  Feature     │   Plugin    │    n8n       │   Deployment       │
│  Flags       │   Manager   │  Integration │   Orchestrator     │
└──────────────┴──────────────┴──────────────┴───────────────────┘
```

---

## Module: Conversation Management

**Purpose:** Manage the lifecycle of a conversation between a customer and the restaurant.

**Responsibilities:**
- Create and maintain conversation sessions
- Track conversation state (see state-machines.md)
- Manage context window (what has been discussed)
- Handle conversation timeout and expiration
- Route incoming messages to the correct handler

**Inputs:**
- Incoming message from Channel Adapter
- Customer identifier (phone number)
- Restaurant identifier

**Outputs:**
- Conversation context for Reasoning Engine
- State transitions
- Conversation closed events

**Dependencies:**
- Memory Engine (session storage)
- State Machine (conversation states)
- Identity Engine (restaurant config for conversation style)

**Current State:** ✅ Partially exists. Session management is implemented in services/ but lacks formal state machine.

**Future Scalability:**
- Multi-channel conversations (same customer across WhatsApp + Web)
- Conversation handoff between AI and human
- Long-running conversations (days)

**Ownership:** Core team

---

## Module: Reasoning Engine

**Purpose:** Make decisions and generate responses based on business context, identity, and LLM input.

This is the most critical module. It must be completely LLM-independent.

**Responsibilities:**
- Accept business context and decide what action to take
- Call LLM through the Provider Adapter (see interfaces.md)
- Parse and validate LLM responses
- Fall back gracefully when LLM fails
- Route decisions to appropriate handlers (direct response, skill execution, escalation)

**Inputs:**
- Conversation context (from Conversation Management)
- Knowledge context (from Knowledge Engine)
- Identity context (from Identity Engine)
- Memory context (from Memory Engine)
- Customer intent (detected by Intent Analyzer)

**Outputs:**
- Decision (what to do next)
- Response content (what to say)
- Skill invocation (what tool to call)
- Escalation signal

**Dependencies:**
- LLM Provider Adapter (see interfaces.md)
- Prompt Engine (construct prompts)
- Trust Engine (validate output)
- Knowledge Engine (business data)

**Current State:** ❌ Needs redesign. Current logic is tightly coupled to LLM. Business rules are mixed with prompts.

**Future Scalability:**
- Multi-LLM routing (different models for different tasks)
- Local LLM for simple queries, cloud LLM for complex ones
- Caching for common questions

**Ownership:** Core team

---

## Module: Memory Engine

**Purpose:** Manage all forms of memory — short-term, long-term, episodic, and semantic.

**Responsibilities:**
- Store conversation history (short-term in Redis)
- Store customer preferences and history (long-term in DLE)
- Retrieve relevant context for current conversation
- Prune and expire old memories
- Index memories for fast retrieval

**Inputs:**
- Conversation events (messages, transactions)
- Customer identifier
- Memory retrieval requests

**Outputs:**
- Conversation history
- Customer profile (preferences, history, status)
- Relevant context (past orders, issues, preferences)

**Dependencies:**
- Redis (short-term)
- DLE (long-term)
- Storage layer (see storage.md)

**Current State:** ✅ Partially exists. Redis session + DLE for customer data. Missing formal memory retrieval (context injection into prompts is ad-hoc).

**Future Scalability:**
- Vector memory (semantic search over past conversations)
- Episodic memory (specific past events)
- Cross-restaurant memory (same customer across restaurants in chain)

**Ownership:** Core team

---

## Module: Knowledge Engine

**Purpose:** Provide access to all restaurant business data: products, categories, prices, availability.

**Responsibilities:**
- Load and cache product catalog
- Answer product queries (price, ingredients, availability)
- Provide business rules (operating hours, delivery zones)
- Integrate with DLE for real-time data

**Inputs:**
- Product query (by name, category, price range)
- Restaurant identifier
- Context (time of day, day of week)

**Outputs:**
- Product information
- Availability status
- Business rules

**Dependencies:**
- DLE (product data)
- NocoDB (configuration)

**Current State:** ✅ Partially exists. Product data is available but Knowledge Engine as a formal abstraction does not exist. Queries are made directly from services.

**Future Scalability:**
- Real-time inventory (live stock levels)
- Dynamic pricing
- Cross-restaurant knowledge for chains

**Ownership:** Core team

---

## Module: Identity Engine

**Purpose:** Manage and apply restaurant personality configuration to all system behavior.

**Responsibilities:**
- Load restaurant identity configuration (from NocoDB)
- Apply identity to conversation style, tone, and behavior
- Provide identity context to Reasoning Engine
- Validate identity consistency
- Support A/B testing of identity configs

**Inputs:**
- Restaurant identifier
- Identity config (from NocoDB)
- Customer context (first visit, VIP, etc.)

**Outputs:**
- Communication style parameters
- Behavioral rules (how to sell, apologize, recommend)
- Tone and energy settings

**Dependencies:**
- NocoDB (identity configuration storage)
- Restaurant Values & Ethics (bounds that cannot be crossed)

**Current State:** ❌ Does not exist as a formal module. Some personality hints exist in prompts, but there is no systematic identity system.

**Future Scalability:**
- Dynamic identity (change based on time of day, season)
- Identity testing framework (A/B test different styles)
- Identity analytics (which style performs best)

**Ownership:** Core team

---

## Module: Prompt Engine

**Purpose:** Construct prompts from structured business context rather than hardcoded templates.

**Responsibilities:**
- Accept business context and identity parameters
- Construct prompts that reflect restaurant identity
- Inject business data (products, rules, policies)
- Ensure prompts stay within safety bounds
- Version and audit prompt constructions

**Inputs:**
- Business context (conversation, knowledge, memory)
- Identity parameters (style, tone, rules)
- Restaurant Values & Ethics (safety bounds)

**Outputs:**
- Constructed prompt (ready for LLM)
- Prompt metadata (what was included, why)

**Dependencies:**
- Identity Engine
- Knowledge Engine
- Memory Engine
- Trust Engine (safety validation)

**Current State:** ❌ Needs redesign. Current prompts are templates. Prompt Engine should be a proper prompt construction system.

**Future Scalability:**
- Prompt optimization (A/B test different constructions)
- Dynamic prompt length (short for fast food, long for premium)
- Multi-language prompt construction

**Ownership:** Core team

---

## Module: Trust Engine

**Purpose:** Ensure all AI behavior stays within safety, ethics, and business bounds.

**Responsibilities:**
- Validate LLM output before sending to customer
- Enforce Restaurant Values & Ethics
- Detect prompt injection attempts
- Enforce business rules (no fake promotions, no invented products)
- Block unsafe or inappropriate responses

**Inputs:**
- LLM raw response
- Business context
- Customer message (for injection detection)
- Ethics rules (from Restaurant Values & Ethics)

**Outputs:**
- Validated response (or rejected)
- Safety violation alerts
- Escalation signals

**Dependencies:**
- Restaurant Values & Ethics
- Identity Engine (bounds)

**Current State:** ❌ Does not exist as a formal module. Some validation exists in services/ but is scattered and incomplete.

**Future Scalability:**
- AI-powered safety checking
- Adaptive safety rules (based on customer behavior)
- Safety analytics dashboard

**Ownership:** Core team

---

## Module: Recovery Engine

**Purpose:** Handle errors, failures, and unexpected situations gracefully.

**Responsibilities:**
- Detect failures (LLM timeout, skill error, invalid response)
- Implement retry logic with backoff
- Fall back to simpler responses when complex ones fail
- Escalate to human operator when AI cannot handle
- Log failures for analysis

**Inputs:**
- Error signals from any module
- Failure context (what failed, why)
- Customer context (conversation state, history)

**Outputs:**
- Recovery action (retry, fallback, escalate)
- Recovery message (apology, explanation)
- Escalation event

**Dependencies:**
- Conversation Management (state transitions)
- Analytics Engine (failure logging)

**Current State:** ❌ Does not exist as a formal module. Error handling is ad-hoc in each service.

**Future Scalability:**
- Predictive failure detection
- Automatic recovery without customer awareness
- Learning from failures (avoid repeating same mistakes)

**Ownership:** Core team

---

## Module: Sales Engine

**Purpose:** Drive sales through recommendations, upsells, and promotions.

**Responsibilities:**
- Generate product recommendations based on context
- Apply upselling rules
- Integrate with promotion system
- Track sales effectiveness

**Inputs:**
- Customer context (history, preferences)
- Business context (current promotions, popular items)
- Identity context (sales style configuration)

**Outputs:**
- Recommendation suggestions
- Upsell signals
- Promotion triggers

**Dependencies:**
- Knowledge Engine (product data)
- Identity Engine (sales style)
- Memory Engine (customer history)

**Current State:** ❌ Does not exist as a formal module. Sales logic is embedded in prompts and services.

**Future Scalability:**
- ML-based recommendations
- Dynamic pricing
- Personalized offers

**Ownership:** Core team + Business team

---

## Module: Analytics Engine

**Purpose:** Collect, process, and learn from all system interactions.

**Responsibilities:**
- Log all conversations and decisions
- Track metrics (response time, satisfaction, sales conversion)
- Generate insights (popular products, common questions, failure patterns)
- Feed learning back into the system

**Inputs:**
- Events from all modules
- Conversation logs
- Business metrics

**Outputs:**
- Analytics data
- Learning signals (what works, what doesn't)
- Dashboard data

**Dependencies:**
- All modules (as data sources)

**Current State:** ✅ Partially exists. Logging is implemented. Analytics as a formal learning system does not exist.

**Future Scalability:**
- Automated prompt optimization
- Customer behavior prediction
- Revenue forecasting

**Ownership:** Core team

---

## Module: Billing

**Purpose:** Track and manage resource usage and billing.

**Responsibilities:**
- Track LLM token usage per restaurant
- Track request volume
- Enforce plan limits
- Generate billing data

**Inputs:**
- API call events
- LLM usage events
- Plan configuration (from NocoDB)

**Outputs:**
- Usage data
- Billing records
- Limit enforcement signals

**Dependencies:**
- NocoDB (plan config)
- Analytics Engine (usage data)

**Current State:** ✅ Exists. Well-designed. Should remain largely unchanged.

**Future Scalability:**
- Usage-based pricing tiers
- Prepaid vs postpaid
- Multi-restaurant billing for chains

**Ownership:** Core team

---

## Module: Channel Module (Plugin)

**Purpose:** Adapt external communication channels to the internal system.

Each channel is a separate module implementation.

**Responsibilities:**
- Receive messages from external platform (WhatsApp, Telegram, etc.)
- Convert external format to internal message format
- Handle platform-specific features (buttons, templates, media)
- Send responses back through the platform

**Inputs:**
- External webhook/callback
- Platform API

**Outputs:**
- Normalized message event
- Platform-formatted response

**Dependencies:**
- Plugin System (see integrations.md)
- Event System (see event-flow.md)

**Current State:** ✅ WhatsApp exists. Telegram and others are planned.

**Future Scalability:**
- New channels as plugin installations
- Multi-platform unified inbox
- Channel-specific features (order buttons, payment links)

**Ownership:** Channel team

---

## Module: Feature Flags

**Purpose:** Control feature availability across restaurants without deployment.

**Responsibilities:**
- Define feature toggles
- Enable/disable features per restaurant
- Roll out features incrementally
- A/B test features

**Inputs:**
- Feature flag configuration (from NocoDB)
- Restaurant identifier

**Outputs:**
- Feature availability signals

**Dependencies:**
- NocoDB (storage)

**Current State:** ✅ Exists. Well-designed.

**Future Scalability:**
- Gradual rollout (percentage-based)
- Automatic rollback on errors
- Feature flag analytics

**Ownership:** DevOps / Core team

---

## Module: Plugin Manager

**Purpose:** Manage all plugins in the system — channel plugins, skill plugins, adapter plugins.

**Responsibilities:**
- Register and unregister plugins
- Provide plugin lifecycle management
- Ensure plugin isolation
- Provide plugin API

**Inputs:**
- Plugin registration events
- Plugin configuration

**Outputs:**
- Plugin availability
- Plugin call routing

**Dependencies:**
- Event System
- Interface Registry (see interfaces.md)

**Current State:** ❌ Does not exist as a formal module. Plugins exist (skills) but without a manager.

**Future Scalability:**
- Third-party plugin marketplace
- Plugin sandboxing
- Plugin versioning

**Ownership:** Core team

---

## Module Boundaries: The Golden Rule

**No module should know the internal implementation of another module.**

A module should only know:
1. The interface of the module it calls
2. The events the module emits
3. The data contract of the module

If a module needs to know how another module works internally, the architecture is wrong.

---

_BekzatAI — One module, one responsibility. No God modules._
