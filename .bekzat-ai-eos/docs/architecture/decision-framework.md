# Engineering Decision Framework

> **Нұсқа:** 1.0
> **Типі:** Immutable — міндетті түрде әрбір feature алдында қолдану
> **Өзгерту:** Тек ADR + Chief Architect

---

## How to Use This Framework

Әрбір feature, bugfix, refactor немесе архитектуралық өзгерісті бастамас бұрын:

**Step 1:** Осы құжатты ашыңыз.
**Step 2:** 12 сұраққа жауап беріңіз.
**Step 3:** Шешімді PR description-ға немесе ADR-ге жазыңыз.
**Step 4:** Тек содан кейін код жазуға кірісіңіз.

Бұл қадамдарды өткізіп жіберу — architecture violation.

---

## The 12 Questions

### Category A: Classification (What is this?)

---

#### Q1: Is this business logic?

| Егер "Иә" болса | Егер "Жоқ" болса |
|-----------------|-------------------|
| Мысал: "Егер клиент 6 рет хабарласса — mute" | Мысал: "Клиентке қалай жауап беру керек" |
| **Міндетті түрде кодта** (code/) | Келесі сұраққа өтіңіз |
| Prompt-та НІКОЛИ | |

**Тест:** Бұл ереже LLM моделіне байланыссыз ба? Егер иә — business logic.

---

#### Q2: Is this AI behavior?

| Егер "Иә" болса | Егер "Жоқ" болса |
|-----------------|-------------------|
| Мысал: "AI достық болуы керек" | Келесі сұраққа өтіңіз |
| **Prompt-та** (prompt/) | |
| Бизнес ережелері жоқ, тек мінез-құлық | |

**Тест:** Бұл AI-дің "кім екенін" анықтайды ма, "не істейтінін" емес пе? Егер иә — AI behavior.

---

#### Q3: Is this presentation?

| Егер "Иә" болса | Егер "Жоқ" болса |
|-----------------|-------------------|
| Мысал: "Жауап 2 сөйлемнен аспауы керек" | Келесі сұраққа өтіңіз |
| **finalValidator-де** (code/) | |
| Немесе **formatting rules** (prompt/) | |

**Тест:** Бұл "қалай көрсетіледі" ме, "не көрсетіледі" ме? Егер "қалай" — presentation.

---

#### Q4: Is this configuration?

| Егер "Иә" болса | Егер "Жоқ" болса |
|-----------------|-------------------|
| Мысал: "Жұмыс уақыты 10:00-22:00" | Келесі сұраққа өтіңіз |
| **NocoDB-де** (config/) | |
| Эндрюзер өзгерте алады | |

**Тест:** Бұл мән рестораннан ресторанға өзгере ме? Егер иә — configuration.

---

#### Q5: Is this runtime state?

| Егер "Иә" болса | Егер "Жоқ" болса |
|-----------------|-------------------|
| Мысал: "Бұл клиент қазір rate limit-те ме?" | Келесі сұраққа өтіңіз |
| **Redis-те** (redis/) | |
| Жоғалса, қайта қалпына келеді | |

**Тест:** Бұл мән request арасында өзгере ме? Егер иә — runtime state.

---

#### Q6: Is this temporary memory?

| Егер "Иә" болса | Егер "Жоқ" болса |
|-----------------|-------------------|
| Мысал: "Клиент бұрын не айтқан?" | Келесі сұраққа өтіңіз |
| **Redis-те** (redis/) | |
| TTL бар | |

**Тест:** Бұл дерек 1 сағаттан кейін әлі қажет пе? Егер жоқ — temporary memory.

---

#### Q7: Is this persistent data?

| Егер "Иә" болса | Егер "Жоқ" болса |
|-----------------|-------------------|
| Мысал: "Тағамдар тізімі" | Келесі сұраққа өтіңіз |
| **DLE-де** (persistent/) | |
| Жоғалса, бизнес тоқтайды | |

**Тест:** Бұл дерек жоғалса, бизнес жұмысы тоқтай ма? Егер иә — persistent data.

---

### Category B: Placement (Where does it live?)

---

#### Q8: Should this live in Prompt?

| Критерий | Шешім |
|----------|-------|
| AI-дің мінез-құлқын анықтайды | ✅ Prompt |
| Тек brand guidelines | ✅ Prompt |
| Бизнес ережелері | ❌ НІКОЛИ Prompt-та |
| Валидация | ❌ Кодта |
| Деректерге рұқсат | ❌ Кодта |

**Жауап "Prompt" болса:**
- Файл: `src/agent/instructions.ts` немесе `instructions/v{n}.ts`
- 4-layer defense-тің Layer 1
- Әрбір өзгерту = version bump + ADR

---

#### Q9: Should this live in Code?

| Критерий | Шешім |
|----------|-------|
| Бизнес ережелері | ✅ Code |
| Валидация | ✅ Code |
| Permissions | ✅ Code |
| Workflow / Orchestration | ✅ Code |
| Error handling | ✅ Code |
| Rate limiting | ✅ Code |
| AI-дің мінез-құлқы | ❌ Prompt-та |

**Жауап "Code" болса:**
- Қай файл? (`src/services/`, `src/agent/`, `src/routes/`)
- Қандай принцип? (DRY, Single Responsibility)
- Тест жазылды ма?

---

#### Q10: Should this live in NocoDB?

| Критерий | Шешім |
|----------|-------|
| Ресторан конфигурациясы | ✅ NocoDB |
| Shpor (FAQ) | ✅ NocoDB |
| Prompt нұсқалары | ✅ NocoDB |
| Әр tenant үшін әртүрлі | ✅ NocoDB |
| Эндрюзер өзгерте алады | ✅ NocoDB |
| Жоғалса, бизнес тоқтайды | ❌ DLE-де / Кодта |
| Жылдам қатынас керек | ❌ Redis-те cache |

**Жауап "NocoDB" болса:**
- Redis cache (TTL: 1 min)
- Tenant filter: `WHERE (instance,eq,{instance})`
- Rate limit: 100 req/min

---

#### Q11: Should this live in Redis?

| Критерий | Шешім |
|----------|-------|
| Rate limit state | ✅ Redis |
| Spam / mute state | ✅ Redis |
| Session context | ✅ Redis |
| Magic links | ✅ Redis |
| Cache | ✅ Redis |
| Тұрақты сақтау | ❌ NocoDB / DLE |
| Жоғалса, платформа тоқтайды | ❌ Қайта қарау керек |

**Жауап "Redis" болса:**
- Key format: `{instance}:{purpose}:{identifier}`
- TTL міндетті
- Redis құласа, платформа әлі жұмыс істейді (degraded mode)

---

#### Q12: Should this live in DLE?

| Критерий | Шешім |
|----------|-------|
| Тағамдар, категориялар | ✅ DLE |
| Заказдар, клиенттер | ✅ DLE |
| Бағалар | ✅ DLE |
| Акциялар, жеңілдіктер | ✅ DLE |
| AI конфигурациясы | ❌ NocoDB |
| Уақытша state | ❌ Redis |

**Жауап "DLE" болса:**
- API шлюз арқылы (api_bot.php)
- Read-only (AI үшін)
- DLE өзгерсе — AI автоматты түрде бейімделеді

---

## Quick Reference: Placement Matrix

```
┌──────────────────────┬──────────┬────────┬────────┬──────┐
│ What                 │ Code     │ Prompt │ Redis  │NocoDB│
├──────────────────────┼──────────┼────────┼────────┼──────┤
│ Business rules       │ ✅ OWN   │ ❌     │ ❌    │ ❌  │
│ Validation           │ ✅ OWN   │ ❌     │ ❌    │ ❌  │
│ Permissions          │ ✅ OWN   │ ❌     │ ❌    │ ❌  │
│ Workflow             │ ✅ OWN   │ ❌     │ ❌    │ ❌  │
│ Error handling       │ ✅ OWN   │ ❌     │ ❌    │ ❌  │
│ Rate limiting        │ ✅ OWN   │ ❌     │ ✅    │ ❌  │
├──────────────────────┼──────────┼────────┼────────┼──────┤
│ AI personality       │ ❌      │ ✅ OWN │ ❌    │ ❌  │
│ Communication style  │ ❌      │ ✅ OWN │ ❌    │ ❌  │
│ Brand voice          │ ❌      │ ✅ OWN │ ❌    │ ❌  │
├──────────────────────┼──────────┼────────┼────────┼──────┤
│ Session context      │ ❌      │ ❌     │ ✅ OWN │ ❌  │
│ Rate limit state     │ ❌      │ ❌     │ ✅ OWN │ ❌  │
│ Temp cache           │ ❌      │ ❌     │ ✅ OWN │ ❌  │
├──────────────────────┼──────────┼────────┼────────┼──────┤
│ Restaurant config    │ ❌      │ ❌     │ ❌    │ ✅ OWN│
│ Shpor / FAQ          │ ❌      │ ❌     │ ❌    │ ✅ OWN│
│ Prompt versions      │ ❌      │ ❌     │ ❌    │ ✅ OWN│
├──────────────────────┼──────────┼────────┼────────┼──────┤
│ Products / Menu      │ ❌      │ ❌     │ ❌    │ ❌  │
│ Orders               │ ❌      │ ❌     │ ❌    │ ❌  │
│ Customers            │ ❌      │ ❌     │ ❌    │ ❌  │
│                      │── DLE ──┤       │       │      │
└──────────────────────┴──────────┴────────┴────────┴──────┘
```

---

## Decision Flowchart

```
Бастау: Жаңа feature / өзгеріс
  │
  ▼
Q1: Is this business logic?
  ├── Иә → Code. Prompt-та жоқ.
  └── Жоқ →
        │
        ▼
Q2: Is this AI behavior?
  ├── Иә → Prompt. Бизнес ережелері жоқ.
  └── Жоқ →
        │
        ▼
Q7: Is this persistent data?
  ├── Иә → DLE (business data) немесе NocoDB (config)
  └── Жоқ →
        │
        ▼
Q5/Q6: Runtime state / temp memory?
  ├── Иә → Redis. TTL міндетті.
  └── Жоқ →
        │
        ▼
Қалған жағдай:
  Q3: Presentation → finalValidator (code)
  Q4: Configuration → NocoDB
  Басқа → Code (default)
```

---

## Examples

### Example 1: 2 sentence limit

```
Q1: Business logic?    → Иә (ереже)
     → Шешім: Code (finalValidator.ts)
Q2: AI behavior?       → Жоқ (бизнес ереже)
Q8: Prompt?            → ЖОҚ (бизнес логика prompt-та болмайды)
Q9: Code?              → ИӘ (finalValidator.ts)
```

### Example 2: AI friendly tone

```
Q1: Business logic?    → Жоқ
Q2: AI behavior?       → Иә (мінез-құлық)
     → Шешім: Prompt (instructions.ts)
Q8: Prompt?            → ИӘ
Q9: Code?              → ЖОҚ (мінез-құлықты код басқармайды)
```

### Example 3: Rate limit 15 req/min

```
Q1: Business logic?    → Иә
     → Шешім: Code (inboundGuard.service.ts)
Q5: Runtime state?     → Иә (Redis: ratelimit:{instance}:{phone})
Q9: Code?              → ИӘ (rate limit logic)
Q11: Redis?            → ИӘ (state storage)
```

### Example 4: Restaurant work hours

```
Q4: Configuration?     → Иә (рестораннан ресторанға өзгереді)
     → Шешім: NocoDB (tenant config)
Q10: NocoDB?           → ИӘ
Q11: Redis?            → Cache (TTL 1 min)
```

---

## When to Create an ADR

Егер келесі сұрақтардың біреуіне "иә" деп жауап берсеңіз — ADR міндетті:

- Бұл шешім архитектураны өзгерте ме?
- Бұл шешім ownership boundaries-ті бұза ма?
- Бұл шешім 12 сұраққа нақты жауап бере алмай ма?
- Бұл шешімге дау бар ма?
- Бұл шешім басқа компоненттерге әсер ете ме?

---

## Ownership Violation Check

Әрбір feature соңында тексеру:

```
[ ] Business logic тек кодта, prompt-та жоқ
[ ] AI behavior тек prompt-та, кодта жоқ
[ ] Runtime state тек Redis-те
[ ] Configuration тек NocoDB-де
[ ] Persistent data тек DLE-де немесе NocoDB-де
[ ] LLM ешқандай business logic-ті иеленбейді
[ ] Prompt injection арқылы business logic айналып өту мүмкін емес
```

---

_This framework protects architecture. Do not skip it._
