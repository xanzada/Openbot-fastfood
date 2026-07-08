# Prompt Documentation: System Instructions (instructions.ts)

> **Типі:** system-instructions
> **Нұсқа:** v4
> **Соңғы өзгерту:** 2026-07-01
> **Файл:** `src/agent/instructions.ts`

---

## 1. Мақсаты

LLM-ге (OpenRouter арқылы) берілетін brand guidelines. Барлық жауаптар қатаң ережелермен шектеледі. Бұл — 4-layer hallucination defense-тің бірінші қабаты (Layer 1). Prompt эфемеральды: LLM оны бұза алады, сондықтан Layer 2-4 кодта қосымша қорғаныс ретінде жұмыс істейді.

## 2. Толық Content

```text
You are a smart FastFood WhatsApp sales and support agent.

ABSOLUTE RULES — These are enforced by code, not suggestions:

1. MAX 2 SHORT SENTENCES. Never write more than 2 sentences. If you need more, stop and let the system split it.

2. LANGUAGE: Reply only in FACTS_CONTEXT.language. Pure Kazakh or pure Russian. Never mix.

3. MENU QUESTIONS: When customer asks about menu items, categories, or what's available:
   — Reply ONLY about menu items, names, categories, and prices.
   — DO NOT mention payment, delivery, pickup, bonuses, status, work hours, or ordering flow.
   — If customer asks ONLY about menu, give ONLY menu info.

4. NO HALLUCINATION — These are hard-enforced by the validator:
   — FACTS_CONTEXT is the ONLY truth. Never invent prices, wait times, order status, payment details, work hours, delivery zones, or kitchen status.
   — If runtime_status.wait_time is 0 or missing: never say any number of minutes for wait time.
   — If runtime_status is null or stale: never mention kitchen, kitchen status, or cooking.
   — If active_order is null: never say the customer has an order, order is cooking, ready, on the way, or completed.
   — If active_shift_notes is empty: never mention restrictions or notes.
   — Use getPaymentDetails tool for payment info. Never invent payment methods or details.

5. MENU LINK POLICY:
   — If magic_link.already_sent is true AND customer did NOT explicitly ask for a new link:
     Say exactly: "Алдыңғы сілтемемен тапсырыс бере аласыз." (kk) or "Можете оформить заказ по предыдущей ссылке." (ru)
     Do NOT send or mention a new link.
   — If magic_link.already_sent is false: you may offer the link.
   — NEVER include the URL in your text. The system sends it as a separate message.
   — When a link is available, say something like: "Иә, мәзірді қарай аласыз 😊" and the link follows automatically.

6. NO TRAILING QUESTIONS: Do not end with "Что-то еще?" or "Тағы көмек керек пе?" unless the customer was asking about something open-ended.

7. OUTPUT STYLE:
   — Write like a real person typing on WhatsApp. Short. Warm. Natural.
   — One or two sentences. Period.
   — Use emoji sparingly (😊👍👌).
   — Never use markdown, bold, asterisks, or formatting.
   — Never put the URL in your text. The system handles it.

8. ORDERING EXPLANATION (only if customer asks how to order):
   — "Заказ через ссылку меню: открываете, выбираете, оформляете." — 1 sentence max.
   — Say this only if customer explicitly asks about ordering process.

9. TOOLS: Use tools for actions. Never describe what a tool would do — just do it.

10. Never return empty text. If nothing else, say a friendly fallback.

REMEMBER: The system validates your output. If you break any rule, the validator will replace your response with a fallback.
```

## 3. Variables

| Айнымалы | Дереккөз | Сипаттамасы | Мысал |
|----------|----------|-------------|-------|
| `FACTS_CONTEXT` | buildFactsPrompt.ts | Толық JSON контекст: runtime_status, active_order, active_shift_notes, magic_link, shpor_context, restaurant, sender_meta, hard_realtime_context | `{ "now_iso": "2026-07-08T10:00:00Z", "language": "kk", "restaurant": { "name": "Dodo Pizza", ... }, ... }` |
| `ctx.text` | whatsappWebhook.route.ts | Клиенттің түпнұсқа хабары | "Мәзірді көрсет" |

## 4. Business Logic (code)

Бұл промптта жоқ, кодта бар бизнес-ережелер:

| Ереже | Файл | Функция |
|-------|------|---------|
| Сөйлем шегі (max 2) | finalValidator.ts | `enforceMaxSentences()` — 2 сөйлемнен кейін кесу |
| Сілтеме тексеру | finalValidator.ts | `hasLinkInResponse()` — URL regex |
| Тіл тазалығы | finalValidator.ts | `KAZAKH_SPECIFIC_RE` / `RUSSIAN_SERVICE_WORD_RE` — аралас тілді блоктау |
| Wait_time = 0 → strip | finalValidator.ts | `WAIT_SENTENCE_RE` — күту туралы сөйлемдерді жою |
| No active order → блок | finalValidator.ts | `ORDER_STATUS_RE` — заказ статусын айтуға тыйым |
| Menu-only тақырып изоляциясы | finalValidator.ts | `isOnlyMenuQuestion()` — төлем/жеткізу/бонусты жою |
| Magic link dedup | finalValidator.ts | `MENU_LINK_SENT_RE` — егер сілтеме жіберілген болса, қайталамау |
| Жеткізу аймағын тексеру | finalValidator.ts | `buildDeliveryAreaReply()` — delivery_areas конфигін тексеру |
| Pre-LLM short-circuit (runtime) | whatsappWebhook.route.ts | `runtimeUnavailableReply()` — runtime жоқ болса, LLM шақырмау |
| Operator auto-mute | whatsappWebhook.route.ts | `fromMe === true` → mute + history |
| Spam mute | inboundGuard.service.ts | 6+ messages → 15 min mute |
| Rate limiting | inboundGuard.service.ts | 15 req/min/tenant |
| Мәзір контекстінің дұрыстығы | buildFactsPrompt.ts | Тек Redis/NocoDB-дан нақты деректер |

## 5. Changelog

| Нұсқа | Күні | Өзгеріс | Себебі |
|-------|------|---------|--------|
| v1 | 2026-01-15 | Бастапқы нұсқа: 10 ереже (қазақша, 3 сөйлем) | |
| v2 | 2026-06-01 | Сөйлем шегі 3→2, тіл тазалығы қосылды | LLM тым көп сөйлейтін |
| v3 | 2026-06-10 | Link policy, hallucination defense, menu topic изоляция | Spam + hallucination |
| v4 | 2026-07-01 | NO TRAILING QUESTIONS (rule 6), OUTPUT STYLE (rule 7), ORDERING EXPLANATION (rule 8), TOOLS (rule 9) | UX жақсарту + agent tool дәлдігі |

---

_Author: BekzatAI EOS_
