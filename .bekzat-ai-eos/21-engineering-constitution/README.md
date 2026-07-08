# 21. Engineering Constitution

> **Нұсқа:** 1.0
> **Соңғы жаңарту:** 2026-07-08
> **Статус:** Active

---

## Преамбула

Бұл Конституция — BekzatAI Engineering ұжымының жұмыс істеу принциптерінің, құндылықтарының және ережелерінің жиынтығы. Барлық инженерлер мен процестер осы құжатқа бағынады.

---

## 1. Негізгі құндылықтар

### 1.1 Code Over Prompt

Business logic ешқашан LLM prompt-та болмайды. Prompt тек brand guidelines үшін қолданылады. Барлық шешімдер кодта жүзеге асады. Prompt-тың өзгеруі кодтың өзгеруінсіз мүмкін емес.

### 1.2 Documentation as Code

Әрбір маңызды шешім, архитектура, API контрактісі және процесс құжатталады. Құжаттама код ретінде сақталады, код ретінде ревьюленеді, код ретінде версияланады.

### 1.3 Defense in Depth

LLM-ге сенім арту жеткіліксіз. Әрбір қауіпке қарсы кемінде 2 қабат қорғаныс болуы керек. 4-layer hallucination defense — бұл стандарт.

### 1.4 Security by Design

Қауіпсіздік — архитектураның бөлігі, қосымша емес. SSRF, prompt injection, tenant изоляциясы — жобаның басынан бастап ескеріледі.

### 1.5 Postmortem Culture

Әрбір инциденттен сабақ алынады. Blame-free postmortem — міндетті. Бір инцидент екінші рет қайталанбауы керек.

---

## 2. Инженерлік стандарттар

### 2.1 Код стандарты

- **Тіл:** TypeScript (strict mode)
- **Формат:** Biome (біркелкі формат)
- **Импорт:** ES modules (`.js` extension)
- **Атау:** camelCase функциялар, PascalCase класс/типтер, kebab-case файлдар
- **Комментарий:** Тек business logic түсіндіру үшін, "не" емес "неге"

### 2.2 API стандарты

- Барлық жауаптар JSON
- Барлық қателер `{ ok: false, error: "message" }`
- POST body `application/json`
- Аутентификация: Bearer → x-api-key → body.token → tenant secret (chain)
- HTTP status: 200 OK, 202 Accepted (асинхронды), 400/401/403/429/500

### 2.3 LLM стандарты

- Температура: 0.7
- Max tokens: 500
- Max steps: 6
- 4-layer defense міндетті
- Prompt-та business logic жоқ

---

## 3. Процестер

### 3.1 Feature Development

```
Idea → Feature Request (05-feature-design) → 
Feature Design (ADR + tech design) → 
Review → Implementation → 
Testing (11-testing) → 
Deployment (08-deployment) → 
Release Notes (07-release-notes)
```

### 3.2 Bug Fix

```
Bug Report (04-bug-reports) → 
Triage (severity) → 
Fix → 
Regression Test → 
Review → 
Deploy
```

### 3.3 Incident Response

```
Detection → 
Playbook (13-playbooks) → 
Mitigation → 
Resolution → 
Postmortem (14-incidents) → 
Action Items
```

---

## 4. Рөлдер мен жауапкершілік

| Рөл | Жауапкершілік | Басты құжат |
|-----|---------------|-------------|
| **Chief Architect** | Архитектура, ADR, scaling, tech debt | 22-chief-architect |
| **Tech Lead** | Feature design, код ревью, deployment | 19-standards |
| **SRE** | Мониторинг, playbooks, incident response | 13-playbooks, 15-monitoring |
| **Security Engineer** | Security review, threat model | 09-security |
| **QA Engineer** | Test plan, testing report | 11-testing, 24-qa |
| **AI Engineer** | Prompt spec, 4-layer defense | 06-prompts |

---

## 5. Міндетті ережелер (Hard Rules)

1. **Prompt-та business logic жоқ** — тек brand guidelines
2. **Әрбір LLM жауабы кодпен валидацияланады** (finalValidator.ts)
3. **4-layer defense міндетті** — ешқандай exceptions
4. **Барлық сыртқы request-тер timeout-пен** (max 30s LLM, 10s API, 2s Redis)
5. **Барлық қателер логқа жазылады** + developer notify (егер critical)
6. **Feature flag арқылы rollout** — tenant бойынша бөлек
7. **ADR-сіз ешқандай маңызды шешім** қабылданбайды
8. **Postmortem-сіз ешқандай инцидент** жабылмайды
9. **Код ревью-сіз ешқандай PR** merged емес
10. **Документсіз ешқандай feature** released емес

---

## 6. Техникалық борыш (Tech Debt) саясаты

- Әрбір спринтте 20% уақыт tech debt-ке жұмсалады
- Tech debt ADR арқылы құжатталады
- Critical tech debt (P0-P1) келесі спринтте міндетті түрде жойылады
- P2-P3 tech debt backlog-қа қосылады

---

## 7. Қауіпсіздік ережелері

- .env файлы кодта емес, серверде ғана
- API ключтер кодта ешқашан
- Redis пароль міндетті (production)
- Rate limiting міндетті
- SSRF қорғанысы міндетті (DNS allowed list)
- Tenant изоляциясы міндетті (Redis prefix + NocoDB row-level)

---

## 8. Конституцияны өзгерту

- Өзгертулер ADR арқылы жүзеге асады
- Конституцияның өзгеруі — Supersede
- Барлық инженерлер өзгертуге ұсыныс бере алады
- Шешімді Chief Architect қабылдайды

---

_BekzatAI Engineering Constitution — Build systems, not chaos._
