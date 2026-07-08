# Interfaces & Stable Contracts

> **Нұсқа:** 1.0
> **Типі:** Engineering — interface contracts
> **Автор:** BekzatAI Engineering
> **Статус:** Draft

---

## Purpose

Define all stable contracts between subsystems. Interfaces are the most important architectural element — they determine what can change without breaking the system.

---

## Interface Philosophy

**A good interface is:**
- Stable (changes infrequently)
- Minimal (only what's necessary)
- Complete (everything needed is there)
- Testable (can be mocked easily)
- Documented (purpose is clear)

**An interface should not:**
- Leak implementation details
- Expose internal state
- Change when implementation changes
- Require knowledge of other interfaces

---

## Interface: LLM Provider Adapter

**Purpose:** Abstract all LLM interactions. This is the most critical interface in the system.

```typescript
interface LLMProvider {
  id: string                          // "openai", "gemini", "qwen", "claude"
  name: string

  // Core
  complete(request: LLMRequest): Promise<LLMResponse>
  stream?(request: LLMRequest): AsyncIterable<LLMResponseChunk>

  // Capabilities
  supports(feature: LLMFeature): boolean
  // features: streaming, function_calling, vision, json_mode, etc.

  // Cost
  getCost(response: LLMResponse): CostInfo
}

interface LLMRequest {
  messages: Message[]
  tools?: ToolDefinition[]
  temperature?: number
  maxTokens?: number
  responseFormat?: 'text' | 'json' | 'structured'
  stopSequences?: string[]
}

interface LLMResponse {
  content: string
  toolCalls?: ToolCall[]
  usage: TokenUsage
  finishReason: 'stop' | 'length' | 'tool_calls' | 'error'
  latency: number
}
```

**Implementations:**
- `OpenAIProvider` → OpenAI / Azure OpenAI
- `GeminiProvider` → Google Gemini
- `QwenProvider` → Alibaba Qwen
- `ClaudeProvider` → Anthropic Claude
- `LocalProvider` → Local open-source model (future)

**What depends on this:**
- Reasoning Engine
- Prompt Engine (output parsing)

**What does NOT depend on this:**
- All other engines
- All pipelines
- All business logic

**Status:** ❌ Missing. LLM calls are direct and scattered.

---

## Interface: Channel Adapter

**Purpose:** Abstract communication channels.

```typescript
interface ChannelAdapter {
  id: string
  name: string

  initialize(config: ChannelConfig): Promise<void>
  destroy(): Promise<void>

  send(message: OutgoingMessage): Promise<SendResult>
  sendBulk?(messages: OutgoingMessage[]): Promise<SendResult[]>

  // Webhook signature verification
  verifyWebhook(request: WebhookRequest): Promise<boolean>

  // Channel capabilities
  supports(feature: ChannelFeature): boolean
  // text, markdown, images, buttons, templates, location, payments
}

interface OutgoingMessage {
  channel: string
  customerId: string
  text: string
  media?: MediaAttachment[]
  buttons?: Button[]
  template?: TemplateMessage
}

interface SendResult {
  success: boolean
  channelMessageId?: string
  error?: string
}
```

**Implementations:**
- `WhatsAppAdapter`
- `TelegramAdapter`
- `InstagramAdapter`
- `WebChatAdapter`

**Status:** ✅ Partially exists. WhatsApp adapter exists. Interface needs formalization.

---

## Interface: Memory Store

**Purpose:** Abstract memory storage (short-term and long-term).

```typescript
interface MemoryStore {
  // Short-term (Redis-like)
  set(key: string, value: any, ttl?: number): Promise<void>
  get(key: string): Promise<any | null>
  delete(key: string): Promise<void>
  expire(key: string, ttl: number): Promise<void>

  // Long-term (DB-like)
  findById(collection: string, id: string): Promise<any | null>
  query(collection: string, criteria: QueryCriteria): Promise<any[]>
  create(collection: string, data: any): Promise<any>
  update(collection: string, id: string, data: any): Promise<any>
  deleteById(collection: string, id: string): Promise<void>
}
```

**Implementations:**
- `RedisMemoryStore` (short-term)
- `DLEMemoryStore` (long-term)
- `CompositeMemoryStore` (combines both, routes by key prefix)

**Status:** ❌ Missing. Storage access is direct.

---

## Interface: Event Bus

**Purpose:** Abstract event publishing and subscription.

```typescript
interface EventBus {
  publish(event: SystemEvent): void
  subscribe(eventType: string, handler: EventHandler): Unsubscribe
  subscribeToAll(handler: EventHandler): Unsubscribe  // for monitoring
}

interface SystemEvent {
  eventType: string
  eventId: string
  timestamp: number
  source: string
  restaurantId: string
  payload: Record<string, any>
  metadata: EventMetadata
}

type EventHandler = (event: SystemEvent) => Promise<void>
type Unsubscribe = () => void
```

**Implementations:**
- `InProcessEventBus` (current, single process)
- `RedisEventBus` (future, multi-process)
- `KafkaEventBus` (future, high scale)

**Status:** ❌ Missing. No formal event bus exists.

---

## Interface: Pipeline Stage

**Purpose:** Standard interface for all pipeline stages.

```typescript
interface Stage<TInput, TOutput> {
  name: string
  execute(input: TInput, context: PipelineContext): Promise<TOutput>
}

interface PipelineContext {
  traceId: string
  conversationId?: string
  restaurantId: string
  metadata: Record<string, any>
}
```

**Status:** ❌ Missing.

---

## Interface: Engine

**Purpose:** Standard interface for all engines.

```typescript
interface Engine<TInput, TOutput> {
  id: string
  name: string
  execute(input: TInput): Promise<TOutput>
}
```

**Status:** ❌ Missing.

---

## Interface: Plugin

**Purpose:** Standard interface for all plugins.

```typescript
interface Plugin {
  id: string
  name: string
  version: string
  type: 'channel' | 'service' | 'business'

  initialize(config: any): Promise<void>
  destroy(): Promise<void>
  getCapabilities(): string[]
}

interface ChannelPlugin extends Plugin {
  type: 'channel'
  send(message: OutgoingMessage): Promise<SendResult>
}

interface ServicePlugin extends Plugin {
  type: 'service'
  execute(action: string, params: any): Promise<any>
}
```

**Status:** ⚠️ Partially exists. Plugin interface exists but is not formalized.

---

## Interface: Skill

```typescript
interface Skill {
  id: string
  name: string
  description: string
  parameters: ParameterDefinition[]

  canExecute(context: ExecutionContext): Promise<boolean>
  execute(params: any, context: ExecutionContext): Promise<SkillResult>
}
```

**Status:** ✅ Exists. Well-designed.

---

## Interface Registry

All interfaces are registered in a central registry:

```typescript
interface InterfaceRegistry {
  register(name: string, version: string, contract: object): void
  get(name: string, version?: string): object | undefined
  getLatest(name: string): object | undefined
  list(): InterfaceInfo[]
}
```

This enables:
- Runtime interface discovery
- Interface versioning
- Compatibility checking
- Documentation generation

**Status:** ❌ Missing.

---

## Interface Versioning

```
interface: "memory-store"
versions:
  v1: created 2024-01-01
  v2: added "query" method 2024-06-01 (backward compatible)
  v3: removed "rawQuery" (breaking) 2025-01-01
```

**Rules:**
- Adding new methods = minor version (backward compatible)
- Changing existing methods = major version (breaking)
- Removing methods = major version (breaking)
- Multiple versions coexist during migration

---

## Critical Interfaces (Must Be Stable First)

1. **LLMProvider** — enables LLM independence
2. **ChannelAdapter** — enables channel plugins
3. **MemoryStore** — enables storage flexibility
4. **EventBus** — enables event-driven architecture
5. **Skill** — enables skill ecosystem

These five interfaces define the architecture. Everything else can change without breaking the system if these are stable.

---

_BekzatAI — Interfaces are the architecture. Everything else is implementation._
