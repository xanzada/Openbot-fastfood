# AI Thinking Model

> **Нұсқа:** 1.0
> **Типі:** Architecture — AI cognitive pipeline
> **Автор:** BekzatAI Product
> **Статус:** Ratified

---

## Preamble

Бұл құжат — Ресторан Миының **ойлау процесі**.

Клиент хабарлама жіберген сәттен бастап, AI жауап бергенге дейін, мидың ішінде не болып жататынын сипаттайды.

Бұл — тізбектелген қадамдар емес. Бұл — **қабаттар**. Әрбір қабат алдыңғысына сүйенеді, бірақ өз шешімін өзі қабылдайды.

Код жоқ. Архитектура жоқ. Тек ойлау моделі.

---

## Overview: The 15-Stage Thinking Model

```
  1. SIGNAL DETECTION
     ↓
  2. IDENTITY RESOLUTION
     ↓
  3. INTENT UNDERSTANDING
     ↓
  4. RESTAURANT CONTEXT
     ↓
  5. CONVERSATION MEMORY
     ↓
  6. BUSINESS STATE
     ↓
  7. BUSINESS RULES
     ↓
  8. CAPABILITY ASSESSMENT
     ↓
  9. GOAL ALIGNMENT
     ↓
 10. RESPONSE STRATEGY
     ↓
 11. KNOWLEDGE RETRIEVAL
     ↓
 12. THOUGHT FORMATION
     ↓
 13. RESPONSE GENERATION
     ↓
 14. OUTPUT FILTERING
     ↓
 15. DELIVERY
```

---

## Stage 1: Signal Detection

### What happens
Хабарлама келді. Бұл кімнен? Бұл не?

### Questions answered
- Бұл WhatsApp хабарламасы ма?
- Бұл fromMe (оператор) ма, әлде клиент пе?
- Бұл бос хабарлама ма? (empty, whitespace)
- Бұл дубликат па? (бірдей ID бұрын өңделген бе?)

### Why this stage exists
Кейбір хабарламаларды өңдеудің қажеті жоқ. Оператордың өзі жазған хабарламасы — LLM-ге жіберілмейді. Дубликат — қайта өңделмейді. Бос хабарлама — еленбейді.

### Decision gate
- Иә, клиент → келесі қадам
- Жоқ, fromMe → mute 5 min, операторға көрсету
- Жоқ, дубликат → discard

---

## Stage 2: Identity Resolution

### What happens
Клиентті тану. Бұл кім?

### Questions answered
- Бұл клиенттің телефон нөмірі қандай?
- Біз оны бұрын көргенбіз бе?
- Оның аты кім?
- Оның бізбен тарихы қандай?
- Бұл — қайта келуші ме, жаңа ма?

### Knowledge sources
- Redis: `history:{instance}:{phone}`
- NocoDB: shpor, config
- DLE: клиент базасы (егер интеграцияланған болса)

### Why this stage exists
Ресторан Миы клиентті танымаса, оған жеке көмек көрсете алмайды. "Қайта келгеніңізге қуаныштымын" деп айту үшін, оны тану керек.

### Business impact
Қайта келуші клиентті тану — лоялдылықты арттырады. Жаңа клиентті дұрыс қарсы алу — конверсияны арттырады.

---

## Stage 3: Intent Understanding

### What happens
Клиент не қалайды?

### Questions answered
- Клиенттің негізгі мақсаты не?
- Ол тамақ алғысы келе ме?
- Ол ақпарат сұрап тұр ма?
- Ол проблеманы шешкісі келе ме?
- Ол оператормен сөйлескісі келе ме?

### Intent classifications
```
menu         → мәзір, тағам, категория туралы
order        → заказ беру, қайталау
info         → жұмыс уақыты, мекенжай, телефон
payment      → төлем, реквизиттер
complaint    → шағым, проблема
support      → оператор керек
greeting     → амандасу
farewell     → қоштасу
unknown      → түсініксіз
```

### Why this stage exists
Intent-ті білмей тұрып, дұрыс жауап беру мүмкін емес. "Мәзір жіберіңізші" мен "Заказ бергім келіп еді" — екеуіне жауап әртүрлі.

### Business impact
Intent дұрыс анықталса — конверсия. Қате анықталса — клиент кетеді.

---

## Stage 4: Restaurant Context

### What happens
Ресторанның қазіргі жағдайы қандай?

### Questions answered
- Ресторан қазір ашық па?
- Заказ қабылдап жатыр ма?
- Күту уақыты қанша?
- Қандай тағамдар жоқ?
- Бүгін қандай акциялар бар?
- Қандай ерекше жағдайлар бар? (авария, тоқтау)

### Knowledge sources
- Redis: `{instance}:config` (runtime status)
- NocoDB: config (work_hours, delivery_zone)
- Redis: `{instance}:shift_notes` (оператор жазбасы)

### Why this stage exists
Ресторан жабық болса, AI "мәзір жіберейін" деп жауап берсе — клиент ренжиді. Контексті білмей тұрып, жауап беру — ең үлкен қате.

### Business impact
Контексті білу — клиенттің уақытын үнемдейді. "Жабықпыз, ертең келіңіз" — жақсы тәжірибе.

---

## Stage 5: Conversation Memory

### What happens
Бұл әңгімеде бұрын не болды?

### Questions answered
- Осы сессияда бұрын не айтылды?
- Клиент бұрын қандай сұрақ қойды?
- Біз оған не жауап бердік?
- Клиенттің көңіл-күйі қандай? (ашулы/риза/асығыс)

### Knowledge sources
- Redis: `history:{instance}:{phone}` (соңғы 100 хабарлама)

### Why this stage exists
Клиент "сол тағам туралы айтып едім" десе — AI не туралы айтылғанын білуі керек. Контекстсіз AI — әр жолы нөлден бастайды.

### Business impact
Контексті сақтау — клиентке "мені естиді" деген сезім береді. Бұл — сенім.

---

## Stage 6: Business State

### What happens
Бизнес қазір қандай жағдайда?

### Questions answered
- Бұл клиент қай планда? (Starter/Business/Enterprise)
- Лимит таусылды ма?
- Бұл request-тің бағасы қандай?
- Бұл клиент rate limit-те ме?

### Knowledge sources
- Redis: `billing:usage:...`, `ratelimit:...`

### Why this stage exists
Егер клиент лимиттен асып кетсе, AI "Кешіріңіз, бот қазір жұмыс істемейді" деп айтуы керек. Егер бизнес план 3 skill ғана рұқсат етсе, AI 4-ші skill-ді қолданбауы керек.

### Business impact
Бизнес штатын білмеу — revenue loss. Лимитті бақыламау — шығын.

---

## Stage 7: Business Rules

### What happens
Бизнес ережелері не дейді?

### Questions answered
- Бұл жағдайда бизнес ережелері қандай шешімді талап етеді?
- Қандай валидация ережелері бар?
- Қандай шектеулер бар?

### Examples
- "6 хабарламадан кейін spam mute"
- "fromMe болса — LLM-ге жіберме"
- "Жабық уақытта — runtime unavailable reply"
- "2 сөйлемнен аспау"

### Why this stage exists
Бизнес ережелері — кодта. Олар LLM-ге тәуелді емес. Олар бұзылмауы керек. Бұл қабат ережелердің сақталуын қамтамасыз етеді.

### Business impact
Ережелерді сақтамау — қауіпсіздік, клиенттік тәжірибе, заңдылық проблемалары.

---

## Stage 8: Capability Assessment

### What happens
Мен бұл сұрақты шеше аламын ба?

### Questions answered
- Бұл сұраққа жауап беру үшін қандай skill керек?
- Сол skill қолжетімді ме?
- Бұл сұрақты AI шешуі керек пе, әлде операторға жіберу керек пе?
- Менде жеткілікті ақпарат бар ма?

### Skill mapping
```
menu intent       → searchMenu, sendMenuLink
payment intent    → getPaymentDetails, registerPaymentReceipt
complaint intent  → escalateToAdmin (эскалация)
support intent    → escalateToAdmin
info intent       → searchMenu, getPaymentDetails
unknown intent    → escalateToAdmin
```

### Why this stage exists
AI өз шектеулерін білуі керек. "Мен білмеймін" деп айту — "мен істей аламын" деп қателескеннен жақсы.

### Business impact
Capability-ді дұрыс бағаламау — клиенттің проблемасын нашарлатады.

---

## Stage 9: Goal Alignment

### What happens
Бұл жағдайда неге жету керек?

### Questions answered
- Бұл жағдайда ең басты мақсат не?
  - Клиенттің проблемасын шешу?
  - Клиентті сайтқа бағыттау?
  - Клиентті ұстап қалу?
  - Операторға эскалация?

### Priority hierarchy
```
1. Customer satisfaction (клиент риза болуы керек)
2. Business conversion (сату болуы керек)
3. Operator workload reduction (оператор араласпауы керек)
4. Brand protection (ресторанның атына дақ түспеуі керек)
```

### Why this stage exists
Әрбір жауаптың мақсаты болуы керек. "Неге біз бұлай жауап беріп жатырмыз?" — осы қабат жауап береді.

### Business impact
Мақсатсыз жауап — бос шу. Мақсатты жауап — бизнес нәтиже.

---

## Stage 10: Response Strategy

### What happens
Қалай жауап беру керек?

### Questions answered
- Қандай тон?
- Қанша ұзақ?
- Сілтеме керек пе?
- Skill шақыру керек пе?
- Оператор керек пе?
- Клиенттің көңіл-күйіне қарай тон қандай болуы керек?

### Strategy types
```
direct       → нақты жауап (уақыт, мекенжай, баға)
explanatory  → түсіндіру (тағам, салыстыру)
redirect     → сайтқа бағыттау (мәзір, заказ)
soothe       → тыныштандыру (комплайнт, күту)
escalate     → операторға жіберу (күрделі мәселе)
farewell     → қоштасу
```

### Why this stage exists
Стратегиясыз жауап — ретсіз ой. "Қалай жауап беру керек?" деген сұраққа жауап — осы қабат.

### Business impact
Стратегия дұрыс болса — клиент риза. Қате стратегия — клиент кетеді.

---

## Stage 11: Knowledge Retrieval

### What happens
Жауап беру үшін қандай білім керек?

### Questions answered
- Мәзірден бірдеңе іздеу керек пе?
- Ресторан конфигурациясы керек пе?
- Shpor-дан бірдеңе керек пе?
- DLE-ден бірдеңе керек пе?
- Бұл ақпарат cache-те бар ма?

### Knowledge sources
- Redis cache (жылдам)
- NocoDB (config, shpor)
- DLE (мәзір, тағамдар) — Skills арқылы

### Why this stage exists
Білімсіз жауап — ойдан шығарылған жауап. Білімді алдын ала жинау — LLM-нің ойдан шығаруына жол бермейді.

### Business impact
Білімді дұрыс жинамау — hallucination. Hallucination — сенім жоғалту. Сенім жоғалту — бизнес жоғалту.

---

## Stage 12: Thought Formation

### What happens
Не айту керек?

### Questions answered
- Жауаптың негізгі идеясы қандай?
- Негізгі фактілер қандай?
- Нені айту керек?
- Нені айтпау керек?

### Thought structure
```
Core message: "Мына тағам — біздің ең танымал тағам"
Supporting facts: "Құрамы: 200г котлет, 350г салмақ"
Call to action: "Толық ақпарат сайтта"
Boundaries: "Бағасын айтпа, тек ұсын"
```

### Why this stage exists
LLM-ге "не айту керек" деген нақты нұсқау беру — оның ойдан шығаруын азайтады. Бұл қабат LLM-ге дайын "ой" береді.

### Business impact
Thought formation — LLM-нің еркіндігін шектейді, бірақ дәлдікті арттырады.

---

## Stage 13: Response Generation

### What happens
LLM жауапты генерациялайды.

### Input to LLM
- System instructions (Personality + Rules)
- Dynamic facts (Restaurant context + knowledge)
- Conversation history (соңғы 10 хабарлама)
- User message
- Thought (не айту керек)

### LLM parameters
- Temperature: 0.7
- Max tokens: 500
- Max steps: 6 (VoltAgent)

### Why this stage exists
LLM — тілдік қабат. Ол ойды сөзге айналдырады. Бірақ ол "не ойлау керек" дегенді шешпейді — оны алдыңғы қабаттар шешеді.

### Business impact
LLM дұрыс генерациялауы үшін, оған дұрыс контекст пен нұсқау беру керек. Барлық алдыңғы қабаттар — осы үшін.

---

## Stage 14: Output Filtering

### What happens
LLM жауабы дұрыс па?

### Questions answered
- 2 сөйлемнен аспады ма?
- Таза қазақ/орыс па? (араласпаған ба?)
- Сілтеме дұрыс жіберілді ме? (dedup)
- Wait-time туралы айтылды ма? (тек runtime рұқсат етсе)
- Заказ статусы туралы айтылды ма? (тек рұқсат етсе)
- Жоқ тағам туралы айтылды ма?
- Prompt injection бар ма?

### Filtering layers
```
finalValidator.ts:
  1. Sentence count (max 2)
  2. Language purity (қазақ немесе орыс)
  3. Wait-time stripping (егер рұқсат етілмесе)
  4. Order status gating (егер рұқсат етілмесе)
  5. Menu topic isolation (тек мәзір сұрағына)
  6. Magic link dedup (бір рет қана)
  7. Delivery area check (егер тексерілмесе)
```

### Why this stage exists
LLM — сенімсіз. Ол 2 сөйлемнен асуы мүмкін. Ол тілді араластыруы мүмкін. Ол жоқ тағамды айтуы мүмкін. Бұл қабат — LLM-нің қателерін түзетеді.

### Business impact
Output filtering — соңғы қорғаныс. Бұл қабатсыз, әрбір LLM жауабы — тәуекел.

---

## Stage 15: Delivery

### What happens
Жауапты клиентке жіберу.

### Questions answered
- Бұл жауапты қалай жіберу керек? (text/image)
- Бұл жауапты қашан жіберу керек? (қазір / кейін)
- Бұл жауапты сақтау керек пе? (history)
- Бұл әңгімені шпорға сақтау керек пе?

### Delivery actions
- WhatsApp арқылы жіберу (WhatsPro)
- History-ге сақтау (Redis)
- Shpor evaluation (GPT-4o-mini: "бұл жаңа білім бе?")
- Billing metering (Redis INCR)
- Операторға хабарлау (егер эскалация болса)

### Why this stage exists
Жауап генерацияланды — енді оны жеткізу керек. Жеткізу кезінде де қателер болуы мүмкін: WhatsApp API құласа, жауап жоғалады.

### Business impact
Жеткізу — соңғы қадам. Егер бұл қадам сәтсіз болса, алдыңғы 14 қадамның ешқандай мағынасы жоқ.

---

## Thinking Pipeline Diagram

```
SIGNAL DETECTION ───────────────────┐
    │                              │ fromMe → operator mute
    │ клиент                       │ дубликат → discard
    ▼                              │
IDENTITY RESOLUTION                │
    │                              │ жаңа клиент / қайта келуші
    ▼                              │
INTENT UNDERSTANDING               │
    │                              │ menu / order / info / payment
    ▼                              │ / complaint / support / greeting
RESTAURANT CONTEXT                 │
    │                              │ ашық/жабық, wait_time
    ▼                              │
CONVERSATION MEMORY                │
    │                              │ бұрынғы хабарламалар
    ▼                              │
BUSINESS STATE                     │
    │                              │ план, лимит, rate limit
    ▼                              │
BUSINESS RULES                     │
    │                              │ spam? mute? fromMe? validation?
    ▼                              │
CAPABILITY ASSESSMENT              │
    │                              │ skill бар ма? шеше аламын ба?
    ▼                              │
GOAL ALIGNMENT                     │
    │                              │ клиент риза? сату? эскалация?
    ▼                              │
RESPONSE STRATEGY                  │
    │                              │ direct / explain / redirect
    ▼                              │ / soothe / escalate / farewell
KNOWLEDGE RETRIEVAL ───────────────┤
    │                              │ Redis cache / NocoDB / DLE
    ▼                              │
THOUGHT FORMATION                  │
    │                              │ "не айту керек" (LLM-ге)
    ▼                              │
RESPONSE GENERATION ───────────────┤ LLM (instructions + facts + thought)
    │                              │
    ▼                              │
OUTPUT FILTERING                   │
    │                              │ 2 sentences? purity? injection?
    ▼                              │
DELIVERY ──────────────────────────┤ WhatsApp + history + billing
    │                              │
    ▼                              │
DONE
```

---

## Business-Critical Rules

### Each stage can short-circuit
Кез келген қабат "бұл жерде тоқта" деп шеше алады:

```
Stage 3 (Intent): unknown → "Мен сізді түсінбедім" (ешқайда LLM-ге жібермей)

Stage 4 (Context): closed → "Кешіріңіз, біз жабықпыз"

Stage 6 (Business): suspended → "Бот қазір жұмыс істемейді"

Stage 7 (Rules): fromMe → mute, операторға көрсету (LLM-ге жібермеу)

Stage 8 (Capability): cannot → "Операторға қосамын"

Stage 14 (Filter): failed → "Қайта жазу керек" немесе default жауап
```

### Short-circuit мақсаты
LLM-ге әрбір хабарламаны жіберудің қажеті жоқ. Кейбір хабарламалар:
- LLM-ге жетпей тұрып шешілуі керек (runtime, fromMe)
- Кодпен шешілуі керек (rate limit, spam)
- Операторға жіберілуі керек (complaint, unknown)

### LLM — ең қымбат қадам
Әрбір LLM шақыруы — $0.002. Егер 14 қабаттың біреуі LLM шақырусыз-ақ жауап берсе — бұл ақшаны үнемдейді.

---

## Thinking Model vs Implementation

Бұл құжат — **ойлау моделі**, іске асыру емес.

| Ойлау моделі | Іске асыру (code) |
|-------------|-------------------|
| Signal Detection | `webhook handler` — fromMe check, duplicate check |
| Identity Resolution | `redis.service` — history бар ма? |
| Intent Understanding | `code` — intent classification |
| Restaurant Context | `preloadContext.ts` — runtime status |
| Conversation Memory | `redis.service` — history |
| Business State | `metering.ts`, `inboundGuard.service.ts` |
| Business Rules | `finalValidator.ts`, `inboundGuard.service.ts` |
| Capability Assessment | `skills/index.ts` — availability |
| Goal Alignment | `agent.ts` — business logic |
| Response Strategy | `instructions.ts` — behavior |
| Knowledge Retrieval | `skills/*`, `buildFactsPrompt.ts` |
| Thought Formation | `buildFactsPrompt.ts` — facts |
| Response Generation | `agent.ts` — VoltAgent + LLM |
| Output Filtering | `finalValidator.ts` |
| Delivery | `whatspro.client.ts` |

---

## Final Principle

Әрбір қабаттың өз жұмысы бар.
Әрбір қабат келесі қабатқа дайындық жасайды.
Ешбір қабат басқасының жұмысын істемейді.
Ешбір қабат өткізілмейді.

LLM — бір ғана қабат. Ең маңызды емес. Ең қымбат. Бірақ бір ғана.

---

_BekzatAI — Think like a restaurant, not like an LLM._
