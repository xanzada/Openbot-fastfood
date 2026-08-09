# Reference

## Толық анықтамалық

### Environment Variables

| Айнымалы | Default | Сипаттамасы |
|----------|---------|-------------|
| PORT | 3000 | HTTP сервер порты |
| REDIS_URL | - | Redis қосылу URL |
| REDIS_PASSWORD | - | Redis паролі |
| TENANTS_PLATFORM_BASE_URL | https://whatspro.alemi.kz | Tenant конфигі мен жады |
| TENANTS_PLATFORM_API_TOKEN | - | Master API токені |
| WHATSAPP_PRO_URL | - | WhatsPro URL |
| WHATSAPP_PRO_TOKEN | - | WhatsPro токен |
| WHATSAPP_PRO_PHONE | - | WhatsApp телефон ID |
| OPENROUTER_API_KEY | - | OpenRouter API кілті |
| OPENROUTER_BASE_URL | https://openrouter.ai/api/v1 | OpenRouter base URL |
| ALEMI_API_URL | https://hub.alemi.kz | Alemi business API base URL |
| ALEMI_INSTANCE | - | Бір-ресторандық fallback instance |
| ALEMI_SECRET | - | Бір-ресторандық fallback Secret Key |
| TAVILY_API_KEY | - | Tavily іздеу токен |
| NODE_ENV | development | Орта |
| ENABLE_PRIVATE_IP_BLOCK | true | SSRF қорғаныс |
| LOG_LEVEL | info | Лог деңгейі |

### Redis Key Pattern Reference

| Key Pattern | Type | TTL | Max Size | Purpose |
|-------------|------|-----|----------|---------|
| `history:{instance}:{phone}` | List | 7d | 120 | Сөйлесу тарихы |
| `lang:{instance}:{phone}` | String | 12h | - | Тіл кэші |
| `has_sent_link:{instance}:{phone}` | String | 30d | - | Сілтеме статусы |
| `shift_note:{instance}:{id}` | String | 24h | - | Ауысым жазбасы |
| `runtime_status:{instance}` | String | 5s | - | Асхана статусы |
| `runtime_status_backup:{instance}` | String | 10min | - | Backup |
| `config:{instance}` | String | 5min | - | Ресторан конфигі |
| `config_backup:{instance}` | String | 7d | - | Backup |
| `menu_context:{instance}:{lang}` | String | 5min | - | Мәзір кэші |
| `menu_context_backup:{instance}:{lang}` | String | 1d | - | Backup |
| `shpor_context_100:{instance}` | String | 1h | 100 | Shpor кэші |
| `spam:{instance}:{phone}` | Counter | 1min | - | Спам есептегіш |
| `mute:{instance}:{phone}` | String | 15min | - | Спам блок |
| `anti_dup:{instance}:{phone}` | String | 5s | - | Дубликат хэш |
| `msg_done:{instance}:{msgId}` | String | 24h | - | Өңделген хабар |
| `msg_processing:{instance}:{msgId}` | String | 3min | - | Өңдеу lock |
| `complaint_media:{instance}:{phone}` | String | 5min | - | Шағым медиасы |
| `media_context:{instance}:{phone}` | String | 1min | - | Медиа контекст |
| `daily_logs:{instance}` | List | 2d | - | Күнделік есеп |
| `daily_logs_counter:{instance}` | Counter | 2d | - | Есептегіш |

### Error Codes

| Код | Сипаттамасы |
|-----|-------------|
| REDIS_FAIL | Redis қолжетімсіз, backup қолданылады |
| ALEMI_FAIL | Alemi API қолжетімсіз, cache қолданылады |
| TENANTS_PLATFORM_FAIL | Tenant конфиг API қолжетімсіз, cache қолданылады |
| LLM_FAIL | OpenRouter қатесі, қайталау |
| WHATSPRO_FAIL | WhatsApp API қатесі, developerNotify |
| SPAM_BLOCK | Спам фильтрі, mute |
| DUPLICATE | Дубликат хабар, skip |
| INVALID_INSTANCE | InstanceId қате |
