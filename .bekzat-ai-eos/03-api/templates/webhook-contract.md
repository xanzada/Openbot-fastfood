# Webhook Contract: Kanban Webhook (n8n + DLE)

> **Нұсқа:** 1.1
> **URL:** `POST /kanban-webhook`
> **Жіберуші:** n8n workflow / DLE CRM
> **Қабылдаушы:** Openbot-fastfood server

---

## 1. Мақсаты

n8n-нен және DLE CRM-ден келетін вебхуктарды қабылдайды: ауысым жазбаларын (shift note) сақтау/жою, төлем реквизиттерін жіберу, еркін хабарлама жіберу, принтер сигналы, заказ статусын өзгерту. Барлық әрекеттер Redis/NocoDB/DLE арқылы өңделеді, LLM шақырылмайды.

## 2. Trigger

- **Оқиға:** n8n workflow аяқталғанда, DLE CRM-де заказ статусы өзгергенде
- **Frequency:** Әр 5-60 минут (күніне 50-500 рет)
- **Формат:** JSON

## 3. Request Body

```json
{
  "token": "string",
  "instance": "string",
  "instanceId": "string",
  "restaurant_id": "string",
  "phone": "77001234567",
  "action": "shift_note_created | shift_note_deleted | request_payment | send_message | new_order",
  "event": "shift_note_created | shift_note_deleted | request_payment | send_message | new_order",
  "status": "paid",
  "new_status": "paid",
  "order_status": "paid",
  "order_id": "ORD-12345",
  "data": {}
}
```

| Поле | Типі | Міндетті | Сипаттамасы |
|------|------|----------|-------------|
| `token` | string | Шартты | Global webhook secret немесе tenant secret |
| `instance` / `instanceId` / `restaurant_id` | string | Иә | Tenant ID (үш өрістің біреуі міндетті) |
| `phone` | string | Шартты | Клиент телефон (request_payment, send_message үшін) |
| `action` | string | Шартты | Оқиға типі (action немесе event өрісі) |
| `event` | string | Шартты | Оқиға типі (action немесе event өрісі) |
| `status` / `new_status` / `order_status` | string | Жоқ | "paid" болса → принтер сигналы |
| `data` | object | Жоқ | Оқиғаға байланысты деректер |
| `text` / `message` | string | Шартты | Жіберілетін хабарлама мәтіні |
| `id` / `note_id` / `key` | string | Шартты | Shift note идентификаторы |

## 4. Supported Events

### shift_note_created

```json
{
  "action": "shift_note_created",
  "note": "Бүгін пицца көп сатылды",
  "author": "Асхат"
}
```

**Action:** Redis-те сақталады (`shift:notes:{instance}`), клиентке хабарланбайды.
**Response:** `{ ok: true, action, saved: true }`

### shift_note_deleted

**Action:** Redis-тен жойылады.
**Response:** `{ ok: true, action, deleted: true }`

### status = "paid"

```json
{
  "instance": "dodo_almaty",
  "order_id": "ORD-12345",
  "status": "paid",
  "items": ["Пицца Маргарита"],
  "total": 4500
}
```

**Action:** Socket.io арқылы `print_new_order` event жіберіледі → принтерге сигнал.
**Response:** `{ ok: true, action: "paid" }` (emitPrintNewOrder)

### request_payment

```json
{
  "action": "request_payment",
  "phone": "77001234567"
}
```

**Action:**
1. `getRestaurantConfig(instanceId)` — конфиг алу
2. `getRuntimeStatus(instanceId, domain)` — runtime төлем деректерін алу
3. Егер runtime-да payment_details болса → соларды жіберу
4. Егер runtime бос болса → NocoDB config-тағы kaspi_info fallback
5. WhatsApp арқылы жіберу

**Response:** `{ ok: true, action, sent: true/false }`

### send_message

```json
{
  "text": "Сіздің заказыңыз дайын!",
  "phone": "77001234567"
}
```

**Action:** Еркін мәтінді WhatsApp арқылы жібереді.
**Response:** `{ ok: true, action: "send_message", send: { ... } }`

### new_order / print_order

```json
{
  "action": "new_order",
  "print": true,
  "order_id": "ORD-12345"
}
```

**Action:** Socket.io арқылы принтер сигналы жіберіледі (егер io бар болса).
**Response:** `{ ok: true, action: "new_order" }`

## 5. Аутентификация

- **Header:** `Authorization: Bearer {token}`
- **Body:** `token` поле
- **Query:** `?token=...`
- **Global webhook secret:** `OPENBOT_WEBHOOK_SECRET` немесе `CRM_SECRET_TOKEN` — кез келген tenant-қа рұқсат
- **Tenant-level:** `assertTenantSecret()` — NocoDB config-тағы secret арқылы
- Егер ешқайсысы сәйкес келмесе → 401 Unauthorized

## 6. Error Handling

- 2xx → "Accepted" (қабылданды)
- 4xx → "Rejected" (жіберуші қате)
- 5xx → **Critical:** `notifyKanbanDeveloperSiren()` — developer-ге WhatsApp арқылы "CRITICAL DLE KANBAN ERROR" хабарламасы жіберіледі
- Fire-and-forget: жауап күтілмейді

## 7. Developer Siren (Incident Notification)

Егер kanban webhook-та қате шықса:
1. `notifyKanbanDeveloperSiren(req, error)` шақырылады
2. Developer телефон нөмірі config.developer / config.developer_phone / config.dev_phone / `.env DEVELOPER_PHONE` арқылы анықталады
3. WhatsApp хабарлама: "CRITICAL DLE KANBAN ERROR! Instance, Заказ №, Қате"
4. `notifyDeveloperSystemFailure()` — қосымша лог

## 8. Rate Limits

- Жоқ (n8n бақылайды)
- Егер бір tenant 60 req/min асатын болса → 429 Too Many Requests

## 9. Changelog

| Күні | Өзгеріс | Автор |
|------|---------|-------|
| 2026-01-15 | Бастапқы нұсқа (shift_note + send_message) | BekzatAI |
| 2026-03-01 | request_payment, print_trigger, developer siren | BekzatAI |
| 2026-06-10 | Аутентификация chain-і (global + tenant), paid status | BekzatAI |
| 2026-07-01 | NocoDB kaspi_info fallback, 3 instance field | BekzatAI |

---

_Author: BekzatAI EOS_
