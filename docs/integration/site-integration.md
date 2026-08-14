# Сайтты ботпен жалғау — толық келісімшарт

Бұл құжат **сайт жағын жазатын әзірлеушіге** арналған. Мұнда бот нақты не жіберетіні,
нақты не күтетіні, қолтаңба қалай есептелетіні және қандай өрістер міндетті екені
жазылған. Барлық мәлімет кодтан алынған — файл мен жол нөмірі әр бөлімде көрсетілген,
екіталай жерде кодты оқып тексеруге болады.

Негізгі файлдар:

| Не | Файл |
|---|---|
| Қолтаңба, тақырыптар, командалар | `src/services/alemiApi.service.ts` |
| Жауаптарды оқу (қандай өріс керек) | `src/services/dle.service.ts` |
| Сайттан келетін webhook | `src/routes/dleWebhook.route.ts`, `src/controllers/kanban.ts` |
| Webhook аутентификациясы | `src/services/tenantAuth.service.ts` |

---

## 1. Жалпы сурет

Екі бағыт бар, екеуі де **бір ғана symmetric Secret Key**-ді қолданады.

```
┌──────────────┐   1. қолтаңбалы команда (HMAC)      ┌──────────────┐
│              │  ──────────────────────────────────▶│              │
│     БОТ      │     POST /v1/integrations/bot/...   │  САЙТ / HUB  │
│  (openbot)   │                                     │ hub.alemi.kz │
│              │◀────────────────────────────────────│              │
└──────────────┘   2. оқиға webhook (?token=)        └──────────────┘
        │              POST /kanban-webhook
        │
        │ WhatsApp (whatspro-gateway)
        ▼
    клиент
```

- **1-бағыт (бот → сайт).** Бот меню, тапсырыс, ас үй статусын сұрайды. 8 команда бар.
  Барлығы бір URL-ге барады, `command` өрісімен ажыратылады.
- **2-бағыт (сайт → бот).** Сайтта тапсырыс құрылғанда/статусы өзгергенде сайт ботқа
  оқиға жібереді, бот клиентке WhatsApp-пен жазады.

Сайт жағы **екі бағытты да** жүзеге асыруы керек: 1-бағытта — сервер (қолтаңбаны
тексеретін endpoint), 2-бағытта — клиент (webhook жіберетін).

---

## 2. Secret Key

**Кілтті сайт жағы генерациялайды** және ботқа береді. Бот оны өзі ойлап шығармайды.

```
Secret Key = кез келген криптографиялық кездейсоқ жол (32+ байт ұсынылады)
Мысалы: openssl rand -hex 32
```

Бір ғана мән, екі бағытта да қолданылады:

| Бағыт | Кілт қалай қолданылады |
|---|---|
| бот → сайт | `X-Command-Signature` тақырыбындағы HMAC-SHA256 құпиясы |
| сайт → бот | `?token=<Secret Key>` (немесе `X-Tenant-Key` тақырыбы) |

`src/services/tenantAuth.service.ts:52-63` — бот бұл мәнді `ALEMI_TENANT_SECRETS_JSON`
env-інен немесе tenant конфигінің `alemi_secret` / `kanban_secret` өрісінен оқиды.
Салыстыру `crypto.timingSafeEqual` арқылы (`safeCompare`, 3-12 жол).

### Instance ID — үш жерде бірдей болуы міндетті

`instance` — ресторанның идентификаторы (мысалы `prestige`). Ол **үш жерде** бірдей жол
болуы керек:

1. сайт/хаб жағындағы «ID инстанса»,
2. WhatsPro tenant-індегі `alemi_instance`,
3. боттың ішкі `instance_id`.

Біреуі басқаша болса, құпия дұрыс болса да хаб инстансты таба алмайды және қолтаңба
сәйкеспейді — нәтижесі `401 INTEGRATION_SIGNATURE_INVALID`. Формат:
`/^[a-zA-Z0-9_-]{2,64}$/` (`src/routes/dleWebhook.route.ts:18`).

---

## 3. 1-бағыт: бот → сайт (қолтаңбалы командалар)

### 3.1 Сұраныс

```
POST {ALEMI_API_URL}/v1/integrations/bot/commands
Content-Type: application/json

X-Platform-Instance:  prestige
X-Command-Id:         cmd_1A2B3C4D5E6F708192A3B4C5D6
X-Command-Timestamp:  1786439600
X-Command-Signature:  v1=<hex>
```

Дене (`buildAlemiSignedCommand`, `alemiApi.service.ts:191-217`) — өріс тәртібі дәл осылай,
себебі қолтаңба **дәл осы жолдың байттарынан** есептеледі:

```json
{
  "command": "catalog.context.get",
  "command_id": "cmd_1A2B3C4D5E6F708192A3B4C5D6",
  "data": { "locale": "kk" },
  "instance": "prestige",
  "schema_version": 1
}
```

`command_id` форматы: `cmd_` + 26 таңба **бас әріппен hex** (`createAlemiCommandId`,
172-176 жол). Кәдімгі UUID қабылданбайды.

### 3.2 Қолтаңбаны тексеру

```
signedBytes = сұраныс денесінің шикі мәтіні (raw body, өзгертілмеген)
signature   = "v1=" + HMAC_SHA256(secret, timestamp + "." + signedBytes).hex()
```

`alemiApi.service.ts:178-180`. Уақыт терезесі — **300 секунд**
(`ALEMI_SIGNATURE_WINDOW_SECONDS`, 9-жол): бот осы шектеуді есептеп отырады, сайт да
`abs(now - timestamp) > 300` болса 401 қайтаруы керек (replay-ден қорғау).
`timestamp` — **секунд**, миллисекунд емес.

PHP-де тексеру:

```php
$raw       = file_get_contents('php://input');   // JSON-ды қайта құруға БОЛМАЙДЫ
$ts        = $_SERVER['HTTP_X_COMMAND_TIMESTAMP'] ?? '';
$given     = $_SERVER['HTTP_X_COMMAND_SIGNATURE'] ?? '';
$instance  = $_SERVER['HTTP_X_PLATFORM_INSTANCE'] ?? '';

if (abs(time() - (int)$ts) > 300) {
    http_response_code(401);
    exit(json_encode(['ok' => false, 'error' => 'SIGNATURE_EXPIRED']));
}

$secret   = lookup_secret_for_instance($instance);   // сайттың өз қорынан
$expected = 'v1=' . hash_hmac('sha256', $ts . '.' . $raw, $secret);

if (!hash_equals($expected, $given)) {
    http_response_code(401);
    exit(json_encode(['ok' => false, 'error' => 'INTEGRATION_SIGNATURE_INVALID']));
}
```

Ең жиі кездесетін қате: денені `json_decode` → `json_encode` арқылы қайта құрып қолтаңба
есептеу. Бос орын мен өріс тәртібі өзгереді де, қолтаңба ешқашан сәйкеспейді. **Тек шикі
байттарды** қолданыңыз.

`X-Command-Id` идемпотенттік кілт: бот қайта жіберуі мүмкін, сайт бір `command_id`-ді екі
рет орындамауы керек.

### 3.3 Жауап конверті

Бот жауапты үш қабатқа дейін ашады (`unwrapAlemiResponse`, 228-243 жол): `result` бар
болса — ішіне кіреді, жоқ болса `data`-ға. Сондықтан бұл үш форма да жарайды:

```json
{ "items": [...] }
{ "result": { "items": [...] } }
{ "ok": true, "data": { "items": [...] } }
```

**Қате туралы ереже** (`assertAlemiResponse`, 245-260 жол): HTTP статусы 2xx болса да,
денеде `ok:false` немесе `success:false` болса, бот оны `ALEMI_COMMAND_REJECTED` деп
қабылдайды. Қате кодын `error.code` / `error_code` / `code` өрісінен оқиды.

Timeout: командалар бойынша 8-10 секунд, файл жүктеуде 15 секунд. Сайт бұдан ұзақ
ойланбауы керек — бот кэшке немесе backup-қа түсіп кетеді.

### 3.4 Командалар

#### `runtime.status.get` — ас үй/жеткізу/төлем статусы

Сұраныс: `data: {}`

Күтілетін жауап (`normalizeRuntimeStatus`, `dle.service.ts:208-261`). Барлық өріс
міндетті емес, бірақ жоқ болса әдепкі мән алынады (жақшада):

```json
{
  "accepting_orders": true,             // (true)
  "within_work_hours": true,            // (true)
  "closed_reason": "",                  // жабық болса себебі
  "fulfillment": [
    { "type": "delivery", "enabled": true },
    { "type": "pickup", "enabled": true }
  ],
  "wait_time_minutes": 35,
  "reset_at": "2026-08-14T18:30:00.000Z",
  "workload_emergency": false,
  "shift_notes": [
    { "id": "019fd154-...", "text": "Кола закончилась", "expires_at": "2026-08-14T20:00:00.000Z" }
  ],
  "payment_details": [
    { "label": "Kaspi", "value": "+77001234567" }
  ],
  "source": "dle_spa_settings"
}
```

Канондық Platform SPA өрістері жоғарыда көрсетілген. Балама legacy атаулары да оқылады:
`wait_time_minutes` орнына `wait_time`, `wait_minutes`,
`current_wait_minutes`, `current_wait_time`; `delivery` орнына `delivery_enabled`;
`is_emergency` орнына `emergency`. `kitchen_status` ішінде де, түбірде де жарайды.
`shift_notes` толық ағымдағы snapshot болып саналады: бот Redis жадын онымен
салыстырып, өткізіп алған webhook-тардан кейін қалпына келтіреді.

`payment_details` элементінде `label` (немесе `name`) және `value` (немесе `number`,
`link`) екеуі де болуы шарт — біреуі бос болса элемент түсіп қалады
(`normalizePaymentDetails`, `dle.service.ts:188-197`).

Бот бұл жауапты **5 секунд** кэштейді, backup 600 секунд.

#### `catalog.context.get` — меню

Сұраныс: `data: { "locale": "kk" | "ru" }`

Күтілетін жауап (`getMenuContext` + `normalizeMenuItem`, `dle.service.ts:579-619`):

```json
{
  "count": 12,
  "categories": [
    { "id": "019fd154-...", "name": "Суши", "sort_order": 0 }
  ],
  "items": [
    {
      "id": "019fd154-...",             // канондық UUID string
      "category_id": "019fd155-...",    // канондық UUID string
      "category_name": "Суши",
      "name": "Футомаки",
      "description": "...",
      "composition": "күріш, лосось, авокадо",
      "price": 2900,                    // МІНДЕТТІ, теңгемен
      "promo_price": 2400,              // жеңілдік жоқ болса 0
      "label": "хит"
    }
  ]
}
```

`name` (немесе `title`) бос болса элемент сүзіліп кетеді. `id`/`price` жоқ болса бот
менюді атымен ғана біледі — баға айта алмайды және тауарды тапсырысқа қоса алмайды.

`id` және `category_id` UUID ретінде string болып сақталады; оларды санға айналдыруға
болмайды. Platform SPA `price_amount_minor` / `compare_at_price_amount_minor` және
үйлесімді `price` / `promo_price` өрістерін нақты ағымдағы бағамен қайтарады.

Кэш: 300 секунд, backup 86400 секунд (`menu_context:<instance>:<lang>`).

#### `order.context.get` — клиенттің тапсырыстары

Сұраныс: `data: { "phone_e164": "+77001234567", "limit": 5 }`

> **`order_id` жіберілмейді.** hub бұл өрісті қабылдамайды: ол болса бүкіл команда
> `400 INTEGRATION_COMMAND_INVALID` болып қайтады (2026-08-11 тірі hub-та тексерілді).
> Клиент нақты нөмірді айтса (`«№13 қайда?»`), бот жауаптағы `recent_orders` /
> `active_orders` ішінен өзі тауып алады (`normalizeOrderContextPayload`).
> Телефон **міндетті** — онсыз команда жіберілмейді.

Телефон форматы — әрқашан `+7XXXXXXXXXX` (`e164Kazakhstan`, `alemiApi.service.ts:288-294`).

Тапсырыстарды бот бірнеше өрістен іздейді (`normalizeOrderContextPayload`,
`dle.service.ts:420-462`) — қайсысын толтырсаң да жарайды:

| Өріс | Мағынасы |
|---|---|
| `order` немесе `active_order` | бір тапсырыс, объект |
| `active_orders[]` | аяқталмаған тапсырыстар |
| `recent_orders[]` немесе `orders[]` | тарих |

Бәрі түбірде де, `context` / `order_context` ішінде де болуы мүмкін.

Тапсырыс объектісінің формасы (`normalizeOrderPayload`, `dle.service.ts:391-411`):

```json
{
  "active_orders": [
    {
      "id": "5f2c...",                  // немесе order_id / uuid
      "display_number": "12",           // немесе order_number / number
      "phone": "+77001234567",
      "status": "cooking",
      "total_price": 8700,
      "address": "Абай 10, кв 5",
      "comment": "домофон істемейді",
      "is_pickup": false,
      "payment_status": "paid",
      "ai_comment": "",
      "created_at": "2026-08-11T09:00:00Z",
      "items": [
        { "id": 4213, "name": "Футомаки", "qty": 2, "price": 2900, "total": 5800, "comment": "" }
      ]
    }
  ]
}
```

Балама атаулар: `status` ← `order_status` / `workflow_status` / `state`;
`total_price` ← `total`; `items[].qty` ← `count` / `quantity`; `items[].name` ←
`title` / `product_name` / `product.name`. `items` JSON-жол ретінде де қабылданады.
`name` өрісі `{ "ru": "...", "kk": "..." }` түрінде де болуы мүмкін.

**`id` бос болса тапсырыс мүлдем түсіп қалады** — бұл ең жиі кездесетін қате.

`status` мәні мына тізімде болса, тапсырыс «аяқталған» деп саналады және белсенді
тапсырыс ретінде алынбайды (`dle.service.ts:465`):

```
completed, done, finished, closed, cancelled, canceled, refunded
```

Қалған кез келген мән (`new`, `accepted`, `cooking`, `delivering`, …) — белсенді.

#### `order.status.get` — статусты жылдам тексеру

Сұраныс: `data: { "phone_e164": "+7..." }` — мұнда да `order_id` жіберілмейді.
Жауабы: `{ "has_active_order": bool, "active_order_id": "...", "status": "..." }`
немесе `order.context.get`-пен бірдей толық форма.

#### `crm.lead.upsert`

```json
{ "phone_e164": "+7...", "interest": "...", "sales_stage": "...", "psycho_analysis": "..." }
```

Жауабы қолданылмайды — 2xx және `ok` жалған болмауы жетеді.

#### `crm.today.get`

Сұраныс: `data: { "date": "2026-08-11" }`. Жауабы — лидтер тізімі.

#### `analytics.daily.upsert`

```json
{
  "report_date": "2026-08-11",
  "total_chats": 42, "total_complaints": 1, "total_canceled": 2,
  "conversion_rate": 0.31,
  "popular_items": "...", "critical_alert": "", "ai_daily_advice": "..."
}
```

#### `customer.access_link.issue` — клиентке қорғалған сілтеме

Сұраныс: `data: { "phone_e164": "+7...", "locale": "kk" }`

**Hub міндеті (2026-08-14):** команда келген сәтте `phone_e164` бойынша клиент
жазбасын upsert жасауы керек — боттан сөйлескен клиенттердің нөмірі hub базасында
бос тұрды. Қосымша сақтық ретінде бот сілтеме берген сайын `crm.lead.upsert`
командасын да жібереді.

Жауап — жол немесе объект (`alemiApi.service.ts:368-384`):

```json
{ "url": "https://prestige.bekaba.com/?phone=77001234567&hash=baa4a6dc41085296b0b" }
```

`url`, `access_url`, `link` — үшеуінің қайсысы болса да оқылады. Бот міндетті түрде
клиенттің `phone_e164` нөмірін командада жібереді, ал Platform SPA қысқа
`phone/hash` URL қайтарады: нөмір + орташа ұзындықтағы құпия hash (22-26 таңба
жеткілікті — тым ұзын крипто-токен қажет емес, өйткені hash нөмірмен бірге
тексеріледі). Сілтеме бір реттік емес: оны қайта ашуға болады, ал сәтті кіруден
кейін клиент 30 күндік қорғалған cookie-сессия алады. Токеннің бір тапсырыс
берген соң «өліп» қалуы қате болып саналады — бот мұндайды бұзылған деп белгілеп,
жаңа сілтеме береді.

### 3.5 Файл endpoint-тері

Бұл екеуінің қолтаңбасы **денеден емес, канондық жолдан** есептеледі — өйткені біреуі
multipart.

**Чек суреті:** `POST /v1/integrations/bot/order-documents`, `multipart/form-data`,
`file` өрісі. Қосымша тақырыптар: `X-Order-Id`, `X-Source-Message-Id`,
`X-Document-Kind` (`receipt` | `other`), `X-Document-Mime-Type`, `X-Content-SHA256`.

Канондық жол (`\n` арқылы қосылады, `alemiApi.service.ts:411-420`):

```
order-document-upload-v1
<command_id>
<instance>
<order_id>
<source_message_id>
<document_kind>
<mime_type>
<file_sha256_hex>
```

**Принтер нәтижесі:** `POST /v1/integrations/bot/print-results`, JSON дене
`{print_job_id, attempt_number, status, external_reference, error_code, error_message}`,
`status` тек `completed` немесе `failed`. Канондық жол (458-468 жол):

```
print-result-v1
<command_id>
<instance>
<print_job_id>
<attempt_number>
<status>
<external_reference>
<error_code>
<error_message>
```

Бос өрістер бос жол ретінде қалады (жол саны әрқашан бірдей).

---

## 4. 2-бағыт: сайт → бот (оқиға webhook)

```
POST https://openbot.bekaba.com/kanban-webhook?token=<Secret Key>
Content-Type: application/json
```

Аутентификация — `?token=` немесе `X-Tenant-Key` / `X-Instance-Key` /
`X-Restaurant-Key` тақырыбы, немесе денедегі `tenant_secret`
(`tenantAuth.service.ts:18-37`). Мәні — 2-бөлімдегі сол Secret Key.

Денеде кілт **`token` деген атпен қабылданбайды** — денеде тек `tenant_secret`,
`instance_secret`, `restaurant_secret` оқылады. `{"token": "..."}` жіберілсе жауап
`403 INVALID_TENANT_SECRET` болады, яғни кілт қате болғандағы жауаппен бірдей.
Айырып тану үшін бот мұндай жағдайда журналға `reason=credential_in_body` және
табылған өріс атауын жазады (кілттің өзін ешқашан жазбайды) — журналда осы жол
болса, кілтті сұрау жолына (`?token=`) немесе `X-Tenant-Key` тақырыбына көшіру
керек.

Дене:

```json
{
  "instance": "prestige",
  "event_type": "order.created",
  "event_id": "evt_...",
  "order": {
    "id": "5f2c...",
    "phone": "+77001234567",
    "status": "new",
    "total_price": 8700,
    "address": "Абай 10",
    "comment": "",
    "is_pickup": false,
    "delivery_amount_minor": 500,
    "items": [{ "name": "Футомаки", "qty": 2, "price": 2900 }]
  },
  "wait_time": 35,
  "lang": "kk"
}
```

`instance` — **міндетті және түбірде** болуы керек, әйтпесе `400 MISSING_INSTANCE`
(`dleWebhook.route.ts:273-282`). Қалған өрістерді бот түбірден де, `payload`/`data`
ішінен де, `order` ішінен де тауып алады (`normalizeDlePayload`, 104-186 жол) — қай
қабатта жіберсең де жұмыс істейді.

### Қолдау бар оқиғалар

| `event_type` | Ішкі әрекет | Бот не жасайды |
|---|---|---|
| `order.created` | `new_order` | клиентке тапсырыс қабылданғанын және күту уақытын жазады |
| `order.status_changed` | `status_changed` | жаңа статусты хабарлайды |
| `order.rejected` | `order_rejected` | себебін айтып бас тартуды хабарлайды |
| `shift_note.created` | `shift_note_created` | ауысым ескертпесін AI контекстіне қосады |
| `shift_note.deleted` | `shift_note_deleted` | ескертпені өшіреді |
| `shift_note.expired` | `shift_note_deleted` | мерзімі біткен ескертпені өшіреді |

`request_payment` — төлем сұрау, `complaint`, `developer_alert`,
`update_kitchen_status`, `get_kitchen_status` да қабылданады
(`src/controllers/kanban.ts:510-662`). Ескі атаулар (`create_order`, `update_status`,
`cancel_order`, …) alias арқылы жұмыс істей береді (`normalizeAction`, 45-67 жол).
`external-document*` оқиғалары әдейі елең етілмейді, `{ok:true, ignored:true}` қайтады.

### Жауаптар

| Код | Мағынасы |
|---|---|
| 200 | қабылданды |
| 400 | `MISSING_INSTANCE` / `BAD_INSTANCE` |
| 401 | құпия жоқ немесе tenant табылмады |
| 403 | `INVALID_TENANT_SECRET` — құпия сәйкеспеді |
| 409 | `ALEMI_INSTANCE_AMBIGUOUS` — бір instance екі tenant-қа сәйкес келді |
| 500 | `TENANT_SECRET_NOT_CONFIGURED` — бот жағында құпия орнатылмаған |

Бот `event_id` бойынша қайталауды өзі сүзеді, сондықтан сайт сәтсіз жіберуді қайталай
алады — бірдей `event_id` екі рет клиентке жазбайды. Талап: `event_id` 24 сағат ішінде
қайталанбауы керек (`kanban_event_lock:<instance>:<event_id>`, TTL 24 сағат) және ол
tenant-ішілік — екі ресторанның бірдей `event_id` беруі бір-біріне әсер етпейді.
Өңдеу барысында қате шықса (500), бот құлыпты босатады, сондықтан сайт **сол**
`event_id`-мен қайталай алады. `event_id` жоқ сигнал `order_id + action + status`
бойынша сүзіледі.

---

## 5. Іске қосу тәртібі

1. Сайт жағында Secret Key генерациялау (`openssl rand -hex 32`), ресторанға байлау.
2. `instance` жолын келісу — үш жерде бірдей (2-бөлімді қараңыз).
3. Кілтті ботқа беру: Dokploy env-індегі `ALEMI_TENANT_SECRETS_JSON`
   (`{"prestige":{"secret":"..."}}`) немесе WhatsPro tenant-інің
   `POST /api/wa/tenants/:id/alemi-secret` жазба-ғана endpoint-і арқылы.
   **Кілтті репоға, чатқа, логқа жазуға болмайды.**
4. Сайтта `/v1/integrations/bot/commands` endpoint-ін көтеру, қолтаңбаны 3.2 бойынша
   тексеру, 8 команданы 3.4 бойынша жауап беру.
5. `catalog.context.get`-те UUID `id` мен нақты `price` келетінін тексеру.
6. Сайтта оқиға жіберуді қосу: `order.created`, `order.status_changed`,
   `order.rejected`.
7. Тексеру: тапсырыс құру → клиентке WhatsApp хабары келді ме; ботқа «меню» деп жазу →
   нақты баға айтты ма.

### Жиі жіберілетін қателер

- Қолтаңбаны қайта құрылған JSON-нан есептеу (шикі байт керек).
- `timestamp`-ты миллисекундпен жіберу (секунд керек).
- `instance` тек `order` ішінде жіберіліп, түбірде жоқ болуы → `400`.
- Каталогта `price`/`id` жоқ → бот баға айта алмайды.
- Хаб жағында instance ID басқаша → құпия дұрыс болса да `401`.
- 2xx статуспен `{"ok": false}` қайтару → бот бұны қате деп санайды.
