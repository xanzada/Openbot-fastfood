# API Endpoint: WhatsApp Webhook

> **Нұсқа:** 1.3
> **URL:** `POST /webhook/whatsapp`
> **Статус:** Active

---

## 1. Сипаттамасы

WhatsPro Cloud платформасынан келетін WhatsApp хабарламаларын қабылдайды. Әрбір хабарлама аутентификациядан, fromMe тексеруден, spam детекциясынан, pre-LLM short-circuit, LLM өңдеу және post-LLM validation арқылы өтеді.

**Маңызды:** Сервер 202 Accepted қайтарады және хабарламаны асинхронды өңдейді (`setImmediate`). Клиент жауапты WhatsApp арқылы кейінірек алады.

## 2. Request

### Headers

| Header | Міндетті | Формат | Мысал |
|--------|----------|--------|-------|
| `Content-Type` | Иә | `application/json` | |
| `Authorization` | Жоқ | `Bearer {token}` | `Bearer abc123` |
| `x-api-key` | Жоқ | `string` | `abc123` |

### Body

```json
{
  "token": "tenant_abc123",
  "instance": "restaurant_dodo_pizza",
  "instanceId": "restaurant_dodo_pizza",
  "phone": "77001234567",
  "event": "incomingMessage",
  "message": "Мәзірді көрсетіңізші",
  "fromMe": false
}
```

| Поле | Типі | Міндетті | Сипаттамасы |
|------|------|----------|-------------|
| `token` | string | Шартты | Tenant аутентификация токені (global secret немесе tenant secret) |
| `instance` / `instanceId` / `restaurant_id` | string | Иә | Tenant идентификаторы (үш өріс те қолданылады) |
| `phone` | string | Иә | Клиенттің телефон нөмірі (KZ форматы: 7700XXXXXXX) |
| `event` | string | Шартты | Оқиға типі (incomingMessage, т.б.) |
| `message` | string | Шартты | Хабарлама мәтіні |
| `fromMe` | boolean | Жоқ | Егер true болса, бұл оператор хабары (LLM шақырылмайды) |
| `source` | string | Жоқ | Хабарлама көзі |
| `data.key.fromMe` | boolean | Жоқ | Батырма форматындағы fromMe |
| `data.key.id` | string | Жоқ | Хабарлама ID (dedup үшін) |
| `data.key.remoteJid` | string | Жоқ | WhatsApp remote JID |
| `senderMeta.pushName` | string | Жоқ | Жіберушінің WhatsApp аты |

## 3. Response

### 202 Accepted — Хабарлама қабылданды (асинхронды өңделеді)

```json
{
  "ok": true,
  "accepted": true
}
```

### 202 Accepted — Оператор хабары (fromMe) — өңделмейді

```json
{
  "ok": true,
  "skipped": true,
  "reason": "fromMe"
}
```

### 401 Unauthorized

```json
{
  "ok": false,
  "error": "unauthorized"
}
```

### 400 Bad Request

```json
{
  "ok": false,
  "error": "instance is required"
}
```

### 5xx Error

```json
{
  "ok": false,
  "error": "internal server error"
}
```

## 4. Аутентификация

Екі деңгейлі аутентификация:

1. **Global webhook secret:** `Authorization: Bearer {token}` немесе `x-api-key: {token}` немесе `body.token` — `OPENBOT_WEBHOOK_SECRET` немесе `CRM_SECRET_TOKEN`-мен салыстырылады
2. **Tenant auth (fallback):** Егер global secret сәйкес келмесе, `getRestaurantConfig(instanceId)` → `assertTenantSecret(req, config, "webhook")`

## 5. Rate Limiting

- **Limit:** 15 request/минут tenant бойынша (inboundGuard.service.ts)
- **Window:** Sliding window (Redis)
- **Spam threshold:** 6+ хабарлама тез арада → 15 минут mute
- **Operator override:** Егер operators phone-нан хабар келсе, auto-mute 5 минут
- **Response:** 202 Accepted (accepted: false) + "Сіз тым көп хабарлама жібердіңіз"

## 6. fromMe (Оператор хабары)

Егер `fromMe === true` немесе `data.key.fromMe === true`:
1. Оператор mute 5 минутқа қойылады (operator_mute)
2. Хабар тарихқа "operator" ретінде сақталады
3. LLM шақырылмайды
4. Жауап: 202 { skipped: true, reason: "fromMe" }

## 7. Мысалдар

### cURL

```bash
curl -X POST http://localhost:4100/webhook/whatsapp \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer whsec_global" \
  -d '{
    "instance": "restaurant_1",
    "phone": "77001234567",
    "message": "Ассаламуғалейкум"
  }'
```

### Response

```json
{
  "ok": true,
  "accepted": true
}
```

## 8. Error Codes

| Код | HTTP Status | Себебі |
|-----|-------------|--------|
| `unauthorized` | 401 | Global webhook secret + tenant auth failed |
| `missing_fields` | 400 | instanceId/instance/restaurant_id жоқ |
| `fromMe` | 202 | Оператор хабары, өңделмейді |
| `spam_blocked` | 202 | 6+ хабарлама, 15 мин mute |

## 9. Changelog

| Күні | Өзгеріс | Автор |
|------|---------|-------|
| 2026-01-15 | Бастапқы нұсқа | BekzatAI |
| 2026-03-01 | fromMe обработкасы қосылды | BekzatAI |
| 2026-06-01 | 202 Accepted (асинхронды) | BekzatAI |
| 2026-06-10 | Аутентификация chain-і жаңартылды (global + tenant) | BekzatAI |
| 2026-07-01 | senderMeta, mediaContext, video check қосылды | BekzatAI |

---

_Author: BekzatAI EOS_
