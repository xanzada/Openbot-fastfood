# API Layers

> **Нұсқа:** 1.0
> **Типі:** Engineering — API architecture
> **Автор:** BekzatAI Engineering
> **Статус:** Draft

---

## Purpose

Define the API surfaces of the platform. APIs are the contracts between internal modules, external systems, and administrative tools.

---

## API Layer Map

```
┌─────────────────────────────────────────────────────────┐
│                 EXTERNAL APIS                             │
│  Channel Webhooks | Public REST | WebSocket               │
├─────────────────────────────────────────────────────────┤
│                 INTERNAL APIS                             │
│  Module Interfaces | Engine Contracts | Pipelines         │
├─────────────────────────────────────────────────────────┤
│                 ADMIN APIS                                │
│  Admin REST | Configuration API | Analytics API           │
└─────────────────────────────────────────────────────────┘
```

---

## External API: Channel Webhooks

**Purpose:** Receive messages from external platforms.

**Type:** HTTP POST (webhook callbacks)

**Endpoints:**

| Endpoint | Channel | Authentication |
|----------|---------|---------------|
| `POST /webhooks/whatsapp` | WhatsApp | Signature verification |
| `POST /webhooks/telegram` | Telegram | Secret token |
| `POST /webhooks/instagram` | Instagram | Platform token |

**Contract (all channels normalize to):**
```typescript
// Input (after channel adapter normalizes)
interface WebhookMessage {
  channel: string
  channelMessageId: string
  customerId: string
  customerName?: string
  text: string
  media?: MediaAttachment[]
  timestamp: number
  raw: Record<string, any>  // original payload for debugging
}

// Response
interface WebhookResponse {
  success: boolean
  statusCode: 200 | 202  // 200 = processed, 202 = queued
  error?: string
}
```

**Status:** ✅ Exists for WhatsApp.

---

## External API: REST API

**Purpose:** Allow external systems (admin panel, n8n, partners) to interact with the platform.

**Type:** HTTP REST (JSON)

**Endpoints:**

| Endpoint | Method | Purpose | Auth |
|----------|--------|---------|------|
| `/api/v1/messages` | POST | Send message as restaurant | API Key |
| `/api/v1/conversations` | GET | List conversations | API Key |
| `/api/v1/conversations/:id` | GET | Get conversation details | API Key |
| `/api/v1/conversations/:id/messages` | GET | Get message history | API Key |
| `/api/v1/customers/:id` | GET | Get customer profile | API Key |
| `/api/v1/orders` | POST | Create order programmatically | API Key |
| `/api/v1/orders/:id` | GET | Get order status | API Key |
| `/api/v1/products` | GET | Get restaurant products | API Key |
| `/api/v1/escalate` | POST | Trigger escalation | API Key |

**Authentication:**
- API Key in header: `Authorization: Bearer <api_key>`
- Keys are restaurant-specific
- Keys are stored in NocoDB
- Rate limited per key

**Status:** ⚠️ Partially exists. Some endpoints exist but not as a formal API layer.

---

## Admin API

**Purpose:** Admin panel and configuration management.

**Type:** HTTP REST (JSON)

**Endpoints:**

| Endpoint | Purpose |
|----------|---------|
| `/admin/v1/restaurants` | Manage restaurants |
| `/admin/v1/identity` | Manage restaurant identity config |
| `/admin/v1/plans` | Manage pricing plans |
| `/admin/v1/feature-flags` | Manage feature flags |
| `/admin/v1/analytics` | Get analytics data |
| `/admin/v1/logs` | View system logs |
| `/admin/v1/monitoring` | System health |

**Authentication:**
- JWT-based (admin users)
- Role-based (admin, support, read-only)

**Status:** ❌ Does not exist as a formal API.

---

## Internal API: Module Interfaces

Internal APIs are not HTTP. They are interface contracts between modules.

```typescript
// Example: Conversation Engine Interface
interface ConversationEngineInterface {
  startSession(customerId: string, restaurantId: string): Promise<Session>
  processMessage(sessionId: string, message: NormalizedMessage): Promise<ConversationContext>
  getContext(sessionId: string): Promise<ConversationContext>
  endSession(sessionId: string): Promise<void>
}

// Example: Identity Engine Interface
interface IdentityEngineInterface {
  getIdentity(restaurantId: string): Promise<IdentityConfig>
  getCommunicationStyle(restaurantId: string, context: Context): Promise<StyleParams>
}
```

These are TypeScript interfaces, not network calls. Modules run in the same process (for now).

**Future:** If modules need to be separated into microservices, these interfaces become gRPC or message contracts.

---

## API Versioning

All external APIs are versioned:

```
/api/v1/...
/api/v2/... (future)
```

**Versioning policy:**
- Breaking changes → new major version
- Additive changes → within same version
- Deprecation → 6 months notice minimum
- Multiple versions run simultaneously

---

## Rate Limiting

Applied at multiple levels:

| Level | Limit | Response |
|-------|-------|----------|
| Customer | 10 messages/min | 429 Too Many Requests |
| Restaurant | 1000 messages/hour | 429 Too Many Requests |
| API Key | 1000 requests/hour | 429 Too Many Requests |
| IP | 10000 requests/hour | 429 Too Many Requests |

Rate limits are:
- Configurable per restaurant plan
- Stored in Redis (fast)
- Different for AI vs operator messages

---

## Error Response Format

All APIs return consistent error format:

```typescript
interface ApiError {
  success: false
  error: {
    code: string        // "RATE_LIMITED", "INVALID_PARAMETER", etc.
    message: string     // Human-readable
    details?: any       // Additional context
    requestId: string   // For debugging
  }
}
```

**HTTP Status Codes:**

| Code | Meaning |
|------|---------|
| 200 | Success |
| 202 | Accepted (async processing) |
| 400 | Bad request (invalid input) |
| 401 | Unauthorized (missing/invalid auth) |
| 403 | Forbidden (valid auth, insufficient permissions) |
| 404 | Not found |
| 429 | Rate limited |
| 500 | Internal error |
| 502 | Upstream failure (LLM unavailable) |

---

## API Documentation

Every API endpoint is documented with:
- Path and method
- Request format (headers, body, params)
- Response format
- Error codes
- Example requests and responses
- Rate limit information

Documentation is auto-generated from the code (OpenAPI/Swagger).

---

## Status Summary

| API Layer | Status | Priority |
|-----------|--------|----------|
| Channel Webhooks | ✅ Existing | Stable |
| Public REST | ⚠️ Partial | High |
| Admin API | ❌ Missing | Medium |
| Internal Interfaces | ❌ Missing | Critical |
| API Documentation | ❌ Missing | Medium |

---

_BekzatAI — APIs are promises. A change to an API is a broken promise. Version carefully._
