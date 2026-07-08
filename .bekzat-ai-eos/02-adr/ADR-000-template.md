# ADR-002: VoltAgent фреймворкін skill-бағытталған архитектура ретінде қолдану

> **Статус:** Approved
> **Күні:** 2026-06-15
> **Автор:** BekzatAI Engineering

---

## Контекст

Openbot-fastfood LLM жауаптарын тек бір prompt арқылы басқарды. Бірақ әртүрлі клиент сұрақтары (мәзір, мекен-жай, жұмыс уақыты, баға, заказ, техникалық қолдау) әртүрлі өңдеуді қажет етеді. Бір prompt барлық сценарийді дұрыс басқара алмайды, себебі:

- Мәзір сұрағы — нақты JSON деректерін қажет етеді
- Сілтеме сұрағы — мүлдем блокталуы керек
- Заказ — DLE API шақыруын қажет етеді
- Жалпы сұрақтар — тегін LLM жауабы

Бизнес драйвері: әр сценарийді дәл және қауіпсіз өңдеу, LLM-ге тым көп еркіндік бермеу.

## Шешім

VoltAgent-ті tool-based архитектура ретінде пайдалану: 7 tool (skill), әрқайсысы белгілі бір сценарийді өңдейді. Агент модельге байланысты қажетті tool-ды таңдайды (LLM-driven tool selection).

```
fastfoodAgent.ts
├── skills/
│   ├── index.ts                  ← createFastFoodSkills() — барлық tool-ды біріктіру
│   ├── menuLink.skill.ts         ← sendMenuLink — мәзір сілтемесін жіберу
│   ├── searchMenu.skill.ts       ← searchMenu — DLE мәзірін іздеу
│   ├── payment.skill.ts          ← getPaymentDetails / registerPaymentReceipt
│   ├── crm.skill.ts              ← updateCrmLead — CRM лидтерін жаңарту
│   ├── escalation.skill.ts       ← escalateToAdmin — админге эскалация
│   └── tavilySearch.skill.ts     ← searchWeb — веб іздеу
└── instructions.ts              ← 10 hard rule (барлық tool-дарға ортақ)
```

### Аргументтер

1. **LLM-driven tool selection:** VoltAgent model-ге tool тізімін береді, LLM өзі қай tool-ды қолдану керектігін шешеді. Ешқандай router конфигурациясы қажет емес.
2. **Изоляция:** Әр tool өз логикасын (параметрлер, execute функциясы) өзінде сақтайды. menuLink.skill.ts ешқашан escalation-ның логикасын білмейді.
3. **Тесттеу:** Әр tool-ды жеке unit-тесттеуге болады.
4. **Кеңейту:** Жаңа tool қосу үшін тек жаңа файл жазып, `skills/index.ts`-ке тіркеу керек.
5. **Zod validation:** Әр tool-дың параметрлері Zod схемасымен валидацияланады.

- **Trade-off:** LLM дұрыс tool-ды таңдамауы мүмкін (правильный инструментті таңдау үшін instructions.ts-те нақты нұсқаулар беріледі).

## Баламалар

### Балама A: Бір LLM call + router функциясы

**Артықшылықтары:** Қарапайым, бір файл.
**Кемшіліктері:** LLM әр жолы context-ті қайта жүктейді, изоляция жоқ, барлығы бір prompt-та.

### Балама B: Шарттар тізбегі (if-else chain)

**Артықшылықтары:** Толық бақылау, LLM қажет емес.
**Кемшіліктері:** Әр жаңа сценарий үшін код өзгерту, маштабталмайды.

## Салдары

- Tool саны біртіндеп өседі (қазір 7, максимум ~15)
- LLM-ге tool тізімі әр жолы беріледі (token usage-ға әсер етеді)
- Жаңа tool қосу өте оңай (1 файл + 1 импорт skills/index.ts-ке)

## Іске асыру

- **PR:** #15 (initial 15 problems)
- **Миграция:** жоқ (жаңа жүйе)
- **Monitoring:** tool usage метрикасы (қай tool қаншалықты қолданылады)
- **Tool list:** searchMenu, getPaymentDetails, registerPaymentReceipt, updateCrmLead, escalateToAdmin, sendMenuLink, searchWeb (7 tools)

---

_Author: BekzatAI EOS_
