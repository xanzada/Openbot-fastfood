# API Endpoints

> Сайт жағын жазатын әзірлеуші үшін толық келісімшарт (қолтаңба, өріс атаулары,
> міндетті өрістер, қателер): [../integration/site-integration.md](../integration/site-integration.md)

## Express Routes

### POST /whatspro-webhook
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
Alemi event webhook. `order.*` және `shift_note.*` оқиғалары қазіргі kanban әрекеттеріне нормализацияланады.

**Аутентификация:** restaurant Secret Key (`?token=...` немесе tenant secret header), timing-safe compare
**Body:** Alemi event envelope немесе legacy-compatible payload

## Alemi Business API

### POST https://hub.alemi.kz/v1/integrations/bot/commands
Ресторанның HMAC-қолтаңбалы командалық API-і.

**Аутентификация:** X-Platform-Instance, X-Command-Id, X-Command-Timestamp және X-Command-Signature.

| Command | Мақсаты |
|---------|---------|
| runtime.status.get | Асхана/жеткізу/төлем статусы |
| order.context.get | Клиенттің белсенді және соңғы тапсырыстары |
| order.status.get | Тапсырыс статусын қысқа тексеру |
| catalog.context.get | Каталог, баға, бонус және тегтер |
| crm.lead.upsert | CRM лидін сақтау |
| crm.today.get | Күндік CRM лидтері |
| analytics.daily.upsert | Күндік AI аналитика |
| customer.access_link.issue | Қорғалған клиент сілтемесі |
| order.payment_receipt.analyzed | Файлсыз: чек AI талдауының аты-жөні, сомасы және банкі |

OpenBot алдымен файлсыз `order.payment_receipt.analyzed` командасын жібереді. Hub бұл
команданы әлі нақты `unsupported` деп қайтарса ғана уақытша
`POST /v1/integrations/bot/order-documents` fallback-ы қолданылады. Команда қолдауға
енген бойда raw чек жіберу автоматты тоқтайды. Принтер нәтижесі
`POST /v1/integrations/bot/print-results` арқылы сол Secret Key-пен жіберіледі.

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
