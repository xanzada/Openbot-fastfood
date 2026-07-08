# Tenant Configuration: restaurant_dodo_almaty

> **Ресторан:** Dodo Pizza Almaty
> **Instance:** dodo_almaty
> **Статус:** active

---

## Basic Info

| Поле | Мәні |
|------|------|
| Tenant ID | `restaurant_dodo_almaty` |
| Instance | `dodo_almaty` |
| Phone | `77001234567` |
| API Token | `tenant_dodo_almaty_abc123` |
| Webhook URL | `https://api.openbot.kz/webhook/whatsapp` |
| Webhook Secret | `whsec_dodo_almaty_def456` |
| LLM Model | `google/gemini-2.5-flash` |
| Temperature | 0.7 |
| Max Tokens | 500 |

## NocoDB

| Table | Record ID | Filter |
|-------|-----------|--------|
| Config | `rec_config_dodo_001` | `instance = dodo_almaty` |
| Shpor (menu) | `rec_shpor_dodo_001` | `instance = dodo_almaty` |

## Redis Keys

| Prefix | Description | TTL |
|--------|-------------|-----|
| `dodo_almaty:config` | Конфигурация кэші | 300s |
| `dodo_almaty:shpor` | Мәзір кэші | 120s |
| `ratelimit:dodo_almaty:*` | Rate limit counter | 60s |
| `spam:dodo_almaty:*` | Spam mute | 900s |
| `context:dodo_almaty:*` | LLM контекст | 600s |

## Features

| Feature | Enabled | Примечание |
|---------|---------|------------|
| Menu links | Yes | "Мәзір" → WhatsApp сілтемесі |
| Printing | No | v1.2-де print әзірше жоқ |
| Shift notes | Yes | n8n арқылы |
| Custom prompt | No | Стандартты instructions.ts |
| Time-based menu | No | TODO: v1.3 (sushi filter 18:00-23:00) |

## Rate Limits

| Limit | Мәні |
|-------|------|
| Messages per minute | 15 |
| Spam threshold | 6 (15 минут mute) |
| Spam mute duration | 15 мин (900s TTL) |

## Contacts

| Роль | Аты | Телефон |
|------|-----|---------|
| Admin | Асхат (менеджер) | 77001234567 |
| Manager | Нұрлан (ауысым) | 77007654321 |

## LLM Performance

| Метрика | v1.1 (ескі) | v1.2 (жаңа) |
|---------|-------------|--------------|
| Response time (p50) | 2.5s | 1.2s |
| Token usage avg | 850 | 720 |
| Daily requests | ~300 | ~250 |
| Hallucination rate | 8% | <1% |
| Error rate | 1.5% | 0.5% |

## Notes

- Жаңа tenant: 2026-06-01
- Арнайы талап: сушиді кешкісін ғана көрсету (time-based filter)
- LLM model: gemini-2.5-flash — өте жақсы нәтиже. GPT-4o Mini тек fallback ретінде.

---

_Author: BekzatAI EOS_
