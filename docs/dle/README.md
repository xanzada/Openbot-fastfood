# Legacy DLE Reference

> Бұл файл миграция алдындағы мінез-құлықты түсіндіру үшін сақталған. OpenBot
> production runtime енді `api_bot.php` шақырмайды: барлық бизнес командалар
> `https://hub.alemi.kz/v1/integrations/bot/*` HMAC API арқылы орындалады.

## DLE api_bot.php

DataLife Engine (DLE) — ресторанның негізгі CMS. api_bot.php — Node.js бот пен DLE арасындағы шлюз.

### Аутентификация

```php
$secret_token = SELECT setting_value FROM dle_spa_settings WHERE setting_key = 'secret_key'
$received_token = $_POST['token']
```

Екі токен сәйкес келмесе → 403 Forbidden.

### API Endpoints (7 action)

#### 1. get_runtime_status
Асхананың ағымдағы статусын қайтарады.

**Cache:** 5s Redis + 10min backup

**Қайтарады:**
- `settings` — барлық spa_settings
- `kitchen_status` — JSON: { wait_time, is_emergency, delivery, pickup, reset_at, payment_details }
- `within_work_hours` — work_start/work_end бойынша
- `is_accepting_orders` — !emergency && within_hours && (delivery || pickup)
- `delivery`, `pickup` — boolean
- `wait_time` — минут
- `payment_details` — нормализованный массив
- `reset_at` — авто-скид уақыты (timestamp)

**Auto-reset:** егер `reset_at` өтіп кетсе, kitchen_status бастапқы күйге қайтарылады.

#### 2. check_status (get_order_context)
Клиенттің актив заказын қайтарады.

**Cache:** 24h Redis

**Phone matching:** 7/8 префикстері, 10/11 цифр, дайджест форматы

**Логика:**
1. Телефон бойынша spa_orders іздеу
2. Актив статус: pending, paid, delivery (ешқашан completed/cancelled)
3. Егер статус inactive → null қайтарады

#### 3. get_menu_context
Мәзірді тіл бойынша қайтарады.

**Cache:** 5min Redis + 1d backup

**Тілдер:** kz (name_kz, description_kz, composition_kz) немесе ru

**Фильтр:** is_active = 1

#### 4. update_crm
CRM лид деректерін жаңартады.

**Таблица:** dle_spa_bot_leads

**Өрістер:** phone, interest, sales_stage, psycho_analysis

**UPSERT:** INSERT немесе UPDATE (phone бойынша)

#### 5. add_payment_comment
Чек төлемін тіркейді (статус өзгермейді).

**Cross-validation:** егер order_id келмесе, телефон + сумма бойынша іздеу

**Қауіпсіздік:** inactive status тексеру

#### 6. get_today_crm
Күнделікті CRM деректерін қайтарады (cron үшін).

**DATE_RANGE:** last_updated BETWEEN {date} 00:00:00 AND 23:59:59

#### 7. save_daily_analytics
Күнделікті BI аналитиканы сақтайды.

**Таблица:** dle_spa_ai_analytics

**ON DUPLICATE KEY UPDATE** — қайталанудан қорғау

**AI provider error filter:** Gemini қателері critical_alert-қа жазбайды

### Қосымша: spa-internet-magazin.xml

DLE плагин — SPA интернет-магазин. 3 негізгі модуль:

1. **spa_api.php** — клиенттік API (get_menu, get_bonuses, checkout, update_license)
   - Cookie-based аутентификация
   - Checkout: kitchen_status, is_emergency, wait_time тексеру
   - Бонустар: welcome_bonus (default 1000), max_bonus_pay (30%)
   - n8n webhook: жаңа заказ кезінде

2. **spa_admin_gate.php** — админ аутентификация шлюзі
   - Барлық админ беттерге кіруді басқарады
   - Қауіпсіз redirect

3. **spa_manager.php** — мәзір менеджері
   - Категория/тауарларды басқару
   - Суреттерді WebP-ге конвертациялау (max 1200px)
   - Cache тазалау
   - Dark mode

### DNS Safety

Node.js жағында SSRF қорғаныс:
- normalizePublicDomain() — DNS lookup, private IP блок
- custom http/https agent — lookup функциясы
- Барлық DLE API шақырулары осы агент арқылы
