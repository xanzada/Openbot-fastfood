# API

> **Style:** RESTful JSON. **Base:** `https://api.bekzatai.kz`.

## Endpoints

### Public

| Method | Path | Auth | Rate Limit | Purpose |
|--------|------|------|------------|---------|
| `GET` | `/health` | None | — | Liveness check |
| `GET` | `/health/detailed` | Chain | — | Redis, NocoDB, uptime |

### Webhook

| Method | Path | Auth | Rate Limit | Purpose |
|--------|------|------|------------|---------|
| `POST` | `/webhook/whatsapp` | Chain (secret) | 15/60/300 req/min | Inbound WhatsApp messages |
| `POST` | `/kanban-webhook` | Chain (secret) | 30 req/min | n8n order status updates |

### Admin

| Method | Path | Auth | Purpose |
|--------|------|------|---------|
| `GET` | `/api/print_trigger` | Chain | Printer signal via Socket.io |
| `GET` | `/api/admin/tenants` | Admin | List all tenants |
| `POST` | `/api/admin/flags/:name/enable` | Admin | Enable feature flag globally |

## Auth Chain

```
1. OPENBOT_WEBHOOK_SECRET  → Bearer token
2. CRM_SECRET_TOKEN        → x-api-key / body.token
3. assertTenantSecret()    → tenant-level secret (NocoDB config)
```

## Response Format

```typescript
// Success
{ ok: true, data: {...} }

// Error
{ ok: false, error: "message" }

// Async (webhook)
202 Accepted
{ ok: true, message: "accepted" }
// Actual response sent later via WhatsApp
```

## Status Codes

| Code | When |
|------|------|
| 200 | Success |
| 202 | Accepted (async processing) |
| 400 | Bad request (missing `instance`) |
| 401 | Unauthorized (invalid secret) |
| 403 | Forbidden (wrong tenant) |
| 429 | Rate limited |
| 500 | Internal error |

## Webhook Input

```typescript
POST /webhook/whatsapp
{
  "instance": "prestige",     // tenant ID
  "type": "message",
  "message": {
    "from": "77001234567",    // sender phone
    "body": "Мәзір жіберіңіз",
    "type": "text",
    "id": "whatsapp_msg_id",
    "fromMe": false           // operator message?
  }
}
```

---

_See: `03-api/templates/api-endpoint.md`, `03-api/templates/webhook-contract.md`_
