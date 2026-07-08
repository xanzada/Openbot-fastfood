# 19. Code Standards & Conventions

> Мақсаты: Бүкіл код базасында біркелкі стиль мен сапаны қамтамасыз ету.

## Мазмұны

- [Coding Standards](./coding-standards.md) — Типтер, именование, функция құрылымы
- [Naming Conventions](./naming-conventions.md) — Файл, айнымалы, класс, функция аттары
- [Review Checklist](./review-checklist.md) — Code review тексеру тізімі

## Жалпы ережелер

1. **TypeScript** — strict mode міндетті
2. **ES2022** — target = ES2022, module = NodeNext
3. **No `any`** — ерекше жағдайларды қоспағанда
4. **No `console.log`** — логер арқылы (шұғыл debugging үшін ғана)
5. **No circular dependencies** — Dependency cruiser тексеруі
6. **No secrets in code** — .env ғана
7. **No commented code** — Git history бар
8. **No TODO/FIXME** — Issue арқылы
9. **JSDoc** — тек API/public функциялар үшін
10. **Error handling** — Әрбір сыртқы сұрауда try/catch

## Tooling

- TypeScript 5.9 strict
- ESLint + Prettier
- Dependency cruiser (circular dep тексеру)
- tsx (dev mode)
- vitest (тесттер)
