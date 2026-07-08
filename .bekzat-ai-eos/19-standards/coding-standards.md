# Coding Standards

> Нұсқа: 1.0
> Статус: Approved

---

## 1. TypeScript Конфигурация

```json
{
  "compilerOptions": {
    "strict": true,
    "noUncheckedIndexedAccess": true,
    "exactOptionalPropertyTypes": true,
    "noImplicitOverride": true
  }
}
```

## 2. Imports

```typescript
// Дұрыс
import { RedisClient } from "../services/redis.service.js";
import type { FastFoodContext } from "../context/types.js";

// Бұрыс
import redisService from "../services/redis";

// .js extension міндетті (NodeNext)
```

## 3. Функция құрылымы

```typescript
// Дұрыс
export async function getRuntimeStatus(
  instanceId: string,
  domain: string,
  options?: { forceFresh?: boolean }
): Promise<RuntimeStatus | null> {
  // 1. Guard clause
  if (!domain) return null;

  // 2. Cache check
  const cached = await getJsonCache(key);
  if (cached && !options?.forceFresh) return cached;

  // 3. Main logic
  try {
    const data = await apiBot(domain, payload);
    return normalizeResponse(data);
  } catch (error) {
    // 4. Error handling
    return null;
  }
}
```

## 4. Error Handling

```typescript
// Дұрыс - typed error
try {
  await riskyOperation();
} catch (error) {
  if (error instanceof ApiError) handleApiError(error);
  if (error instanceof NetworkError) handleNetworkError(error);
  throw error; // тек қайта лактыра алатын жағдайда
}

// Бұрыс - silent catch
try { ... } catch { /* ештеңе */ }
```

## 5. Async Patterns

```typescript
// Дұрыс - параллель
const [config, lang, history] = await Promise.all([
  fetchConfig(),
  fetchLang(),
  fetchHistory(),
]);

// Дұрыс - бірінен кейін бірі
await saveToHistory();
await sendMessage();

// Бұрыс - тізбекті параллельдің орнына
const config = await fetchConfig();
const lang = await fetchLang(); // config-ке тәуелді емес
```

## 6. Type Definitions

```typescript
// Дұрыс - interface
export interface FastFoodContext {
  instanceId: string;
  phone: string;
  text: string;
  // ...
}

// Дұрыс - union type
export type Language = "kk" | "ru";

// Бұрыс - any
// const ctx: any = ...
```

## 7. Null/Undefined Handling

```typescript
// Дұрыс
const phone = normalizePhone(input.phone);
if (!phone) return null;

// Дұрыс
const name = config.name ?? "Белгісіз";

// Бұрыс
if (phone == null) ...
```

## 8. Testing

```typescript
// Тест атауы: метод_шарт_күтілетіннәтиже
describe("validateFinalText", () => {
  it("enforceMaxSentences_moreThan2_returns2Sentences", () => {
    // ...
  });
});
```

---

_Author: BekzatAI EOS_
