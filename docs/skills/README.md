# Skills Architecture

## Жалпы

7 VoltAgent tool. Әрбір skill — бұл мамандандырылған функция, LLM-ге аспап ретінде беріледі.

## Tool Definition

```typescript
interface Tool {
  name: string
  description: string
  parameters: JSONSchema
  execute: (params, context) => Promise<string>
}
```

## 7 Skill

### 1. searchMenu
- **Триггер:** Клиент мәзір туралы сұрағанда
- **Параметр:** `query: string, lang: 'kk' | 'ru'`
- **Дерек көзі:** DLE get_menu_context (cached)
- **Логика:** DLE мәзірінен іздеу, топтау
- **Entity Map:** local_aliases (шашлык/шашлычки → "Шашлык")
- **Шектеу:** Қайтару өлшемі (tok_cap: 1500)
- **Fail case:** "Мәзір қазіргі уақытта қолжетімсіз"

### 2. getPaymentDetails
- **Триггер:** Клиент төлем туралы сұрағанда
- **Параметр:** `lang: 'kk' | 'ru'`
- **Дерек көзі:** Redis кэші (config астында)
- **Логика:** Егер Kaspi деректері болмаса → DLE kitchen_status пайдаланады

### 3. registerPaymentReceipt
- **Триггер:** Клиент чек жібергенде
- **Параметр:** `amount: string, lang: 'kk' | 'ru'`
- **Дерек көзі:** DLE add_payment_comment
- **Логика:** Чек сомасын validate + DLE-ге сақтау

### 4. updateCrmLead
- **Триггер:** Әр LLM шақыру соңында (auto)
- **Параметр:** `lang: 'kk' | 'ru'`
- **Дерек көзі:** DLE update_crm
- **Логика:** Клиенттің interest, sales_stage, psycho_analysis жаңарту

### 5. escalateToAdmin
- **Триггер:** Клиенттің проблемасын агент шеше алмаса
- **Параметр:** `reason: string, lang: 'kk' | 'ru'`
- **Дерек көзі:** Redis + WhatsPro
- **Логика:** 
  1. Redis-ке эскалацияны сақтау (5min)
  2. Админге WhatsApp хабарлама жіберу
  3. Қайталама эскалацияны блоктау (30s)

### 6. sendMenuLink
- **Триггер:** Клиент сілтеме сұраса
- **Параметр:** `businessLang: 'kk' | 'ru'`
- **Дерек көзі:** Redis (has_sent_link state)
- **Логика:**
  - Егер сілтеме жіберілген болса → "Алдыңғы сілтемемен тапсырыс бере аласыз."
  - Егер сілтеме жіберілмеген болса → URL қайтарады

### 7. searchWeb
- **Триггер:** Сирек, тек нақты сұрау кезінде
- **Параметр:** `query: string`
- **Дерек көзі:** Tavily API
- **Логика:** Tavily search, text summary

## Skill Limits

- **maxToolSteps:** 6 (барлығы)
- **searchMenu limits:** tok_cap: 1500 (үлкен мәзір үшін)
- **escalation cooldown:** 30 секунд
- **sendMenuLink:** күніне 1 рет (30-day TTL)

## Dependency Graph

```
fastfoodAgent.ts
├── services/dle.service.ts (searchMenu, getPaymentDetails, registerPaymentReceipt, updateCrmLead)
├── utils/magicLink.ts (sendMenuLink)
├── services/diagnostics.service.ts (escalateToAdmin)
├── services/redis.service.ts (escalation dedup)
├── services/nocodb.service.ts (searchWeb)
└── ... (каждый skill)
```
