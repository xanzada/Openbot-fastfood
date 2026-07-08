# Code Review Checklist

> Нұсқа: 1.0
> Статус: Approved

---

## Quality Gates (Pass/Fail)

- [ ] **No `any` type** — барлық типтер анықталған
- [ ] **No `console.log`** — өндірісте логер қолданылған
- [ ] **No silent catch** — әрбір catch қатені өңдейді немесе қайта лактырады
- [ ] **No circular dependencies** — dependency cruiser өтеді
- [ ] **No secrets** — .env-ден тыс ешқандай токен/пароль жоқ
- [ ] **ES module** — import .js extension бар
- [ ] **ES2022** — заманауи синтаксис

## Функционалдық

- [ ] Параметрлер валидациясы бар ма?
- [ ] Null/undefined жағдайлары өңделген бе?
- [ ] Guard clause бар ма?
- [ ] Timeout конфигурацияланған ба?
- [ ] Cache стратегиясы дұрыс па?
- [ ] Error handling барлық жолдарды қамтиды ма?

## Қауіпсіздік

- [ ] SSRF қорғанысы бар ма? (DNS lookup, private IP)
- [ ] Timing-safe comparison қолданылған ба?
- [ ] SQL injection тексерілген бе? (егер PHP болса)
- [ ] XSS қорғанысы бар ма? (егер UI болса)
- [ ] Input sanitization жасалған ба?

## Өнімділік

- [ ] Параллель сұраулар Promise.all арқылы жасалған ба?
- [ ] Қажетсіз қайталанатын сұраулар жоқ па?
- [ ] Cache дұрыс TTL-мен конфигурацияланған ба?
- [ ] Redis key scan (KEYS) орнына SCAN қолданылған ба?

## Тесттер

- [ ] Unit тесттері бар ма?
- [ ] Integration тесттері бар ма?
- [ ] Edge-case жағдайлары тесттелген бе?
- [ ] Mock дұрыс құрылған ба?

## Құжаттама

- [ ] Функцияның signature өзгерсе, типтер жаңартылған ба?
- [ ] Бизнес-логика өзгерсе, ADR жазылған ба?
- [ ] API өзгерсе, контракт жаңартылған ба?
- [ ] Prompt өзгерсе, prompt құжаттамасы жаңартылған ба?

## DevOps

- [ ] Dockerfile өзгерсе, image қайта жиналған ба?
- [ ] Env айнымалылары .env.example-ге қосылған ба?
- [ ] Дерекқор миграциясы қажет пе?
- [ ] Monitoring метрикасы/алерті қажет пе?

---

_Author: BekzatAI EOS_
