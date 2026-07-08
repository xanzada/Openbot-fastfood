# Integrations & Plugin System

> **Нұсқа:** 1.0
> **Типі:** Engineering — plugin architecture
> **Автор:** BekzatAI Engineering
> **Статус:** Draft

---

## Purpose

Define how external systems connect to the platform. The plugin system ensures that new channels, services, and integrations can be added without changing core architecture.

---

## Integration Philosophy

The platform is a hub. External systems are spokes.

```
                    ┌──────────────┐
                    │   Telegram   │
                    └──────┬───────┘
                           │
┌──────────────┐  ┌───────┴────────┐  ┌──────────────┐
│  Instagram   │──│                │──│    Voice     │
└──────────────┘  │   BekzatAI     │  └──────────────┘
                   │   Platform    │
┌──────────────┐  │   (Core)      │  ┌──────────────┐
│   Mobile     │──│                │──│   Facebook   │
└──────────────┘  └───────┬────────┘  └──────────────┘
                           │
                    ┌──────┴───────┐
                    │   Web Chat   │
                    └──────────────┘
```

**Key principle:** The core should not know about specific channels. It only knows about a generic "Channel" interface.

---

## Plugin Types

### Channel Plugins

Connect communication platforms.

| Plugin | Input | Output | Status |
|--------|-------|--------|--------|
| WhatsApp | Webhook → Message | Message → API | ✅ Exists |
| Telegram | Webhook → Message | Message → API | ❌ Planned |
| Instagram | Webhook → Message | Message → API | ❌ Planned |
| Facebook Messenger | Webhook → Message | Message → API | ❌ Planned |
| Web Chat | HTTP Post → Message | Message → HTTP | ❌ Planned |
| Mobile App | WebSocket → Message | Message → Push | ❌ Planned |
| Voice | Audio → STT → Message | Message → TTS → Audio | ❌ Future |

### Service Plugins

Connect external services.

| Plugin | Purpose | Status |
|--------|---------|--------|
| SMS Gateway | Send SMS notifications | ❌ Planned |
| Email Service | Send email notifications | ❌ Planned |
| Push Notifications | Mobile push | ❌ Planned |

### Business Plugins

Connect business systems.

| Plugin | Purpose | Status |
|--------|---------|--------|
| POS Integration | Point of sale sync | ❌ Future |
| Delivery Service | Wolt, Yandex, etc. | ❌ Future |
| Payment Gateway | Kaspi, Visa, etc. | ❌ Future |
| CRM System | Customer relationship sync | ❌ Future |
| Accounting System | Revenue sync | ❌ Future |

---

## Channel Plugin Interface

Every channel plugin implements a stable interface:

```typescript
interface ChannelPlugin {
  // Identity
  id: string
  name: string
  type: 'channel'

  // Lifecycle
  initialize(config: ChannelConfig): Promise<void>
  destroy(): Promise<void>

  // Incoming
  handleWebhook(request: WebhookRequest): Promise<NormalizedMessage>
  // or handleSocket(socket: Socket): Promise<void>

  // Outgoing
  send(message: OutgoingMessage): Promise<SendResult>

  // Capabilities
  supports(feature: ChannelFeature): boolean
  // features: text, images, buttons, templates, location, payments
}
```

**NormalizedMessage format:**
```typescript
interface NormalizedMessage {
  channel: string
  channelMessageId: string
  customerId: string
  customerName?: string
  text: string
  media?: MediaAttachment[]
  timestamp: number
  metadata: Record<string, any>  // channel-specific data
}
```

**OutgoingMessage format:**
```typescript
interface OutgoingMessage {
  channel: string
  customerId: string
  text: string
  media?: MediaAttachment[]
  buttons?: Button[]
  template?: TemplateMessage
  metadata?: Record<string, any>
}
```

---

## Plugin Registration

Plugins register through the Plugin Manager:

```typescript
interface PluginManager {
  register(plugin: Plugin): void
  unregister(pluginId: string): void
  get(pluginId: string): Plugin | undefined
  list(): Plugin[]
  getChannel(channelType: string): ChannelPlugin | undefined
}
```

Registration can be:
- **Static** (bundled with core): WhatsApp
- **Dynamic** (installed at runtime): Telegram, Instagram, etc.

Dynamic plugins are loaded from:
- Local file system
- Package registry
- External URLs (trusted sources only)

---

## Service Plugin Interface

```typescript
interface ServicePlugin {
  id: string
  name: string
  type: 'service'

  initialize(config: ServiceConfig): Promise<void>
  destroy(): Promise<void>

  // Generic execute method
  execute(action: string, params: any): Promise<any>
}
```

Service plugins are called by skills. When a skill needs to send SMS, it calls the SMS plugin through the service interface.

---

## Business Plugin Interface (Future)

```typescript
interface BusinessPlugin {
  id: string
  name: string
  type: 'business'

  initialize(config: BusinessConfig): Promise<void>
  destroy(): Promise<void>

  // Business operations
  syncOrders(orders: Order[]): Promise<SyncResult>
  syncMenu(menu: MenuItem[]): Promise<SyncResult>
  syncCustomers(customers: Customer[]): Promise<SyncResult>
}
```

---

## Plugin Isolation

Plugins run in isolated contexts:

```
┌─────────────────────────────────────────────┐
│                  PLUGIN API                  │
│  (sandboxed environment)                     │
├─────────────────────────────────────────────┤
│  Plugin A  │  Plugin B  │  Plugin C         │
│  (Sandbox) │  (Sandbox) │  (Sandbox)        │
├────────────┴────────────┴───────────────────┤
│           PLUGIN MANAGER                     │
│  (lifecycle, permissions, registry)          │
└─────────────────────────────────────────────┘
```

**Isolation guarantees:**
- Plugin A cannot access Plugin B's data
- Plugins cannot access core internal state
- Plugins have defined permissions (send message, read context)
- Malicious plugins cannot crash the core

---

## Plugin Configuration

Each plugin has its own configuration stored in NocoDB:

```yaml
plugin:
  id: "telegram"
  enabled: true
  restaurant_id: "abc123"
  config:
    bot_token: "encrypted:..."
    webhook_url: "https://..."
    allowed_updates: ["message", "callback_query"]
```

Configuration is:
- Encrypted at rest
- Restaurant-specific
- Hot-reloadable (no restart needed)

---

## Integration: n8n

n8n serves as the workflow automation layer. It is NOT part of the core AI platform. It handles:

**What n8n does:**
- Notification workflows (send email on escalation)
- Data sync between NocoDB and external systems
- Scheduled tasks (daily reports, reminders)
- Webhook forwarding (some admin endpoints)

**What n8n does NOT do:**
- Core conversation processing
- AI decision making
- Real-time message handling

n8n talks to the platform through the REST API, not through event bus. This ensures the core is never dependent on n8n.

---

## Integration: External APIs

The platform exposes:
- REST API for admin operations
- Webhook endpoints for channel callbacks
- WebSocket for real-time updates (future)

External systems never access:
- Internal Redis
- Internal event bus
- Direct database access
- LLM providers directly

---

## Current Integration Status

| Integration | Status | Plugin Type |
|-------------|--------|-------------|
| WhatsApp | ✅ Existing | Channel |
| n8n | ✅ Existing | External Workflow |
| DLE | ✅ Existing | Internal Data |
| NocoDB | ✅ Existing | Internal Config |
| LLM Providers | ✅ Existing | Internal (needs adapter) |
| Telegram | ❌ Planned | Channel |
| SMS Gateway | ❌ Planned | Service |
| POS Systems | ❌ Future | Business |
| Delivery Services | ❌ Future | Business |

---

## Plugin System Status

The current codebase has:
- `plugins/` directory with a plugin loader
- Basic plugin interface
- WhatsApp-specific plugin

**Missing:**
- Formal Plugin Manager with lifecycle
- Plugin sandboxing
- Dynamic plugin loading
- Plugin permission system
- Unified Channel Plugin interface

**Migration:**
1. Extract formal Channel Plugin interface from current WhatsApp plugin
2. Implement Plugin Manager
3. Abstract existing WhatsApp logic into Channel Plugin
4. Add Telegram as second channel (validates the interface)

---

_BekzatAI — Plugins are guests. The core is the house. Guests can come and go. The house remains._
