# Skills Architecture

## Жалпы

9 VoltAgent tool тіркелген. Әрбір skill — бұл мамандандырылған функция,
LLM-ге аспап ретінде беріледі. Тіркелген тізім — `src/skills/index.ts`
ішіндегі `FAST_FOOD_SKILL_NAMES` + `createFastFoodSkills()`; бұл құжат сол
файлдағы шындықты ғана жазады.

## Tool Definition

```typescript
interface Tool {
  name: string
  description: string
  parameters: JSONSchema
  execute: (params, context) => Promise<string>
}
```

## 9 Skill

### 1. searchMenu
- **Триггер:** Клиент мәзір туралы сұрағанда
- **Параметр:** `query?: string (≤80)`, `category?: string (≤80)`,
  `limit?: 1..50`, `offset?: 0..5000` — тілді контекст береді (`ctx.language`),
  параметр емес
- **Дерек көзі:** Alemi hub `get_menu_context` (Redis кэші 300s, backup 24h)
- **Логика:** Скорингпен іздеу (name/category/label/description/composition),
  ауысым ескертпелері блоктаған тағамдар алдын-ала шығарылады
- **Беттеу (pagination):** бір шақыруда ең көбі **50** позиция
  (`limit` default 50, 50-ден жоғары мән 50-ге қысылады). Рейтингтелген тізім
  толық саналады, сондықтан:
  - `totalMatched` — шындықтағы сәйкестік саны (шектелмеген),
  - `returned` — осы беттегі саны,
  - `hasMore` / `nextOffset` — қалғаны бар ма және қайдан жалғастыру керек,
  - `truncated: true` + `more_hint` — тізім толық емес екенін модельге тікелей
    айтады («never say or imply it is everything we have»).
  Бұрын рейтингтелген тізімнің өзі де 50-ге қысылатын, сондықтан 120 позициялы
  каталог `totalMatched: 50, nextOffset: null` беріп, бот қонаққа «бізде бары
  осы» деп жауап беретін. Бұл түзетілді.
- **Категориялар:** `categories: [{ name, items }]` — беттен емес, бүкіл
  көрінетін каталогтан жиналады (ең көбі 40 бөлім), сондықтан «қандай
  категориялар бар?» сұрағына толық жауап беруге болады
- **Entity Map:** ингредиент бойынша тапылған сәйкестік `matched_as_ingredient`
  жалауымен белгіленеді (мыс. «лаваш» → Донер)
- **Fail case:** каталог оқылмаса `menu_lookup: "unavailable"` (бос мәзірден
  ажыратылады), нөл сәйкестік болса `safe_alternatives` (≤3)

### 2. getPaymentDetails
- **Триггер:** Клиент төлем туралы сұрағанда
- **Параметр:** `lang: 'kk' | 'ru'`
- **Дерек көзі:** Redis кэші (config астында) + runtime status
- **Логика:** Kaspi деректері болмаса, runtime статустағы реквизиттер

### 3. updateCrmLead
- **Триггер:** Әр LLM шақыру соңында (auto)
- **Параметр:** `interest, sales_stage, psycho_analysis`
- **Дерек көзі:** Alemi hub `crm.lead.upsert`
- **Логика:** Клиенттің interest, sales_stage, psycho_analysis жаңарту.
  Тенант конфигі қолтаңбаға ғана беріледі, `daily_logs` жазбасына кірмейді.

### 4. escalateToAdmin
- **Триггер:** Клиенттің проблемасын агент шеше алмаса
- **Параметр:** `reason: string, lang: 'kk' | 'ru'`
- **Дерек көзі:** Redis + WhatsPro
- **Логика:**
  1. Redis-ке эскалацияны сақтау (5min)
  2. Админге WhatsApp хабарлама жіберу
  3. Қайталама эскалацияны блоктау (30s)

### 5. sendMenuLink
- **Триггер:** Клиент сілтеме сұраса
- **Параметр:** `businessLang: 'kk' | 'ru'`
- **Дерек көзі:** Redis (has_sent_link state) + `customer.access_link.issue`
- **Логика:**
  - Егер сілтеме жіберілген болса → "Алдыңғы сілтемемен тапсырыс бере аласыз."
  - Егер сілтеме жіберілмеген болса → URL қайтарады

### 6. checkOrderStatus
- **Триггер:** Клиент өз тапсырысының күйін сұрағанда
- **Параметр:** `order_id?` (болмаса телефон бойынша соңғылары)
- **Дерек көзі:** Alemi hub `order.status.get` / `order.context.get`
- **Ескерту:** hub `order_id` өрісін қабылдамайды (400
  INTEGRATION_COMMAND_INVALID), сол үшін тапсырыс қайтарылған тізімнен
  таңдалады

### 7. getBusinessInfo
- **Триггер:** Мекенжай, жұмыс уақыты, жеткізу шарттары сұралғанда
- **Дерек көзі:** Тенант конфигі (platform)

### 8. getKitchenStatus
- **Триггер:** Күту уақыты, шұғыл тоқтау, жеткізу/өзі алып кету қолжетімділігі,
  төлем реквизиттері туралы жауап бермес бұрын
- **Дерек көзі:** hub `runtime.status.get` (forceFresh) → Redis fallback →
  10 минуттық backup
- **Логика:** `live` / `is_last_known` жалаулары арқылы модель ескі күйді
  «дәл қазір тексерілген факт» деп ұсынбайды

### 9. getShiftNotes
- **Триггер:** Уақытша шектеулер, стоп-лист, ауысым ескертпелері туралы
  жауап бермес бұрын
- **Дерек көзі:** Redis (`getActiveShiftNotes`)
- **Логика:** Ескертпенің шикі мәтіні модельге жіберілмейді — тек
  `publicNoteConstraints()` шығарған `unavailable_now` шектеулері

### Тіркелмеген: searchWeb (`src/skills/tavilySearch.skill.ts`)
Код бар, бірақ `createFastFoodSkills()` ішіне қосылмаған және
`TAVILY_API_KEY` продакшнда орнатылмаған. Мейрамхана ботына веб-іздеу
қажет болмағандықтан, әдейі өшірулі тұр. Қосу үшін: env кілтін орнатып,
`index.ts`-ке `createTavilySearchSkill(ctx)` қосу керек.

## Skill Limits

- **maxSteps:** 6 (`src/agent/fastfoodAgent.ts`)
- **searchMenu:** бір бетте ≤50 позиция; `totalMatched` шектелмейді;
  толық емес бет `hasMore`/`nextOffset`/`more_hint` арқылы жарияланады
  (`tok_cap` деген шектеу кодта жоқ — бұрынғы құжат қате жазған)
- **Preload menu snapshot:** әр кезеңде FACTS_CONTEXT ішіне ≤60 позиция кіреді
  (`src/context/preloadContext.ts` → `buildMenuSnapshot`), бірақ
  `total_on_menu` нақты санды көрсетеді және 60-тан асса `truncated: true` +
  `truncation_rule` қосылады, сондықтан модель тізімде жоқ тағамды «жоқ» деп
  жарияламайды, searchMenu-ды шақырады
- **escalation cooldown:** 30 секунд
- **sendMenuLink:** күніне 1 рет (30-day TTL)

## Dependency Graph

```
fastfoodAgent.ts
├── services/dle.service.ts (searchMenu, getPaymentDetails, updateCrmLead, getKitchenStatus)
├── services/alemiApi.service.ts (HMAC-қолтаңба, барлық hub командасы)
├── utils/magicLink.ts (sendMenuLink)
├── services/diagnostics.service.ts (escalateToAdmin)
├── services/redis.service.ts (escalation dedup, getShiftNotes)
└── services/platformConfig.service.ts (getBusinessInfo)
```
