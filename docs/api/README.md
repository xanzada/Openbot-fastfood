# API Endpoints

## Express Routes

### POST /webhook/whatsapp
WhatsApp вебхук — негізгі кіру нүктесі.

**Аутентификация:** Authorization Bearer || x-api-key || body.token
**Body:** { instanceId, phone, text, media, fromMe, msgId, ... }
**Жауап:** 200 OK (дереу, өңдеу асинхронды)

**Өңдеу тәртібі:**
1. verifySecret()
2. guardIncomingMessage()
3. preloadContext()
4. (optional) mediaAnalysis
5. syncKanbanEvent() (async)
6. runFastFoodAgent()
7. validateFinalText()
8. saveToHistory()
9. evaluateForShpor() (async)
10. sendWhatsProResponseSequence()
11. markInboundDone()

### GET /health
Жүйе денсаулығын тексереді.

**Аутентификация:** жоқ
**Жауап:**
```json
{
  "status": "ok",
  "timestamp": "ISO",
  "services": {
    "redis": "healthy" | "unhealthy" | "not_required",
    "whatspro": { "status": "ok" | "error", ... },
    "nocodb": { "status": "ok", ... },
    "chatwoot": "not_configured"
  }
}
```

### POST /kanban-webhook
n8n Kanban вебхук (егер конфигурацияланса).

**Аутентификация:** body.webhook_secret || body.instance_secret || Authorization Bearer
**Body:** { event: 'contact', instance_id, phone, ... }

## DLE API Endpoints (PHP)

### POST /api_bot.php
Ресторан бэкенді.

**Аутентификация:** POST body.token
**Action параметрі:** action=...

| Action | Параметрлер | Қайтарады |
|--------|-------------|-----------|
| get_runtime_status | licenseKey | { settings, kitchen_status, is_accepting_orders, within_work_hours } |
| check_status | phone | { order, status, ... } |
| get_menu_context | lang | [ { cat_id, cat_name, items: [...] } ] |
| update_crm | phone, interest, sales_stage, psycho_analysis | "success" |
| add_payment_comment | phone, amount, [order_id] | "success" |
| get_today_crm | date | [ { phone, interest, sales_stage, ... } ] |
| save_daily_analytics | date, instance_id, data | "success" |

## NocoDB API

### Restaurant Config
- GET /api/v2/tables/{tableId}/records (offset, limit, where)
- Cached (5min), backed up (7d)

### Shpor
- GET /api/v2/tables/{shporTableId}/records
- Cached (1h)
- POST /api/v2/tables/{shporTableId}/records (saveToShpor)

## WhatsPro API

### GET /api/phone/{phone}/screenshot
Экран скриншотын алу.

### POST /api/phone/{phone}/send
Хабарлама жіберу.

**Body:** { text, phone_id, phone, attachments, delay }
**Header:** Authorization: Bearer {token}

### GET /api/phone/{phone}/contacts
Контактілерді синхрондау.

## Redis Operations (18 key types)
(толық тізім — docs/redis/README.md)
