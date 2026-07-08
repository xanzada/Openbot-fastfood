# 24. QA (Quality Assurance)

> **Нұсқа:** 1.0
> **Соңғы жаңарту:** 2026-07-08
> **Статус:** Active

---

## 1. Миссия

QA — жүйенің сапасын қамтамасыз етеді. Багтарды ерте анықтайды, тест стратегиясын анықтайды, регрессияны болдырмайды.

---

## 2. Тестілеу стратегиясы

### 2.1 Тест пирамидасы

```
         ╱╲
        ╱ E2E ╲           ← 5-10% (Playwright / Supertest)
       ╱────────╲
      ╱ Integration ╲     ← 20-30% (Redis + NocoDB моктарымен)
     ╱────────────────╲
    ╱    Unit Tests     ╲  ← 60-70% (жеке функциялар, изоляция)
   ╱──────────────────────╲
```

### 2.2 Қамту мақсаттары

| Қабат | Unit | Integration | E2E |
|-------|------|-------------|-----|
| **Agent** (finalValidator, instructions, agent) | 95% | 90% | 80% |
| **Context** (preloadContext, buildFactsPrompt) | 90% | 85% | — |
| **Skills** (menuLink, searchMenu, payment, т.б.) | 90% | 80% | — |
| **Transport** (whatspro.client) | 85% | 75% | — |
| **Routes** (whatsappWebhook) | 90% | 85% | 80% |
| **Services** (redis, nocodb, dle) | 85% | 80% | — |

---

## 3. Тест түрлері

### 3.1 Unit Tests

- **Инструмент:** Vitest
- **Мақсаты:** Әрбір функция/модуль дұрыс жұмыс істейді
- **Кім жазады:** Developer (TDD принципі)
- **Қашан:** Feature-мен бірге

**Міндетті test cases:**
- Normal flow (негізгі жол)
- Edge cases (шекаралық жағдайлар)
- Error handling (қате сценарийлері)
- Null/undefined/empty (бос мәндер)

### 3.2 Integration Tests

- **Инструмент:** Vitest + ioredis-mock
- **Мақсаты:** Компоненттер арасындағы байланыс
- **Кім жазады:** Developer + QA
- **Қашан:** Feature аяқталған соң

**Test scenarios:**
- Webhook → preloadContext → LLM → finalValidator → response
- Rate limiting (15 req/min)
- Spam mute (6+ messages)
- fromMe handling

### 3.3 E2E Tests

- **Инструмент:** Supertest + WhatsApp test номері
- **Мақсаты:** Толық flow (WhatsApp → сервер → жауап)
- **Кім жазады:** QA
- **Қашан:** Feature released болған соң

**Test scenarios:**
- "Мәзір" → menu link жіберілді
- "Статус" → runtime жауап
- "Сәлем" → LLM жауап

### 3.4 Regression Tests

- **Мақсаты:** Ескі функционал бұзылмағанын тексеру
- **Қашан:** Әрбір релиз алдында
- **Кім жүргізеді:** QA

### 3.5 Performance Tests

- **Инструмент:** k6 / autocannon
- **Мақсаты:** Response time, throughput, resource usage
- **Қашан:** Әрбір major релиз алдында
- **Метрикалар:** p50 < 1s, p95 < 3s, p99 < 5s

### 3.6 Security Tests

- **Мақсаты:** SSRF, prompt injection, rate limiting
- **Қашан:** Әрбір релиз алдында
- **Test cases:** Invalid token, spam, HTML injection, SQL-like input

---

## 4. QA Процессі

### 4.1 Feature Testing

```
1. Feature request → QA review (testable mi?)
2. Feature design → QA test strategy
3. Development → QA unit test жазады
4. PR → QA ревью (тесттер жеткілікті ме?)
5. Staging deploy → QA full test
6. UAT (User Acceptance Testing)
7. Production deploy → QA smoke test
8. Release → QA sign-off
```

### 4.2 Bug Lifecycle

```
Bug Report → QA Triage (severity) → 
Developer Fix → QA Verify → 
Regression Test → Close
```

### 4.3 Release Testing

```
1. Feature freeze (1 day before release)
2. Regression test suite run
3. Performance test run
4. Security test run
5. Smoke test (production)
6. QA sign-off
7. Release
```

---

## 5. Test Documentation

| Құжат | Сипаттамасы | Орны |
|-------|-------------|------|
| Test Plan | Тест стратегиясы, test cases | 11-testing/templates/test-plan.md |
| Testing Report | Нәтижелер, coverage | 11-testing/templates/testing-report.md |
| Bug Report | Баг сипаттамасы | 04-bug-reports/BUG-000-template.md |

---

## 6. QA Check-лист (Pre-Release)

- [ ] Unit tests pass (npm test)
- [ ] Integration tests pass
- [ ] Coverage requirements met
- [ ] E2E tests pass
- [ ] Performance: p95 < 3s
- [ ] Security: SSRF + auth + rate limit
- [ ] Regression: no known bugs P0/P1
- [ ] Logging: error логи дұрыс
- [ ] Monitoring: alert thresholds configured
- [ ] Rollback plan documented

---

## 7. AI-Specific Testing

### 7.1 LLM Testing

- **Hallucination test:** LLM жоқ тағамды айта ма?
- **Sentence limit:** 2 сөйлемнен аспай ма?
- **Language purity:** Қазақ/орыс араласпаған ба?
- **Menu isolation:** Мәзір сұрағына тек мәзір жауабы?
- **Link policy:** Сілтеме дұрыс жіберілді ме?

### 7.2 Prompt Testing

- **Prompt injection:** "Ignore all previous instructions" → блоктала ма?
- **Role playing:** "You are a helpful assistant" → басқа рөлге ене ме?
- **Jailbreak:** "Do anything now" (DAN) → бұзыла ма?

### 7.3 Fallback Testing

- LLM timeout → fallback жауап
- Redis unavailable → degrade mode
- NocoDB unavailable → stale cache
- Rate limited → 429

---

_Author: BekzatAI EOS_
