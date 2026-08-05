# Dependency Graph

## Most Imported Files (change these carefully)

- `src\context\types.ts` — imported by **24** files
- `src\services\redis.service.ts` — imported by **22** files
- `src\services\platformConfig.service.ts` — imported by **11** files
- `src\services\dle.service.ts` — imported by **10** files
- `src\services\llm.service.ts` — imported by **8** files
- `src\context\buildFactsPrompt.ts` — imported by **8** files
- `src\services\auditLogger.service.ts` — imported by **7** files
- `src\services\developerNotify.service.ts` — imported by **6** files
- `src\transport\whatspro.client.ts` — imported by **6** files
- `src\agent\instructions.ts` — imported by **5** files
- `src\utils\orderIntent.ts` — imported by **5** files
- `src\services\customerOrder.service.ts` — imported by **5** files
- `src\services\agentThinking.service.ts` — imported by **4** files
- `src\agent\finalValidator.ts` — imported by **4** files
- `src\services\noteProvenance.service.ts` — imported by **4** files
- `src\services\kitchenPolicy.service.ts` — imported by **4** files
- `src\services\operatorCase.service.ts` — imported by **4** files
- `src\agent\toolPolicy.ts` — imported by **3** files
- `src\services\paymentPolicy.service.ts` — imported by **3** files
- `src\utils\language.ts` — imported by **3** files

## Import Map (who imports what)

- `src\context\types.ts` ← `src\agent\fastfoodAgent.ts`, `src\agent\finalValidator.ts`, `src\agent\modelRouter.ts`, `src\agent\persona.ts`, `src\agent\toolPolicy.ts` +19 more
- `src\services\redis.service.ts` ← `src\cron\statsCron.ts`, `src\routes\system.route.ts`, `src\server.ts`, `src\services\complaintRouting.service.ts`, `src\services\customerMemory.service.ts` +17 more
- `src\services\platformConfig.service.ts` ← `src\context\preloadContext.ts`, `src\controllers\kanban.ts`, `src\cron\statsCron.ts`, `src\routes\dleWebhook.route.ts`, `src\routes\system.route.ts` +6 more
- `src\services\dle.service.ts` ← `src\context\preloadContext.ts`, `src\controllers\kanban.ts`, `src\cron\statsCron.ts`, `src\routes\whatsappWebhook.route.ts`, `src\services\customerOrder.service.ts` +5 more
- `src\services\llm.service.ts` ← `scripts\judgeSmoke.ts`, `src\routes\whatsappWebhook.route.ts`, `src\services\agentThinking.service.ts`, `src\services\bufferBrain.service.ts`, `src\services\customerMemory.service.ts` +3 more
- `src\context\buildFactsPrompt.ts` ← `src\agent\fastfoodAgent.ts`, `test\conversationBrain.test.ts`, `test\internalConfidentiality.test.ts`, `test\mandatoryConstraints.test.ts`, `test\menuSnapshotContext.test.ts` +3 more
- `src\services\auditLogger.service.ts` ← `src\controllers\kanban.ts`, `src\routes\dleWebhook.route.ts`, `src\services\complaintRouting.service.ts`, `src\services\customerOrder.service.ts`, `src\services\dle.service.ts` +2 more
- `src\services\developerNotify.service.ts` ← `src\controllers\kanban.ts`, `src\cron\statsCron.ts`, `src\routes\dleWebhook.route.ts`, `src\routes\system.route.ts`, `src\routes\whatsappWebhook.route.ts` +1 more
- `src\transport\whatspro.client.ts` ← `src\controllers\kanban.ts`, `src\routes\whatsappWebhook.route.ts`, `src\server.ts`, `src\services\developerNotify.service.ts`, `src\services\diagnostics.service.ts` +1 more
- `src\agent\instructions.ts` ← `src\agent\fastfoodAgent.ts`, `test\conversationBrain.test.ts`, `test\internalConfidentiality.test.ts`, `test\mandatoryConstraints.test.ts`, `test\paymentPolicy.test.ts`
