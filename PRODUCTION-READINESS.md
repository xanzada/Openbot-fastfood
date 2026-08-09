# OpenBot production readiness

Validated: 2026-07-24

## Verified

- 19/19 hermetic application tests passed.
- 46/46 TypeScript source files passed syntax compilation.
- `dist/` rebuilt from the current `src/` tree.
- Docker Compose YAML validated.
- Receipt delivery requires strict Alemi `order-documents` acknowledgement and never auto-confirms payment.
- WhatsPro outbound delivery requires `success: true`; history and inbound completion occur only after acknowledgment.
- Shift-note deletion uses exact `instanceId + noteId` provenance, not fuzzy history matching.
- Payment details are read only from live site kitchen settings `payment_details`.
- Operator handoff cases are prepared in Redis for WhatsPro Chat.
- Legacy `api_bot.php` files are retained only as migration references and are never called at runtime.

## Required production environment

- Fill every required value from `.env.example`.
- Keep `DLE_WEBHOOK_AUTH_REQUIRED=true`; Alemi events use the restaurant Secret Key and fail closed.
- OpenBot and WhatsPro must use the same Redis service/network for Chat handoff keys.
- Dokploy/Docker must have registry access during the first image build so `npm ci` can install the locked dependencies.
- Run the deployment health check at `/health` after launch.
