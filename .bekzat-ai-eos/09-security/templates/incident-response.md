# Security Incident Response: SEC-001

> **Incident ID:** SEC-001
> **Күні:** 2026-06-10
> **Severity:** Critical
> **Status:** Resolved

---

## Detection

- **Detected by:** Rate limiter логтары (1000+ request / минута)
- **Detection метод:** Rate limit exceeded alert
- **Time:** 2026-06-10 14:23:00 UTC

## Summary

Бір клиенттің телефон нөмірінен (7700XXXXXXX) 3 минут ішінде 47 хабарлама келді. Жүйе rate limiter-ден өтіп, әрбір хабарлама LLM-ге жіберілді. Нәтижесінде OpenRouter API-ге 47 шақыру жасалды (шамамен $0.50), сервер CPU 90% көтерілді, басқа клиенттердің хабарламалары кешікті.

## Scope

- **Affected systems:** Express server, OpenRouter API, Redis
- **Affected users:** Барлық tenant (сервер slow)
- **Data involved:** Жоқ (деректер жоғалмады)

## Timeline

| Time (UTC) | Event |
|------------|-------|
| 14:20:00 | Хабарламалар басталды (spam) |
| 14:20:15 | Rate limiter 15/мин threshold-қа жетті |
| 14:21:00 | Rate limiter тек rate_limit = 429 қайтарды, бірақ spam mute жоқ |
| 14:22:00 | 30+ хабарлама, сервер CPU 90% |
| 14:23:00 | Alert: rate limit exceeded |
| 14:23:30 | Manual investigation басталды |
| 14:24:00 | Spam mute қолмен қосылды (phone blocklist) |
| 14:25:00 | Ретроспективті fix: spam mute TTL = 15 минут |

## Response

### Containment

- Қолмен blocklist-ке телефон нөмірін қосу
- Express server-ді перезагрузка (rate limiter counter-лерді тазалау)

### Eradication

- Spam detector жазу (inboundGuard.service.ts — guardIncomingMessage)
  - 6+ хабарлама тез арада → 15 минут mute (Redis TTL)
  - Mute кезінде "Сіз тым көп хабарлама жібердіңіз" деген жауап
- Rate limiter-ге sliding window қосу (Redis арқылы)

### Recovery

- 5 минуттан кейін сервер қалпына келді
- Барлық tenant-тар үшін сервис қалпына келтірілді

## Root Cause

Rate limiter тек rate_limit = 429 қайтарды, бірақ mute механизмі болмады. Клиент бірден қайталап request жібере берді. Rate limiter 429-ды қайтарса да, клиент (WhatsPro) 429-ды елемей, қайта жіберді.

## Lessons Learned

### What went well
- Alert жүйесі тез жұмыс істеді
- Қолмен блоктау тез жасалды (30s)

### What went wrong
- Rate limiter тек 429 қайтарады, mute жоқ
- Spam detector болмаған
- 429 жауапты WhatsPro елемеген

### Improvements
- [ x ] Spam detector жазу (6+ messages → 15 min mute)
- [ x ] Rate limiter-ге sliding window + mute қосу
- [ ] WhatsPro-мен келісім: 429-ды қабылдау және қайталамау
- [ ] Auto-block: егер 429 3 рет қайталанса, phone-ды автоматты mute

---

_Author: BekzatAI EOS_
