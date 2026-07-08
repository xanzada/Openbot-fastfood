# 03. API

> Мақсаты: Барлық API контрактілерін, webhook форматтарын және интеграциялық келісімдерді құжаттау.

## Мазмұны

- [API Endpoint Template](./templates/api-endpoint.md)
- [Webhook Contract Template](./templates/webhook-contract.md)

## API тізімі

| Endpoint | Әдіс | Сипаттамасы | Аутентификация |
|----------|------|-------------|----------------|
| `/webhook/whatsapp` | POST | WhatsApp хабарламаларын қабылдау | Bearer / x-api-key / tenant secret |
| `/health` | GET | Жүйе денсаулығын тексеру | Жоқ |
| `/health/detailed` | GET | Толық диагностика | Жоқ |
| `/kanban-webhook` | POST | n8n-нен келетін вебхуктар | Tenant secret |
| `/api/print_trigger` | POST | Принтер сигналы | Tenant secret |

## API принциптері

1. Барлық жауаптар JSON форматында
2. Барлық қателер `{ ok: false, error: "message" }` форматында
3. POST request body `application/json`
4. Аутентификация: Authorization Bearer → x-api-key → body.token → tenant secret
5. Сыртқы жүйелер үшін DNS-level SSRF қорғанысы

## Rate Limiting

- Глобалды емес, tenant-level (Redis арқылы)
- Default: 15 хабар/минут tenant бойынша
- 6+ spam → 15 минут mute

---

_Author: BekzatAI EOS_
