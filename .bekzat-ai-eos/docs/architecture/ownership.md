# Ownership Boundaries

> **Нұсқа:** 1.0
> **Типі:** Immutable — архитектуралық шекара
> **Өзгерту:** Тек ADR + Chief Architect

---

## Preface

Бұл құжат әрбір субжүйенің меншік шекарасын анықтайды.

"SaaS платформасында меншік шекарасы неге маңызды?" деген сұраққа жауап — бір сөзбен: **масштабтау**.

Егер бір субжүйе басқасының міндетін өзіне алса:
- Код пен prompt араласса → LLM ауысқанда бәрі сынады
- Redis пен NocoDB араласса → кэш стратегиясы бұзылады
- AI мен Website араласса → ешқандай платформа масштабталмайды

Әрбір компонент өз жұмысын істеуі керек. Басқасының жұмысына араласпауы керек.

---

## 1. Website Ownership

### Owns
| Меншік | Сипаттамасы |
|--------|-------------|
| **Products** | Тағамдар, сусындар, категориялар |
| **Categories** | Мәзір құрылымы |
| **Product Options** | Қосымша ингредиенттер, өлшемдер |
| **Pricing** | Бағалар, валюта |
| **Cart** | Себет, өзгерту, жою |
| **Checkout** | Заказ беру процесі |
| **Payment Processing** | Төлем қабылдау, өңдеу |
| **Order Creation** | Заказды жүйеге енгізу |
| **Order Tracking** | Заказ статусын көрсету |
| **Delivery Calculations** | Жеткізу уақыты, аймағы |
| **Discounts & Promotions** | Жеңілдіктер, акциялар |
| **Bonuses & Loyalty** | Баллдар, лоялдылық |
| **Banners** | Сайттағы баннерлер |
| **Reviews & Ratings** | Пікірлер, бағалар |

### Does NOT Own
- Клиентпен сөйлесу
- Түсіндіру, ұсыну
- Клиенттің күмәнін шешу

### Неге?
Веб-сайт — **транзакциялық жүйе**. Оның міндеті — заказды дұрыс, жылдам, қауіпсіз өңдеу. Егер сайт AI-дің жұмысын істей бастаса, ол баяулайды, күрделенеді, және бұзылу қаупі артады.

---

## 2. AI (Digital Restaurant Manager) Ownership

### Owns
| Меншік | Сипаттамасы |
|--------|-------------|
| **Customer Communication** | Клиентпен әңгімелесу |
| **Intent Understanding** | Клиенттің не қажет екенін түсіну |
| **Context Management** | Әңгіме контекстін сақтау |
| **Explanations** | Тағамдарды түсіндіру |
| **Product Comparisons** | Тағамдарды салыстыру |
| **Recommendations** | Ұсыныстар беру |
| **Customer Guidance** | Веб-сайтқа бағыттау |
| **Question Answering** | Ресторан туралы сұрақтарға жауап |
| **Trust Building** | Сенім қалыптастыру |
| **Customer Education** | Мәзір, ингредиенттер туралы үйрету |
| **Escalation** | Операторға қосу қажеттігін анықтау |
| **Conversation Flow** | Әңгімені басқару |

### Does NOT Own
- Заказ қабылдау
- Төлем өңдеу
- Бағаларды өзгерту
- Мәзірді редакциялау
- Жеңілдіктер жасау

### Неге?
AI — **коммуникациялық қабат**. Ол адамдармен сөйлесу үшін жасалған. Транзакциялар — веб-сайттың міндеті. Егер AI транзакция жасай бастаса, ол ешқашан масштабталмайды, себебі әрбір жаңа ресторанға жаңа логика қосу керек болады.

---

## 3. LLM (Large Language Model) Ownership

### Owns
| Меншік | Сипаттамасы |
|--------|-------------|
| **Language Understanding** | Тілді түсіну |
| **Language Generation** | Тілді генерациялау |
| **Natural Conversation** | Табиғи сөйлесу |
| **Intent Recognition** | Ниетті анықтау (тек жоғары деңгейде) |
| **Summarization** | Қысқаша мазмұндау |
| **Sentiment Analysis** | Көңіл-күйді анықтау |

### Does NOT Own
| ЕШҚАШАН | Себебі |
|----------|--------|
| **Business Logic** | LLM ауысқанда бәрі сынады. GPT → Gemini → Claude → жаңа модель — әрқайсысы басқаша. |
| **Validation Rules** | "2 сөйлемнен аспау" — модельге сенуге болмайды, код тексеруі керек |
| **Pricing Rules** | Бағалар — бизнес дерегі, LLM оны өзгерте алмайды |
| **Permission Logic** | "Бұл клиент rate limit-ке ілікті ме?" — LLM шешпейді |
| **Workflow Logic** | "Алдымен config жүкте, сосын LLM-ге жібер" — код |
| **Data Access Rules** | "Бұл tenant басқа tenant-тың дерегін көре ала ма?" — код |
| **Calculation** | Ешқандай математика, ешқандай есептеу — LLM бұл үшін жасалмаған |

### Why LLM Must NEVER Own Business Logic

1. **Model меняется** — бүгін gemini, ертең gpt-5, бір жылдан кейін жаңа модель. Егер бизнес логика prompt-та болса, әрбір модель ауысқанда бәрін қайта жазу керек. Егер кодта болса — модель ауысқанда prompt қана өзгереді.

2. **LLM non-deterministic** — бірдей нұсқауға әр жолы әртүрлі жауап береді. Бизнес логика детерминирленген болуы керек. Код — детерминирленген. Prompt — емес.

3. **LLM injection** — егер бизнес логика prompt-та болса, prompt injection арқылы оны айналып өту оңай. Кодтағы логиканы injection арқылы айналып өту мүмкін емес.

4. **Testing** — кодты тестілеу оңай (Vitest, CI). Prompt-ты тестілеу қиын (тек manual). 10 түрлі модельде 10 түрлі prompt мінез-құлқы.

5. **Audit** — кодтың өзгеріс тарихы GitHub-та. Prompt-тың өзгеріс тарихы — ешкім білмейді. SaaS платформасында аудит — заңды талап.

---

## 4. Prompt Ownership

### Owns
| Меншік | Сипаттамасы |
|--------|-------------|
| **Personality** | AI-дің мінезі: достық, кәсіби, сабырлы |
| **Communication Style** | Сөйлеу стилі: қысқа, нақты, табиғи |
| **Behavior Guidelines** | Мінез-құлық ережелері: дауласпау, сенім қалыптастыру |
| **Brand Voice** | Бренд дауысы: BekzatAI, ресторан атынан |
| **Language Rules** | Тіл ережелері: тек қазақ немесе орыс |
| **Tone Rules** | Үн: сабырлы, достық, кәсіби |

### Does NOT Own
- Бизнес ережелері
- Валидация
- Деректерге рұқсат
- Жұмыс ағыны

### Неге?
Prompt — **мінез-құлық құжаты**. Ол AI-дің "кім екенін" анықтайды, "не істейтінін" емес. "Не істеу керек" — кодтың міндеті. Prompt пен кодты ажыратпасаңыз, екеуі де нашарлайды.

---

## 5. Code (Business Logic) Ownership

### Owns
| Меншік | Сипаттамасы |
|--------|-------------|
| **Business Rules** | Барлық бизнес ережелер |
| **Validation** | finalValidator: 2 сөйлем, тіл, сілтеме, wait-time |
| **Permissions** | Auth chain, tenant isolation |
| **Workflow** | Webhook flow: auth → guard → preload → LLM → validate → send |
| **Integrations** | Redis, NocoDB, DLE, WhatsApp байланысы |
| **Error Handling** | Қателерді ұстау, логтау, эскалация |
| **Rate Limiting** | 15/60/300 req/min |
| **Feature Flags** | isEnabled('new-validator', instance) |
| **Billing Metering** | Usage tracking, plan limits |
| **Orchestration** | Барлық компоненттерді басқару |

### Does NOT Own
- Тілді генерациялау (LLM)
- Мінез-құлық (prompt)
- Конфигурация (NocoDB)
- Runtime state (Redis)

### Неге?
Код — **детерминирленген қабат**. Ол әрқашан бірдей нәтиже береді. SaaS платформасында детерминизм — қауіпсіздік пен сенімділіктің негізі. Барлық "егер... онда..." ережелері кодта болуы керек, prompt-та емес.

---

## 6. Redis Ownership

### Owns
| Меншік | Сипаттамасы |
|--------|-------------|
| **Rate Limit State** | `ratelimit:{instance}:{phone}` — TTL 60s |
| **Spam State** | `spam:{instance}:{phone}` — TTL configurable |
| **Operator Mute** | `operator_mute:{instance}:{phone}` — TTL 300s |
| **Magic Links** | `magiclink:{instance}:{phone}` — TTL configurable |
| **Conversation Context** | `history:{instance}:{phone}` — List, LTRIM 100 |
| **Feature Flag Cache** | `flag:*` — глобалды және tenant override |
| **Billing Usage** | `billing:usage:{instance}:{month}` — INCR counter |
| **Temp State** | Барлық уақытша (temporary) деректер |

### Does NOT Own
- Тұрақты конфигурация (NocoDB)
- Бизнес деректер (DLE)
- Prompt нұсқалары (NocoDB / код)

### Неге?
Redis — **жылдам, уақытша, volatile**. Ол секундына миллиондаған операцияны өңдей алады. Бірақ Redis жоғалса — платформа жұмысын жалғастыра алуы керек. Сондықтан Redis-те тек cache және runtime state.

**Redis Rules:**
- Әрбір key-де TTL болуы керек (cache)
- Redis жоғалса — платформа әлі жұмыс істейді (тек баяу)
- "Бұл дерек мәңгі сақталуы керек" болса → NocoDB

---

## 7. NocoDB Ownership

### Owns
| Меншік | Сипаттамасы |
|--------|-------------|
| **Restaurant Config** | `{instance}:config` — жұмыс уақыты, мекенжай, телефон |
| **Shpor (FAQ)** | `{instance}:shpor` — жиі қойылатын сұрақтар |
| **Prompt Templates** | Prompt нұсқалары, tenant-level prompt_version |
| **Business Settings** | Жұмыс уақыты, жеткізу аймағы, т.б. |
| **Restaurant Profile** | Атауы, логотипі, мекенжайы |

### Does NOT Own
- Транзакциялық деректер (заказдар — DLE)
- Уақытша state (Redis)
- Runtime деректер (RAM)

### Неге?
NocoDB — **конфигурация қоймасы**. Баяу (REST API, ~100ms), бірақ сенімді. Мұнда тек конфигурация сақталады. Жылдам операциялар үшін Redis-ке кэштеледі.

**NocoDB Rules:**
- Әрбір query-де tenant filter міндетті: `WHERE (instance,eq,{instance})`
- Rate limit: 100 req/min — cache арқылы азайту керек
- Тек REST API арқылы қатынас

---

## 8. DLE (DataLife Engine) Ownership

### Owns
| Меншік | Сипаттамасы |
|--------|-------------|
| **Products** | Тағамдар, сусындар |
| **Categories** | Мәзір категориялары |
| **Orders** | Заказдар, заказ статусы |
| **Customers** | Клиенттер базасы |
| **Banners** | Сайт баннерлері |
| **Promotions** | Акциялар, жеңілдіктер |
| **Business Data** | Барлық бизнес деректер |

### Does NOT Own
- AI communication
- Prompt management
- Runtime state

### Неге?
DLE — **business data source of truth**. Бұл — ресторанның негізгі жүйесі. AI DLE-ден тек оқиды (read), жазбайды (write). Барлық бизнес деректер DLE-де, AI оны тек пайдаланады.

**DLE Rules:**
- AI DLE-ге ТІКЕЛЕЙ қатынаспайды
- API шлюз (api_bot.php) арқылы ғана
- Read-only (AI үшін)
- DLE өзгерсе, AI автоматты түрме бейімделеді

---

## 9. Skills (Tools) Ownership

### Owns
| Меншік | Сипаттамасы |
|--------|-------------|
| **Menu Search** | DLE-ден мәзір іздеу |
| **Payment Details** | Төлем реквизиттерін беру |
| **Payment Receipt** | Төлем чегін қабылдау |
| **CRM Update** | Клиент дерегін жаңарту |
| **Admin Escalation** | Операторға эскалация |
| **Menu Link** | Magic link жіберу |
| **Web Search** | Tavily арқылы веб іздеу |

### Does NOT Own
- LLM reasoning
- Conversation flow
- Business logic decisions

### Неге?
Skills — **атқарушы қабат**. Олар нақты әрекеттерді орындайды: Деректерді іздеу, жіберу, жаңарту. LLM оларды шақырады, бірақ олардың ішкі логикасын басқармайды.

---

## 10. Runtime Ownership

### Owns
| Меншік | Сипаттамасы |
|--------|-------------|
| **Current Request Context** | Келіп түскен хабарлама, клиент, tenant |
| **Precomputed State** | Runtime status (is_accepting, wait_time) |
| **Temporary Variables** | Сессия ішіндегі уақытша деректер |
| **Execution Flow** | Қазіргі қадам (LLM күтуде, skill шақырылуда, т.б.) |

### Does NOT Own
- Тұрақты сақтау (Redis, NocoDB)
- Бизнес ережелері

### Неге?
Runtime — **өткінші, әрбір request үшін жаңа**. Бір request ішінде тұрады, request біткен соң жойылады. Ол — "қазір не болып жатыр" деген сұраққа жауап.

---

## 11. Configuration Ownership

### Owns
| Меншік | Сипаттамасы |
|--------|-------------|
| **Environment Variables** | .env — секреттер, API ключтер |
| **Tenant Config** | NocoDB — 600+ ресторан конфигурациясы |
| **Feature Flags** | Redis + NocoDB — rollout state |
| **Plan Definitions** | Кодта — тарифтік жоспарлар |
| **Prompt Versions** | Кодта — v1, v2, v3, v4 |

### Does NOT Own
- Business logic decisions
- Runtime decisions

### Неге?
Конфигурация — "не істеу керек" емес, "қалай істеу керек". Ол параметрлерді сақтайды, ережелерді емес.

---

## 12. Billing Ownership

### Owns
| Меншік | Сипаттамасы |
|--------|-------------|
| **Usage Metering** | Әрбір request-ті санау |
| **Plan Assignment** | Қай tenant қай планда |
| **Invoicing** | Invoice генерация |
| **Payment Gateway** | Stripe / Kaspi / Halyk |
| **Subscription State** | Trial → Active → Suspended |

### Does NOT Own
- Rate limiting қадамдары (код)
- Request обработкасы

### Неге?
Billing — **платформаның бизнес қабаты**. Ол басқа компоненттерден изоляцияланған болуы керей. Егер billing істемей қалса, платформа әлі жұмыс істеуі керек (тек жаңа tenant-тар қосылмауы керек).

---

## 13. Feature Flags Ownership

### Owns
| Меншік | Сипаттамасы |
|--------|-------------|
| **Flag Definitions** | Кодта: `feature-flags.ts` |
| **Flag State** | Redis: global + tenant override |
| **Rollout Control** | Phase 1 → Phase 2 → Phase 3 → GA |
| **A/B Experiments** | Variant A vs B |

### Does NOT Own
- Business logic
- Code execution

### Неге?
Feature flags — **өтпелі қабат**. Олар "бұл feature қосулы ма?" деген сұраққа жауап береді. "Не істеу керек" — кодтың міндеті.

---

## 14. Ownership Violations

### Егер бір субжүйе басқасының меншігіне енсе:

| VIOLATION | Мысал | Қаупі |
|-----------|-------|-------|
| **Prompt → Business Logic** | "Егер төлем 10,000 теңгеден асса" | LLM модель ауысқанда сынады |
| **Code → Prompt Personality** | "instructions-та бұл жерде эмоция қосу керек" | Код prompt-ты басқарады → prompt икемділігін жоғалтады |
| **LLM → Validation** | LLM-нің өзі "мен 2 сөйлемнен аспадым ба?" деп тексеруі | Модельге байланысты, детерминизм жоқ |
| **Redis → Permanent Storage** | Redis-те мәңгілік деректер сақтау | Redis құласа, деректер жоғалады |
| **NocoDB → Runtime State** | NocoDB-ге әрбір request-ті жазу | Rate limit тез бітеді, баяу |
| **Website → AI Work** | Сайттың өзі клиентпен сөйлесуі | Сайт күрделенеді, масштабталмайды |
| **AI → Website Work** | AI заказ қабылдауы | Заказ жоғалуы, төлем қатесі |

---

## 15. Summary Diagram

```
┌─────────────────────────────────────────────────────────────┐
│                     WEBSITE                                   │
│  products, categories, pricing, cart, checkout, payments     │
│  orders, delivery, discounts, bonuses, reviews               │
├─────────────────────────────────────────────────────────────┤
│                     DLE (Source of Truth)                     │
│  business data: menu, orders, customers                       │
├─────────────────────────────────────────────────────────────┤
│                     AI (Digital Restaurant Manager)           │
│  communication, understanding, recommendations, guidance     │
├─────────────────────────────────────────────────────────────┤
│                     CODE (Business Logic)                     │
│  rules, validation, permissions, workflow, orchestration      │
├─────────────────────────────────────────────────────────────┤
│                     PROMPT (Behavior)                         │
│  personality, style, tone, brand voice                        │
├─────────────────────────────────────────────────────────────┤
│                     LLM (Language)                             │
│  understanding, generation, conversation                      │
├─────────────────────────────────────────────────────────────┤
│                     SKILLS (Execution)                        │
│  searchMenu, getPaymentDetails, registerReceipt, etc.         │
├─────────────────────────────────────────────────────────────┤
│                     REDIS (Runtime State)                     │
│  rate limit, spam, mute, magic links, context, temp data     │
├─────────────────────────────────────────────────────────────┤
│                     NOCODB (Configuration)                    │
│  restaurant config, shpor, prompt versions, settings          │
├─────────────────────────────────────────────────────────────┤
│                     BILLING (Business Layer)                   │
│  usage metering, plans, invoices, subscriptions               │
└─────────────────────────────────────────────────────────────┘
```

---

## 16. Ownership Test

Екі сұрақ — меншік шекарасын тексеру үшін:

**1. Бұл жерде не істеп жатыр?**
- Тілдік жауап па? → LLM
- Мінез-құлық па? → Prompt
- Ереже ме? → Code
- Дерек пе? → DLE / NocoDB
- Уақытша күй ме? → Redis

**2. Егер бұл компонент ауысса (мысалы, LLM моделі / Redis / NocoDB), бұл жердегі логика қайта жазылуы керек пе?**
- Егер "иә" → ownership violation
- Егер "жоқ" → дұрыс

---

_Ownership boundaries protect scalability. Respect them._
