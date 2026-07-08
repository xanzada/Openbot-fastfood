# Incident Report: INC-001

> **Title:** Redis Connection Drop (NocoDB cache miss cascade)
> **Күні:** 2026-03-15
> **Duration:** 14:23 — 14:35 UTC (12 минут)
> **Severity:** P1
> **Status:** Resolved
> **Incident Manager:** BekzatAI Engineering

---

## Timeline

| Time (UTC) | Event | Actor |
|------------|-------|-------|
| 14:23:00 | Redis connection lost (network glitch) | Система |
| 14:23:05 | Express server барлық Redis request-тері time out | Система |
| 14:23:10 | NocoDB кэші болмағандықтан, әрбір хабарлама NocoDB-ге тікелей request жасайды | Auto |
| 14:23:30 | NocoDB rate limit (100 req/min) асып кетті → 429 | NocoDB |
| 14:24:00 | Клиенттер жауап алмайды (NocoDB + Redis екеуі де fail) | Клиент |
| 14:25:00 | Alert: "Redis connection failed" | Alert system |
| 14:25:30 | Мониторинг жүйесі Redis-ті қайта қосуға тырысады | Auto |
| 14:27:00 | Redis қосылды (auto-reconnect) | Auto |
| 14:28:00 | NocoDB cache-і қайта жүктелді | Auto |
| 14:35:00 | Барлық tenant-тар қалпына келді | Auto |

## Summary

Redis желілік қосылымнан 30 секундқа ажырады. Express server-де Redis reconnect логикасы бар, бірақ Redis жоқ кезде NocoDB-ге тікелей request жасайды. NocoDB-нің rate limit-і 100 req/min, ал біздің сервер Redis жоқ кезде әрбір хабарлама үшін NocoDB-ге request жіберді. Rate limit асып кетті, клиенттер жауап алмады.

## Root Cause

Redis auto-reconnect жұмыс істейді, бірақ Redis жоқ кезде degrade логикасы NocoDB-ге тым көп request жібереді. NocoDB-нің rate limit-і 100 req/min, ал біздің сервер 200-300 req/min жіберді.

## Impact

- **Affected users:** Барлық 5 tenant (10+ клиент)
- **Affected systems:** Express server, NocoDB, Redis
- **Data loss:** Жоқ (хабарламалар жоғалған жоқ, бірақ кешікті)
- **Downtime:** 12 минут (толық) + 5 минут (partial)

## Resolution

Redis auto-reconnect 30 секундтан кейін қосылды. Кэш қайта жүктелді. Ешқандай қол әрекеті қажет болмады.

## Action Items

- [ x ] **Rate limiter:** NocoDB request-теріне rate limiter қосу (max 80 req/min)
- [ x ] **Backup кэш:** Redis жоқ кезде .json файлдан backup кэш пайдалану
- [ x ] **Degrade mode:** Redis жоқ кезде degrade mode-та жұмыс істеу (тек кэштелген деректермен)
- [ ] **Circuit breaker:** NocoDB 429 алса, 30s күту (backoff)

## Lessons Learned

### What went well
- Auto-reconnect жұмыс істеді (30s)
- Ешқандай деректер жоғалмады

### What went wrong
- Redis жоқ кезде degrade логикасы нашар (NocoDB-ге тым көп request)
- NocoDB rate limit-ін білмедік (100 req/min)
- Backup кэш жоқ

### Improvements
- "NocoDB-ге request жасамас бұрын, rate limit-ті тексеру" — middleware
- "Redis cluster" — single point of failure
- "Егер NocoDB де, Redis те жоқ болса, статикалық жауап беру" — static fallback

---

_Author: BekzatAI EOS_
