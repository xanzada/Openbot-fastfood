# TypeScript

> **Стандарт:** strict mode, ES modules, Biome formatting.

## Config

```jsonc
// tsconfig.json
{
  "compilerOptions": {
    "target": "ES2022",
    "module": "NodeNext",
    "moduleResolution": "NodeNext",
    "strict": true,
    "noUncheckedIndexedAccess": true,
    "exactOptionalPropertyTypes": true,
    "noUnusedLocals": true,
    "noUnusedParameters": true
  }
}
```

## Patterns

| Pattern | Code |
|---------|------|
| Types first, then implementation | `type Config = {...}; function load(): Config` |
| Discriminated unions for state | `type State = { status: 'loading' } \| { status: 'loaded', data: T }` |
| Branded types for IDs | `type InstanceId = string & { __brand: 'Instance' }` |
| Never throw — return Result | `type Result<T, E> = { ok: true, value: T } \| { ok: false, error: E }` |

## Conventions

- **camelCase** — variables, functions, methods
- **PascalCase** — types, interfaces, classes, enums
- **kebab-case** — file names (`feature-flag.service.ts`)
- `.ts` extension for source, `.test.ts` for tests
- ES module imports with `.js` extension: `import { foo } from './bar.js'`
- No `any` — use `unknown` + type guard
- No `null` — use `undefined` or `Option<T>`

## Async

```typescript
// Prefer async/await over raw promises
try { await operation(); }
catch (err) { handleError(err); }

// All external calls: timeout wrapper
await withTimeout(redis.get(key), 2000);
```

## Files

- One export per file (default or named, not both)
- Max 200 lines per file
- Index file re-exports public API only

---

_See: `19-standards/01-coding-standards.md`_
