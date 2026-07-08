# Test Plan: WhatsApp Webhook Pipeline

> **Нұсқа:** 1.1
> **Author:** BekzatAI Engineering
> **Coverage goal:** 90% (agent layer), 85% (skills)

---

## Scope

- **Кіреді:** whatsappWebhook.route.ts, finalValidator.ts, instructions.ts, buildFactsPrompt.ts, preloadContext.ts, menuLink.skill.ts, searchMenu.skill.ts, payment.skill.ts, crm.skill.ts, escalation.skill.ts, tavilySearch.skill.ts, whatspro.client.ts, magicLink.ts, redis.service.ts, inboundGuard.service.ts
- **Кірмейді:** system.route.ts (/health, /kanban-webhook, /api/print_trigger), DLE integration (e2e-де тесттеледі)

## Test Cases

### Unit Tests

#### TC-001: finalValidator.ts — validatFinalText()

- **Input:** "Біздің мәзірде Пепперони 3000тг және Кола 500тг"
- **Expected:** `{ text: "...", hasLink: false, sentenceCount: 1 }`
- **Type:** unit

#### TC-002: finalValidator.ts — link detection

- **Input:** "Мына сілтемені басыңыз http://example.com"
- **Expected:** `{ hasLink: true }` + rejection
- **Type:** unit

#### TC-003: finalValidator.ts — sentence limit (4 sentences)

- **Input:** "Сөйлем 1. Сөйлем 2. Сөйлем 3. Сөйлем 4."
- **Expected:** rejection (max 3)
- **Type:** unit

#### TC-004: menuLink.skill.ts — match menu keyword

- **Input:** "мәзір", "меню", "ссылка"
- **Expected:** skill matches, returns menu response
- **Type:** unit

#### TC-005: menuLink.skill.ts — link already sent

- **Input:** "мәзір" (екінші рет, link_already_sent=true)
- **Expected:** "Сілтеме жіберілді" деген жауап, LLM шақырылмайды
- **Type:** unit

#### TC-006: whatspro.client.ts — URL extraction

- **Input:** body.message = "Мына сілтеме http://dodo.kz/menu"
- **Expected:** `{ hasLink: true, url: "http://dodo.kz/menu", text: "Мына сілтеме" }`
- **Type:** unit

#### TC-007: magicLink.ts — resend detection

- **Input:** "Сілтеме жіберіңізші" (екінші рет)
- **Expected:** resendDetected = true
- **Type:** unit

#### TC-008: preloadContext.ts — stale flag

- **Input:** Redis key `{tenant}:config` TTL expired, no fallback
- **Expected:** `staleFlags.isConfigFresh = false`
- **Type:** unit

### Integration Tests

#### TC-009: Webhook → Pre-LLM → LLM → Response

- **Input:** POST /webhook/whatsapp { message: "Сәлем" }
- **Expected:** 200 OK, LLM called, response sent
- **Type:** integration

#### TC-010: Webhook — spam block

- **Input:** 7 messages from same phone in 30s
- **Expected:** messages 1-6 OK, message 7 → «Боттан демалыс»
- **Type:** integration

#### TC-011: Webhook — меню bypass

- **Input:** POST /webhook/whatsapp { message: "мәзір" }
- **Expected:** menuLink.skill.ts handles, LLM not called
- **Type:** integration

## Edge Cases

- **HTML injection:** message = `<script>alert(1)</script>` → escaped
- **Empty message:** message = "" → ignore
- **Null fields:** token=null, instance=null → 400
- **Redis timeout:** Redis 2s timeout → degrade to NocoDB direct
- **LLM timeout:** OpenRouter 30s timeout → static fallback

## Mocks

- **Redis:** ioredis-mock
- **OpenRouter:** vi.fn() → mock responses
- **NocoDB:** vi.fn() → mock config + menu
- **WhatsPro:** vi.fn() → mock send

## Validation

- [ x ] Барлық test cases (11) жазылды
- [ x ] Unit tests: 8 cases
- [ x ] Integration tests: 3 cases
- [ ] Coverage: agent layer 90% (in progress)
- [ ] Coverage: skills 85% (in progress)

---

_Author: BekzatAI EOS_
