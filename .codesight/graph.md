# Dependency Graph

## Most Imported Files (change these carefully)

- `src\context\types.ts` — imported by **22** files
- `src\services\redis.service.ts` — imported by **16** files
- `src\services\platformConfig.service.ts` — imported by **13** files
- `src\services\dle.service.ts` — imported by **11** files
- `src\services\auditLogger.service.ts` — imported by **7** files
- `src\services\developerNotify.service.ts` — imported by **6** files
- `src\transport\whatspro.client.ts` — imported by **6** files
- `src\services\kitchenPolicy.service.ts` — imported by **5** files
- `src\services\llm.service.ts` — imported by **4** files
- `src\services\noteProvenance.service.ts` — imported by **3** files
- `src\utils\language.ts` — imported by **3** files
- `src\services\tenantAuth.service.ts` — imported by **3** files
- `src\services\operatorCase.service.ts` — imported by **3** files
- `src\agent\fastfoodAgent.ts` — imported by **2** files
- `src\context\buildFactsPrompt.ts` — imported by **2** files
- `src\skills\index.ts` — imported by **2** files
- `src\agent\instructions.ts` — imported by **2** files
- `src\agent\finalValidator.ts` — imported by **2** files
- `src\agent\persona.ts` — imported by **2** files
- `src\agent\toolPolicy.ts` — imported by **2** files

## Import Map (who imports what)

- `src\context\types.ts` ← `scripts\agentSmoke.ts`, `src\agent\fastfoodAgent.ts`, `src\agent\finalValidator.ts`, `src\agent\modelRouter.ts`, `src\agent\persona.ts` +17 more
- `src\services\redis.service.ts` ← `src\cron\statsCron.ts`, `src\routes\system.route.ts`, `src\server.ts`, `src\services\complaintRouting.service.ts`, `src\services\developerNotify.service.ts` +11 more
- `src\services\platformConfig.service.ts` ← `scripts\agentSmoke.ts`, `src\context\preloadContext.ts`, `src\controllers\kanban.ts`, `src\cron\statsCron.ts`, `src\routes\dleWebhook.route.ts` +8 more
- `src\services\dle.service.ts` ← `src\context\preloadContext.ts`, `src\controllers\kanban.ts`, `src\cron\statsCron.ts`, `src\routes\whatsappWebhook.route.ts`, `src\services\complaintRouting.service.ts` +6 more
- `src\services\auditLogger.service.ts` ← `src\controllers\kanban.ts`, `src\routes\dleWebhook.route.ts`, `src\services\complaintRouting.service.ts`, `src\services\customerOrder.service.ts`, `src\services\dle.service.ts` +2 more
- `src\services\developerNotify.service.ts` ← `src\controllers\kanban.ts`, `src\cron\statsCron.ts`, `src\routes\dleWebhook.route.ts`, `src\routes\system.route.ts`, `src\routes\whatsappWebhook.route.ts` +1 more
- `src\transport\whatspro.client.ts` ← `src\controllers\kanban.ts`, `src\routes\whatsappWebhook.route.ts`, `src\server.ts`, `src\services\complaintRouting.service.ts`, `src\services\developerNotify.service.ts` +1 more
- `src\services\kitchenPolicy.service.ts` ← `src\context\buildFactsPrompt.ts`, `src\routes\whatsappWebhook.route.ts`, `src\skills\menuLink.skill.ts`, `test\kitchenPolicy.test.ts`, `test\kitchenWaitLabel.test.ts`
- `src\services\llm.service.ts` ← `src\routes\whatsappWebhook.route.ts`, `src\services\diagnostics.service.ts`, `src\services\mediaAnalysis.service.ts`, `src\utils\language.ts`
- `src\services\noteProvenance.service.ts` ← `src\context\buildFactsPrompt.ts`, `src\routes\whatsappWebhook.route.ts`, `src\skills\searchMenu.skill.ts`
