# 22. Chief Architect

> **Нұсқа:** 1.0
> **Соңғы жаңарту:** 2026-07-08
> **Статус:** Active

---

## 1. Миссия

Chief Architect — жүйенің техникалық тұтастығын, масштабталуын және сапасын қамтамасыз етеді. Архитектуралық шешімдерді қабылдайды, техникалық борышты басқарады, инженерлік стандарттарды белгілейді.

---

## 2. Жауапкершілік

### 2.1 Архитектура

- Барлық ADR-ларды қабылдау және бекіту
- Жүйелік архитектураны жобалау (01-architecture)
- Scaling стратегиясын анықтау (16-scaling)
- Multi-tenant модельді жобалау (18-multi-tenant)
- Dependency graph-ты бақылау (0 circular dependency policy)
- API контрактілерін бекіту (03-api)

### 2.2 Техникалық көшбасшылық

- Техникалық стандарттарды белгілеу (19-standards)
- Инженерлік конституцияны қорғау (21-engineering-constitution)
- Tech debt prioritization
- Code review-дің соңғы инстанциясы
- Инженерлердің техникалық өсуіне жағдай жасау

### 2.3 Қауіпсіздік

- Threat model бекіту
- Security review-дің соңғы инстанциясы
- SSRF, prompt injection, tenant изоляциясы — тікелей бақылау
- Incident response-тің эскалация деңгейі

### 2.4 Инновация

- Жаңа технологияларды бағалау
- Proof of concept бастамалары
- LLM модельдерін бағалау (баға, жылдамдық, сапа)

---

## 3. Өкілеттік

- ADR-ды veto ету құқығы
- Feature-ді архитектуралық себеппен тоқтату құқығы
- Tech debt-ті P0/P1 деп белгілеу құқығы
- Инженерлік стандарттарды өзгерту құқығы
- Production-ға deploy-ді бұғаттау құқығы

---

## 4. Архитектуралық процесс

```
1. Проблема анықталады
2. ADR жазылады (автор: кез келген инженер)
3. Chief Architect ADR-ды ревьюлейді
4. Қажет болса, баламалар талқыланады
5. Chief Architect бекітеді / veto / өзгертуге жібереді
6. ADR Approved → іске асыру
7. Іске асыру аяқталған соң ADR Superseded белгіленеді
```

---

## 5. Архитектуралық шешімдерді бағалау критерийлері

| Критерий | Салмақ | Сипаттамасы |
|----------|--------|-------------|
| **Scalability** | 30% | 1 → 1000 ресторан |
| **Security** | 25% | SSRF, prompt injection, tenant isolation |
| **Maintainability** | 20% | Code complexity, onboarding time |
| **Cost** | 15% | LLM tokens, infra, dev time |
| **Time to Market** | 10% | Implementation speed |

---

## 6. Tech Debt Management

### Debt Register

| ID | Сипаттамасы | Severity | Жасалған күн | Жауапты |
|----|-------------|----------|--------------|---------|
| TD-001 | NocoDB rate limit (100 req/min) | P1 | 2026-03-15 | Chief Architect |

### Debt Lifecycle

```
Identification → Documentation → 
Prioritization (P0-P3) → 
Sprint Planning → 
Fix → 
Verification → 
Close
```

---

## 7. Review Criteria (Architecture Review)

- **Dependency graph:** 0 circular dependencies
- **Error handling:** Әрбір сыртқы шақыруда `.catch()` бар
- **Security:** SSRF, tenant isolation, rate limiting
- **LLM defense:** 4-layer бар ма?
- **Testing:** Unit + integration тесттері
- **Documentation:** ADR, API docs жаңартылды ма?
- **Monitoring:** Alert, metric, log бар ма?

---

## 8. Жаңа инженерге арналған бағдар

1. `01-architecture` — жүйені түсіну
2. `19-standards` — код стандарттары
3. `21-engineering-constitution` — ережелер
4. `22-chief-architect` — кімге сұрақ қою керек
5. `src/agent/finalValidator.ts` — негізгі бизнес-логика
6. `src/server.ts` — entry point
7. `src/routes/whatsappWebhook.route.ts` — негізгі flow

---

_Author: BekzatAI EOS_
