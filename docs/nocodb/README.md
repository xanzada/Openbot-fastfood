# NocoDB Integration

## Жалпы

NocoDB — restaurant конфигурациясы мен "Second Brain" (shpor) сақтауға арналған база. REST API арқылы жұмыс істейді.

## Конфигурация

```
NOCODB_URL             - Base URL
NOCODB_TOKEN           - xc-token
NOCODB_TABLE_ID        - Ресторан конфиг таблицасы
NOCODB_SHPOR_TABLE_ID  - Shpor (екінші ми) таблицасы
```

## Restaurant Config Table (NOCODB_TABLE_ID)

Әрбір ресторан үшін бір жол. instance_id арқылы ізделеді.

### Маңызды өрістер:
- `instance_id` — бірегей идентификатор
- `domain` — DLE сайт домені
- `name` — ресторан аты
- `work_hours` — жұмыс уақыты
- `delivery_areas`, `delivery_info` — жеткізу аймағы
- `admin_phone` — админ телефон
- `developer_phone`, `dev_phone` — әзірлеуші телефон
- `kaspi_info` — Kaspi төлем деректері (fallback)
- `webhook_secret`, `instance_secret`, `tenant_secret` — аутентификация
- `kanban_secret`, `crm_webhook_secret` — kanban аутентификация
- `n8n_webhook_url` — n8n вебхук

### API: getRestaurantConfig(instanceId)
- Cache: 5 минут (Redis)
- Backup: 7 күн
- WHERE: (instance_id,eq,{instanceId})

### API: getAllRestaurantConfigs()
- Барлық ресторандар
- Cache: 5 минут (Redis)
- Backup: 7 күн
- Limit: 1000

## Shpor Table (NOCODB_SHPOR_TABLE_ID)

"Second Brain" — AI агенттің жиі қойылатын сұрақтар мен ерекше жағдайларға арналған жадысы.

### Өрістер:
- `instance_id` — ресторан ID
- `question` — клиент сұрағы
- `ideal_answer` — JSON форматтағы жауап (немесе жай мәтін)
- `category` — санат

### ideal_answer JSON форматы:
```json
{
  "v": 1,
  "kind": "fastfood_second_brain_memory",
  "category": "faq",
  "intent": "stable_intent_name",
  "keywords": ["іздеу", "сөздері"],
  "facts": ["тұрақты факт"],
  "reply_pattern": "жауап шаблоны",
  "tool_policy": "reply_to_customer",
  "confidence": 0.5,
  "source": "ai_shpor_analysis"
}
```

### API: getShporContext(instanceId, query)
1. Барлық shpor жазбаларды жүктеу (cache: 1h)
2. Query бойынша релеванттылықты есептеу (token-based scoring)
3. Ең жоғары score бойынша сұрыптау
4. SHPOR_CONTEXT_LIMIT (default: 8) дейін қайтару

### Scoring алгоритмі:
- Әрбір token 3 балл (егер query token-ы haystack-та болса)
- Ішінара сәйкестік: 1 балл
- confidence < 0.45: 0 балл (фильтр)

### API: evaluateForShpor(question, answer)
- gpt-4o-mini арқылы бағалау
- save: boolean
- category: complaint | complex_order | faq | trash
- confidence: 0..1 (>= 0.45 сақталады)

### API: saveToShpor(instanceId, question, answer, category, memory)
- Дубликат тексеру: question + ideal_answer бойынша
- Лимит: 100 запись бір ресторанға
- Кейбір сұрақтар фильтрленеді (сәлемдесу, жүйелік қате)
