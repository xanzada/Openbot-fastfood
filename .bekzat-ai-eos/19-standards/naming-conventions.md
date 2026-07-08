# Naming Conventions

> Нұсқа: 1.0
> Статус: Approved

---

## Файлдар

| Түрі | Формат | Мысал |
|------|--------|-------|
| Service | `kebab-case.service.ts` | `inbound-guard.service.ts` |
| Route | `kebab-case.route.ts` | `whatsapp-webhook.route.ts` |
| Skill | `kebab-case.skill.ts` | `search-menu.skill.ts` |
| Util | `kebab-case.ts` | `magic-link.ts` |
| Type | `kebab-case.types.ts` | `context.types.ts` |
| Test | `*.test.ts` | `final-validator.test.ts` |
| Config | `kebab-case.config.ts` | `redis.config.ts` |

## Айнымалылар

```typescript
// camelCase — барлық айнымалылар
const instanceId = "prestige";
const safeDomain = await normalizePublicDomain(domain);
const isAcceptingOrders = runtimeStatus.is_accepting_orders;

// Boolean префикстері: is, has, should, can, did
const isActive = true;
const hasLink = true;
const shouldRetry = false;
```

## Функциялар

```typescript
// camelCase — префикспен
// get/put/set/delete — деректер операциялары
// create/build — объект құру
// normalize/transform — формат өзгерту
// validate/guard — тексеру
// handle/process — өңдеу

export async function getRuntimeStatus(instanceId: string) {}
export function validateFinalText(rawText: string, ctx: FastFoodContext) {}
export async function processWhatsAppWebhook(body: any) {}
```

## Класстар (егер қолданылса)

```typescript
// PascalCase
export class MenuController {}
export class InboundGuardService {}
```

## TypeScript Типтері

```typescript
// Interface — PascalCase
export interface FastFoodContext {}
export interface GuardResult {}

// Type — PascalCase
export type Language = "kk" | "ru";
export type AgentResult = { text: string; hasLink: boolean };

// Enum — PascalCase
export enum OrderStatus {
  Pending = "pending",
  Paid = "paid",
  Completed = "completed",
}
```

## Redis Key Patterns

```
{entity}:{instanceId}:{identifier}
Мысал: history:prestige:77770000000
        shift_note:prestige:note_123
        runtime_status:prestige
```

## Environment Variables

```
UPPER_SNAKE_CASE
Мысал: OPENROUTER_API_KEY
        REDIS_URL
        NOCODB_TABLE_ID
```

## React/UI компоненттері (future use)

```
PascalCase файл атауы
PascalCase компонент атауы
Мысал: RestaurantCard.tsx → <RestaurantCard />
```

---

_Author: BekzatAI EOS_
