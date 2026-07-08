# Onboarding Checklist: Dodo Pizza Almaty

> **Restaurant ID:** restaurant_dodo_almaty
> **Басталды:** 2026-06-01
> **Аяқталды:** 2026-06-05
> **Onboarding Manager:** BekzatAI Engineering

---

## 1. Contract & Information

- [ x ] Ресторан атауы: Dodo Pizza Almaty
- [ x ] WhatsApp номері: 77001234567 (WhatsPro instance: dodo_almaty)
- [ x ] Мекен-жайы: Алматы, Абай 123
- [ x ] Жұмыс уақыты: 10:00 — 23:00 (күн сайын)
- [ x ] Байланыс тұлғасы: Асхат (менеджер)

## 2. Menu Setup

- [ x ] NocoDB-ге импорт: 23 тағам, 4 категория
- [ x ] Категориялар дұрыс: Пицца (12), Суши (5), Салат (3), Напитки (3)
- [ x ] Бағалар дұрыс: 500тг — 4500тг
- [ x ] Сипаттамалар: Әр тағамда сипаттама бар
- [ x ] Фото: Жоқ (тек атау + сипаттама)

## 3. System Configuration

- [ x ] NocoDB config record created: `dodo_almaty` instance
- [ x ] Token generated: `tenant_dodo_almaty_abc123`
- [ x ] Redis keys initialized: `dodo_almaty:config`, `dodo_almaty:shpor`
- [ x ] Tenant secret set: `webhook_secret_def456`

## 4. WhatsApp Testing

- [ x ] Приветственное сообщение: "Сәлем! Мен Dodo Pizza ботымын..."
- [ x ] Меню запрос: "Мәзірді көрсет" → тізім жіберілді
- [ x ] Заказ тест: "1 Пепперони" → "Заказ функциясы әзірше жоқ" (v1.2)
- [ x ] Ошибки обработаны: Баға сұрау → дұрыс жауап

## 5. LLM Testing

- [ x ] Instructions apply correctly: 3 сөйлемнен аспады
- [ x ] Facts build correctly: Тек Dodo Pizza мәзірі
- [ x ] No hallucinations: Барлық тағамдар нақты мәзірден
- [ x ] Response in Kazakh: "Біздің мәзірде: Пепперони 3000тг..."

## 6. Go Live

- [ x ] Ресторан уведомлен: WhatsApp арқылы хабарланды
- [ x ] Monitoring active: Grafana dashboard + alerts
- [ x ] Alert thresholds set: LLM p95 > 5s, error rate > 3%
- [ x ] Чек-лист подписан: Асхат (менеджер)

## Notes

Ресторанда арнайы талап: "суши" категориясын тек кешкі уақытта (18:00-23:00) көрсету. Бұл үшін `preloadContext.ts`-те time-based filter қосу керек. (TODO: v1.3)

---

_Author: BekzatAI EOS_
