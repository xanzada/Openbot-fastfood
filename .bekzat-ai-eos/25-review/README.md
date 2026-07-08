# 25. Review (Code Review)

> **Нұсқа:** 1.0
> **Соңғы жаңарту:** 2026-07-08
> **Статус:** Active

---

## 1. Миссия

Code Review — код сапасын, қауіпсіздікті және консистенттілікті қамтамасыз етеді. Білім алмасуға, стандарттарды сақтауға және багтарды ерте анықтауға арналған.

---

## 2. Review принциптері

### 2.1 Басшылық қағидалар

1. **Барлық PR review-ден өтеді** — exceptions жоқ
2. **Review — сын емес, ынтымақтастық** — blame-free, конструктивті
3. **Автоматтандыруға болатынды автоматтандыр** — Biome, typecheck, CI
4. **20/20 rule** — 20 минуттан артық ревью бір отырыста
5. **400 строктан аспаған PR** — үлкен PR сапасы төмен

### 2.2 Қашан review керек?

- **Feature PR** — кемінде 1 reviewer, маңызды болса Chief Architect
- **Bugfix PR** — кемінде 1 reviewer
- **Hotfix PR** — 1 reviewer (жедел), retrospective review кейін
- **Refactor PR** — 2 reviewers
- **Release PR** — 1 reviewer + QA sign-off
- **Security PR** — Chief Architect міндетті

---

## 3. Review checklist

### 3.1 Функционалдық тексеру

- [ ] Code logic дұрыс па? Нені өзгертті, неге?
- [ ] Edge cases өңделген бе? (null, empty, timeout, error)
- [ ] Business logic кодта ма, prompt-та емес пе?
- [ ] Feature/issue толық жүзеге асқан ба?

### 3.2 Қауіпсіздік

- [ ] User input валидацияланған ба? (XSS, injection)
- [ ] SSRF қаупі жоқ па? (сыртқы URL тек allowed list-тен)
- [ ] .env-ден тыс секреттер жоқ па? (hardcoded key/token)
- [ ] Rate limiting ескерілген бе?
- [ ] Tenant изоляциясы бұзылмаған ба? (Redis prefix, NocoDB filter)
- [ ] Prompt injection қорғанысы бар ма?

### 3.3 LLM-specific

- [ ] 4-layer defense сақталған ба?
- [ ] Prompt-та business logic жоқ па?
- [ ] finalValidator өзгертілген бе? (барлық regex жаңа)
- [ ] LLM response-тың max 2 sentence ережесі сақталған ба?
- [ ] LLM timeout өңделген бе? (30s)

### 3.4 Өнімділік

- [ ] Redis call-дар бар ма? (2s timeout)
- [ ] DB-ге артық request жоқ па?
- [ ] Async код блоктамай ма? (await vs setImmediate)
- [ ] N+1 проблемасы жоқ па?

### 3.5 Код сапасы

- [ ] Код стандарттарға сәйкес пе? (naming, types, format)
- [ ] Dead code жоқ па? (console.log, unused imports)
- [ ] Error handling дұрыс па? (try/catch, .catch())
- [ ] Логтар дұрыс деңгейде ме? (info vs error vs debug)
- [ ] DRY принципі сақталған ба?

### 3.6 Тесттер

- [ ] Unit tests жазылған ба?
- [ ] Edge cases тесттелген бе?
- [ ] Regression қамтылған ба?
- [ ] Тесттер isolarцияланған ба? (бір-біріне тәуелді емес)
- [ ] Coverage minimumнан төмен емес пе?

### 3.7 Құжаттама

- [ ] ADR/API docs жаңартылған ба?
- [ ] JSDoc / комментарийлер (тек "неге") жаңартылған ба?
- [ ] Release notes жаңартылған ба? (егер release-re қатысты)
- [ ] EOS docs синхрондалған ба?

---

## 4. Review процессі

### 4.1 Flow

```
Author creates PR
  ↓
CI runs (lint → typecheck → test)
  ↓ (CI ❌ → author fixes)
CI ✅ → Request Review
  ↓
Reviewer аналайды
  ↓
Comments / Change requests
  ↓
Author fixes → re-request review
  ↓
Approved
  ↓
Merge to main (squash merge)
```

### 4.2 Review types

| Type | Белгі | Мағынасы |
|------|-------|----------|
| **Approve** | ✅ | Өзгеріс дұрыс, merge етуге болады |
| **Comment** | 💬 | Жалпы пікір, өзгерту міндетті емес |
| **Request Changes** | ❌ | Міндетті өзгертулер бар, merge бұғатталды |

### 4.3 Жылдам review (что делать)

1. **Мықты дегеннің орнына сұрақ қой:** "Неге бұлай істедің?" vs "Мынау дұрыс емес"
2. **Код стилі туралы дауласпа:** auto-formatter (Biome) бар
3. **"Айтпақшы" әдісі:** негізгі комментарийден кейін кішкене ұсыныс
4. **CR кезінде тестіле:** жай оқыма, жүгіртіп көр
5. **Егер 30 мин бұрын бастасаң:** тоқта, кейін жалғастыр

---

## 5. Review рөлдері

| Рөл | Жауапкершілік |
|-----|---------------|
| **Author** | PR жасайды, комментарийлерге жауап береді, fix-ті қолданады |
| **Reviewer** | Кодты ревьюлейді, комментарий қалдырады, approve/deny |
| **QA** | Функционалдық тексеру, test plan review |
| **Chief Architect** | Соңғы инстанция, security/arch review |
| **Merge Master** | Merge-ді басқарады (бір адам ротация бойынша) |

---

## 6. Review metrics (есептеу үшін)

| Metric | Target | Қалай есептеледі |
|--------|--------|------------------|
| **Review time** (first response) | < 4 hours | PR opened → first review |
| **Merge time** | < 24 hours | PR opened → merged |
| **Review depth** | ≥ 2 comments per PR | Average comments |
| **Approve rate** | > 80% | Approved / total PRs |
| **Rework cycles** | < 2 | Րекурентті review cycles |
| **Bug escape rate** | < 5% | Production bugs / total PRs |

---

## 7. Conflict resolution

- **Дәлелді пікір:** Егер екі жақты пікір болса, Chief Architect шешеді
- **Time limit:** 24 сағаттан артық дауласуға болмайды
- **Data-driven:** "Менің ойымша" емес, "өлшем көрсеткендей"
- **ADR:** Егер үлкен disagreement болса, ADR жазылады

---

## 8. PR Template

```markdown
## Summary

Не істедім, неге, нені өзгерттім.

## Testing

- [ ] Unit tests
- [ ] Integration tests
- [ ] Manual testing
- [ ] Staging tested

## Related

- Closes BUG-NNN / FEATURE-NNN
- Related ADR: ADR-NNN

## Checklist

- [ ] Code follows standards
- [ ] No hardcoded secrets
- [ ] LLM 4-layer defense intact
- [ ] EOS docs updated
```

---

_Author: BekzatAI EOS_
