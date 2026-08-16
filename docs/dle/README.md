# Alemi Hub integration

OpenBot production runtime connects directly to `https://hub.alemi.kz` and does
not execute or call a PHP bot adapter. The retired `api_bot.php` bridge existed
before the Alemi Hub migration and is no longer part of this repository.

## Tenant credentials

Every restaurant is resolved by its own instance ID. Its Secret Key comes from
that restaurant's WhatsPro runtime config (`alemi_secret`) or, during a
controlled migration, from the exact matching entry in
`ALEMI_TENANT_SECRETS_JSON`. A process-wide restaurant secret is intentionally
unsupported: requests without an exact tenant identity or tenant key fail
closed.

`ALEMI_API_URL=https://hub.alemi.kz` is the only global Alemi connection
default. It is an endpoint, not a credential.

## Direct Hub commands

OpenBot signs the exact request body with HMAC and sends these commands through
`/v1/integrations/bot/commands`:

- `runtime.status.get`
- `catalog.context.get`
- `order.context.get`
- `order.status.get`
- `crm.lead.upsert`
- `crm.today.get`
- `analytics.daily.upsert`
- `customer.access_link.issue`
- `order.payment_receipt.analyzed`

Receipt documents and print results use their dedicated signed Hub endpoints.
Alemi-to-OpenBot events enter through `/kanban-webhook` and are authenticated
with the same restaurant-specific Alemi key.

The old action names still appear inside the TypeScript compatibility mapper so
the internal service contract can evolve safely; they are mapped directly to
the Hub commands above and never imply a PHP network hop.
