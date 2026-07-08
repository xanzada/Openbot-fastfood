# 23. Workflow

> **Нұсқа:** 2.0
> **Соңғы жаңарту:** 2026-07-08
> **Статус:** Active

---

## 0. Universal Workflow: Analyze → Plan → Approve → Implement → Test → Document

Барлық жұмыс түрлері (feature, bugfix, refactor, операциялық өзгеріс) осы 6 қадамнан өтеді.

```
┌──────────┐    ┌──────────┐    ┌──────────┐
│ Analyze  │ →  │   Plan   │ →  │ Approve  │
│ (30%)    │    │ (15%)    │    │ (10%)    │
└──────────┘    └──────────┘    └──────────┘
     ↓
┌──────────┐    ┌──────────┐    ┌──────────┐
│Implement │ →  │   Test   │ →  │ Document │
│ (25%)    │    │ (15%)    │    │ (5%)     │
└──────────┘    └──────────┘    └──────────┘
```

**Уақыт бөлінісі** (жақындау):
- Analyze 30% — түсіну, зерттеу, қауіптерді бағалау
- Plan 15% — ADR / tech design жазу
- Approve 10% — review, sign-off
- Implement 25% — код жазу
- Test 15% — unit, integration, E2E
- Document 5% — EOS, changelog, release notes

---

## 1. Analyze

### Мақсаты
Проблеманы және оның контекстін толық түсіну. Шешім қабылдау үшін жеткілікті ақпарат жинау.

### Қадамдар

1. **Проблеманы анықтау**
   - Feature Request (05-feature-design) немесе Bug Report (04-bug-reports)
   - Acceptance criteria
   - Business value / severity

2. **Impact analysis**
   - Қандай компоненттерге әсер етеді? (dependency graph)
   - Қандай tenant-тарға әсер етеді?
   - Қандай API-лар өзгереді?
   - Security implications?

3. **Alternatives**
   - 2-3 alternative solution
   - Pros/cons әрқайсысына
   - Recommendation

4. **Risk assessment**
   - LLM-ге әсері (prompt, hallucination defense)
   - Performance impact (latency, throughput)
   - Rollback plan

### Output
- Analyze document (issue / feature request body)
- Impact report (егер үлкен өзгеріс)

### Сұрақтар (checklist)
- [ ] Проблема нақты түсінікті ме?
- [ ] Барлық alternative қарастырылды ма?
- [ ] Security risk бағаланды ма?
- [ ] API өзгерістері анықталды ма?
- [ ] LLM 4-layer defense-ке әсері бар ма?
- [ ] Rollback план бар ма?

---

## 2. Plan

### Мақсаты
Шешімді нақты жоспарлау. Техникалық дизайнды жазу. ADR (егер маңызды болса) дайындау.

### Қадамдар

1. **Tech design**
   - Қалай іске асырылады? (файлдар, функциялар)
   - Data flow
   - Error handling
   - Monitoring / logging

2. **ADR (егер маңызды өзгеріс)**
   - ADR шаблоны (02-adr/ADR-000-template.md)
   - Alternative бағалау
   - Decision

3. **Test plan**
   - Қандай тесттер жазылады?
   - Unit / Integration / E2E
   - Edge cases

4. **Release plan**
   - Feature flag керек пе?
   - Rollback strategy
   - Monitoring alerts

### Output
- Tech design document (PR body)
- ADR (02-adr/)
- Test plan (егер үлкен өзгеріс)

### Checklist
- [ ] Tech design жазылды ма?
- [ ] ADR керек пе? (жазылды ма?)
- [ ] Test plan анықталды ма?
- [ ] Feature flag керек пе?
- [ ] Monitoring / alert қосылды ма?

---

## 3. Approve

### Мақсаты
Жоспарды бекіту. Код ревью емес, жоспар ревью.

### Кім бекітеді?

| Өзгеріс түрі | Approver |
|-------------|----------|
| Minor bugfix | Tech Lead |
| Feature (standalone) | Tech Lead |
| Feature (architecture change) | Chief Architect |
| Security change | Chief Architect |
| Performance critical | Chief Architect |
| ADR required | Chief Architect |
| Hotfix | Tech Lead + post-hoc Chief Architect |

### Аспектілер

- **Functional:** Solution дұрыс па?
- **Security:** SSRF, prompt injection, tenant isolation
- **Performance:** N+1, Redis call-дар, timeout
- **Maintainability:** Complexity, tech debt

### Output
- Approved plan (PR label `plan-approved`)
- Veto немесе revision requests

### Checklist
- [ ] Plan approved
- [ ] ADR approved (егер бар болса)
- [ ] Қажетті sign-off жиналды

---

## 4. Implement

### Мақсаты
Код жазу. Branch, commits, PR.

### Қадамдар

1. **Branch:** `feature/уид-атау` / `fix/уид-атау` / `refactor/сипаттама`
2. **Code:** implementation
3. **Commit:** conventional commits (`feat:`, `fix:`, т.б.)
4. **Push**
5. **PR:** summary, testing, related issues

### Branch стратегиясы

```
main           — Production-ready
├── feature/*  — Жаңа мүмкіндіктер
├── fix/*      — Багтарды түзету
├── refactor/* — Рефакторинг
├── docs/*     — Құжаттама
└── release/*  — Релизді дайындау
```

### Commit conventions

```
feat:     Жаңа feature
fix:      Баг түзету
refactor: Рефакторинг
docs:     Құжаттама өзгерісі
test:     Тесттер
chore:    Қосалқы жұмыстар (deps, CI)
security: Қауіпсіздік түзетуі
perf:     Өнімділік оңтайландыру

Формат: <type>(<scope>): <description>
Мысал: feat(validator): add wait_time sentence stripping
```

### PR стандарты

- **Title:** `<type>(<scope>): <description>`
- **Body:** Не істелді, неге, қалай тесттелді
- **Size:** 400 строктан аспауы керек
- **Reviewers:** Кемінде 1 (маңызды өзгерістерде 2)
- **Linked issues:** BUG-NNN / ADR-NNN / FEATURE-NNN

### Checklist
- [ ] Code follows standards (Biome)
- [ ] No hardcoded secrets
- [ ] Error handling (try/catch, .catch())
- [ ] LLM 4-layer defense intact
- [ ] Logging added (info/error/debug)

---

## 5. Test

### Мақсаты
Кодтың дұрыс жұмыс істейтінін тексеру. Regression жоқ.

### Қадамдар

1. **Local:**
   ```bash
   npm run lint
   npm run typecheck
   npm test
   ```

2. **CI:**
   - Push → Build → Lint → Typecheck → Test

3. **Review (24-review):**
   - Code review checklist
   - Functional, security, LLM-specific

4. **Staging:**
   - Deploy to staging
   - Smoke test
   - E2E test (егер бар болса)

5. **Production (post-deploy):**
   - Monitoring (30 min)
   - Performance metrics

### Тест түрлері

| Тест | Қамту | Қашан |
|------|-------|-------|
| Unit | 60-70% | Feature-мен бірге |
| Integration | 20-30% | Feature аяқталған соң |
| E2E | 5-10% | Staging-де |
| Regression | Барлық | Release алдында |

### Checklist
- [ ] Unit tests pass
- [ ] Lint + typecheck pass
- [ ] Code review approved
- [ ] Staging smoke test passed
- [ ] Regression: no P0/P1 bugs

---

## 6. Document

### Мақсаты
Өзгерістің білімін сақтау. Басқа инженерлер түсінуі үшін.

### Құжатталуы керек:

| Құжат | Қашан | Орны |
|-------|-------|------|
| **ADR** | Architecture change | 02-adr/ |
| **PR description** | Әрбір PR | GitHub |
| **EOS docs** | API / архитектура өзгерсе | .bekzat-ai-eos/ |
| **Release notes** | Release кезінде | 07-release-notes/ |
| **Bug report** | Баг табылғанда | 04-bug-reports/ |

### Deployment документациясы

- **Release steps:**
  1. `release/v{major}.{minor}.{patch}` branch
  2. Changelog жаңарту
  3. Version bump (`package.json`)
  4. Staging deploy + smoke test
  5. QA verification
  6. Security review (егер қажет)
  7. Tag: `v{major}.{minor}.{patch}`
  8. Deploy to production
  9. Monitoring (30 min)
  10. Release notes жариялау

- **Hotfix steps:**
  1. main-нан `fix/hotfix-сипаттама` branch
  2. Fix + test
  3. PR → Review (жедел)
  4. Merge to main
  5. Deploy тікелей production-ға
  6. Hotfix release notes

### Checklist
- [ ] ADR documented (егер керек болса)
- [ ] API docs updated (03-api/)
- [ ] EOS docs synced (.bekzat-ai-eos/)
- [ ] Changelog updated
- [ ] Release notes written (07-release-notes/)
- [ ] Monitoring/alert documentation updated

---

## 7. Workflow Mapping

Әрбір жұмыс түрі 6 қадамға қалай түседі:

### Feature

| Қадам | Not |
|-------|-----|
| **Analyze** | Feature request → impact → alternatives → risk |
| **Plan** | Tech design → ADR (егер қажет) → test plan → release plan |
| **Approve** | Plan review (Tech Lead / Chief Architect) |
| **Implement** | Branch → Code → Commit → PR |
| **Test** | Lint → typecheck → unit → integration → code review → staging → E2E |
| **Document** | ADR → EOS docs → changelog → release notes |

### Bugfix

| Қадам | Not |
|-------|-----|
| **Analyze** | Bug report → triage (severity) → root cause |
| **Plan** | Fix plan → regression scope |
| **Approve** | Tech Lead (P0/P1 жедел) |
| **Implement** | Branch fix/ → fix → commit → PR |
| **Test** | Fix test → regression test → code review |
| **Document** | Bug report close → release notes |

### Refactor

| Қадам | Not |
|-------|-----|
| **Analyze** | Tech debt → why → what improves |
| **Plan** | Refactor scope → test plan → migration plan |
| **Approve** | Chief Architect (өйткені үлкен өзгеріс) |
| **Implement** | Branch refactor/ → code → commit → PR |
| **Test** | Full regression → no behavior change |
| **Document** | ADR (егер architecture) → tech debt register update |

---

## 8. CI/CD Integration

### Pull Request

```
Analyze → Plan → Approve → [Implement → Test → Document]
                                      ↓
                              Push → Build → Lint → Typecheck → Test
                              Result: ✅ / ❌
```

### Merge to main

```
Implement → Test → Document → [CI/CD]
                                  ↓
                  Docker build → Push → Staging deploy → Smoke test
                  Manual approval → Production deploy
```

### Tag (v*.*.*)

```
Tag → Build → Test → Docker build → Push with semver → Deploy
```

---

## 9. Communication

### Standup (күн сайын, 09:00)

- Қазір қай қадамдамын? (Analyze/Plan/Approve/Implement/Test/Document)
- Кеше не істедім?
- Бүгін не істеймін?
- Қандай блокерлер бар?

### Slack каналдары

| Канал | Мақсаты |
|-------|---------|
| `#engineering` | Жалпы техникалық талқылаулар |
| `#incidents` | P0/P1 инциденттер |
| `#deploy` | Deploy хабарландырулары |
| `#releases` | Release notes |

### Эскалация

```
Инженер → Tech Lead → Chief Architect
P0: 5 min response
P1: 30 min response
P2: 4 hours response
```

---

## 10. Инструменттер

| Инструмент | Мақсаты | Қай қадамда |
|-----------|---------|-------------|
| **GitHub** | Код, PR, Issues | Plan → Implement → Review |
| **GitHub Actions** | CI/CD | Test → Document |
| **Slack** | Коммуникация | Approve → Communication |
| **VSCode** | Редактор | Implement |
| **Biome** | Формат + lint | Implement → Test |
| **Vitest** | Тесттер | Test |
| **Docker** | Контейнер | Document (deploy) |
| **Redis Insight** | Redis GUI | Test (debug) |
| **Grafana** | Мониторинг | Test (post-deploy) |

---

_Author: BekzatAI EOS_
