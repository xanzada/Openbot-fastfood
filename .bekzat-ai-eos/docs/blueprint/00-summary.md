# Engineering Blueprint: Architecture Summary

> **Нұсқа:** 1.0
> **Типі:** Engineering — architecture overview
> **Автор:** BekzatAI Engineering
> **Статус:** Draft

---

## Purpose

This document is the entry point to the complete engineering blueprint.

It explains:
- The architectural philosophy
- How all pieces fit together
- Which documents exist and what they cover
- Current state vs ideal state
- Migration strategy

---

## Architectural Philosophy

### First Principle: LLM is a Plugin

The single most important architectural decision:

**The Business must not depend on the LLM. The LLM must depend on the Business.**

This means:
- All business logic lives in Engines, not in prompts
- LLM is accessed through a stable Provider Adapter interface
- Changing the LLM (OpenAI → Gemini → Qwen → Claude) requires zero business logic changes
- Prompts are constructed from business context, not hardcoded
- The LLM is one of many inputs to decision-making, not the decision-maker itself

### Second Principle: Modularity over Monolith

Every capability belongs to exactly one module.
Every module has exactly one responsibility.
Modules communicate through stable interfaces.
No God Services. No God Classes. No God Prompts.

### Third Principle: Event-Driven by Default

Modules communicate through events, not direct calls.
This allows:
- Loose coupling
- Independent scaling
- Easy addition of new modules
- Async processing where appropriate

### Fourth Principle: Identity is First-Class

Every restaurant has its own identity configuration.
All system behavior respects this identity.
The same AI model produces different behavior for different restaurants.

---

## Architecture Layers

```
CHANNEL LAYER          WhatsApp | Telegram | Instagram | Voice | Mobile App
                           │
API LAYER               Webhooks | REST API | GraphQL | gRPC
                           │
ORCHESTRATION LAYER     Conversation Orchestrator | Skill Orchestrator
                           │
PIPELINE LAYER          Message Pipeline | Reasoning Pipeline | Tool Pipeline | Response Pipeline
                           │
ENGINE LAYER            Conversation | Reasoning | Memory | Knowledge | Identity | Prompt
                        Recommendation | Sales | Trust | Recovery | Analytics
                           │
STORAGE LAYER           Redis (short-term) | DLE (long-term) | NocoDB (config) | Logs (experience)
                           │
INFRASTRUCTURE LAYER    n8n | Monitoring | Billing | Feature Flags
```

---

## Document Map

| # | Document | Covers |
|---|----------|--------|
| 00 | summary.md (this) | Architecture overview, philosophy, document map |
| 01 | system-modules.md | All modules, responsibilities, boundaries |
| 02 | engines.md | All engines, detailed architecture |
| 03 | pipelines.md | All processing pipelines |
| 04 | orchestrators.md | Orchestration layer |
| 05 | state-machines.md | All state machines |
| 06 | event-flow.md | Event-driven architecture |
| 07 | integrations.md | Plugin system, channel adapters |
| 08 | storage.md | Data architecture |
| 09 | api-layers.md | API architecture |
| 10 | interfaces.md | Stable contracts |
| 11 | future-modules.md | Future roadmap |

---

## Current State vs Ideal State

### What Already Exists
- WhatsApp channel adapter
- Basic conversation handling
- Skill system (basic)
- Prompt templates
- NocoDB integration
- DLE integration
- Redis session management
- n8n workflows
- Billing system
- Feature flags

### What Needs to Be Built
- Engine architecture (current logic is service-based, not engine-based)
- LLM Provider Adapter (currently tightly coupled)
- Pipeline system (message flow is implicit, not explicit)
- State machines (conversation states are managed ad-hoc)
- Event system (coupling is mostly direct)
- Plugin system (channel adapters are hardcoded)
- Identity system (personality config exists but is not used by all components)
- Trust engine (safety checks are scattered)
- Recovery engine (error handling is ad-hoc)

### What Should Remain Unchanged
- Skill definitions (good abstraction)
- NocoDB schema (well-designed)
- DLE data model (well-designed)
- Billing system (clean separation)
- Feature flags (good pattern)

### What Should Be Redesigned
- Service layer → Engine architecture
- Direct LLM calls → LLM Provider Adapter
- Implicit pipelines → Explicit pipelines
- Ad-hoc state management → State machines
- Hardcoded channel logic → Plugin system

---

## Key Architectural Decisions

### Decision 1: LLM Provider Adapter

```
[Business Logic] → [Reasoning Engine] → [LLM Adapter Interface] → [OpenAI | Gemini | Qwen | Claude]
```

The Reasoning Engine does not call the LLM directly.
It calls the LLM Adapter.
The Adapter translates business context into LLM calls.
Changing LLM means changing one adapter implementation.

### Decision 2: Engine Layer

Engines are the heart of business logic.
They are stateless (state lives in State Machines and Storage).
They can be scaled independently.
They communicate through events.

### Decision 3: Pipeline as First-Class Concept

Message flow is not implicit.
Every message goes through a defined pipeline.
Each stage in the pipeline is a separate responsibility.
Pipelines can be observed, logged, and debugged.

### Decision 4: Configuration over Code

Personality is configuration.
Business rules are configuration.
Prompts are constructed from configuration.
No hardcoded behavior per restaurant.

---

## Migration Strategy

### Phase 1: Foundation (Current → 3 months)
- Define all interfaces
- Create LLM Provider Adapter
- Extract Engines from existing services
- Create explicit pipelines
- Implement state machines

### Phase 2: Identity & Quality (3-6 months)
- Full identity system integration
- Trust engine implementation
- Recovery engine implementation
- A/B testing for identity configs

### Phase 3: Scale (6-12 months)
- Plugin system for new channels
- Event-driven architecture
- Independent scaling of engines
- Analytics engine for learning

### Phase 4: Evolution (12+ months)
- Multi-LLM routing (different LLMs for different tasks)
- Personalization at scale
- Autonomous improvement loop

---

## Guiding Question

For every architectural decision, ask:

**"Does this make the LLM easier to replace?"**

If the answer is no, redesign.

---

_BekzatAI — Architecture is not about today's LLM. It is about every LLM that will ever exist._
