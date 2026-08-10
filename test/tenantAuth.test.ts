import test from "node:test";
import assert from "node:assert/strict";
import {
  assertTenantSecret,
  getIncomingTenantSecret,
  getTenantSecret,
} from "../src/services/tenantAuth.service.js";
import { isDleWebhookAuthRequired } from "../src/routes/dleWebhook.route.js";

function withEnv(values: Record<string, string | undefined>, run: () => void) {
  const before = Object.fromEntries(Object.keys(values).map((key) => [key, process.env[key]]));
  try {
    for (const [key, value] of Object.entries(values)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
    run();
  } finally {
    for (const [key, value] of Object.entries(before)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }
}

test("kanban auth accepts the site's scalar ?token= using timing-safe comparison", () => {
  const req = { headers: {}, body: {}, query: { token: "alemi-test-secret" } };
  assert.equal(getIncomingTenantSecret(req), "alemi-test-secret");
  assert.doesNotThrow(() => assertTenantSecret(req, { alemi_secret: "alemi-test-secret" }, "kanban"));
});

test("kanban expected secret is limited to the Alemi and legacy kanban keys", () => {
  assert.equal(getTenantSecret({ alemi_secret: "a" }, "kanban"), "a");
  assert.equal(getTenantSecret({ secret_key: "b" }, "kanban"), "");
  assert.equal(getTenantSecret({ crm_secret_token: "c" }, "kanban"), "");
  assert.throws(
    () => assertTenantSecret(
      { headers: {}, body: {}, query: { token: "unrelated-crm-token" } },
      { alemi_secret: "alemi", crm_secret_token: "unrelated-crm-token", webhook_secret: "wa" },
      "kanban",
    ),
    (error: any) => error?.message === "INVALID_TENANT_SECRET" && error?.statusCode === 403,
  );
  assert.doesNotThrow(() => assertTenantSecret(
    { headers: {}, body: {}, query: { token: "alemi" } },
    { kanban_secret: "legacy", alemi_secret: "alemi" },
    "kanban",
  ));
});

test("kanban auth accepts the deployment Alemi secret only for its named instance", () => {
  withEnv({ ALEMI_SECRET: "deployment-alemi-secret", ALEMI_INSTANCE: "legacy_restaurant" }, () => {
    assert.doesNotThrow(() => assertTenantSecret(
      { body: { instance: "legacy_restaurant" }, query: { token: "deployment-alemi-secret" } },
      {},
      "kanban",
    ));
    assert.throws(
      () => assertTenantSecret(
        { body: { instance: "someone_elses_tenant" }, query: { token: "deployment-alemi-secret" } },
        {},
        "kanban",
      ),
      (error: any) => error?.message === "TENANT_SECRET_NOT_CONFIGURED" && error?.statusCode === 500,
    );
  });
  withEnv({ ALEMI_SECRET: "deployment-alemi-secret", ALEMI_INSTANCE: undefined }, () => {
    assert.throws(
      () => assertTenantSecret({ body: {}, query: { token: "deployment-alemi-secret" } }, {}, "kanban"),
      (error: any) => error?.message === "TENANT_SECRET_NOT_CONFIGURED" && error?.statusCode === 500,
    );
  });
});

test("kanban auth resolves the per-tenant Alemi secret after instance aliasing", () => {
  withEnv({
    ALEMI_TENANT_SECRETS_JSON: JSON.stringify({
      prestige: { instance: "storefront_test_fe6d775", secret: "crazy-tenant-secret" },
    }),
    ALEMI_SECRET: undefined,
  }, () => {
    assert.doesNotThrow(() => assertTenantSecret({
      body: { instance: "prestige" },
      query: { token: "crazy-tenant-secret" },
    }, {}, "kanban"));
  });
});

test("query token rejects arrays and objects instead of coercing them", () => {
  assert.equal(getIncomingTenantSecret({ headers: {}, body: {}, query: { token: ["one", "two"] } }), "");
  assert.equal(getIncomingTenantSecret({ headers: {}, body: {}, query: { token: { nested: true } } }), "");
});

test("missing and invalid tenant secrets fail closed without echoing credentials", () => {
  assert.throws(
    () => assertTenantSecret({ headers: {}, body: {}, query: {} }, {}, "kanban"),
    (error: any) => error?.message === "TENANT_SECRET_NOT_CONFIGURED" && error?.statusCode === 500,
  );
  assert.throws(
    () => assertTenantSecret({ headers: {}, body: {}, query: { token: "wrong" } }, { alemi_secret: "expected" }, "kanban"),
    (error: any) => error?.message === "INVALID_TENANT_SECRET" && error?.statusCode === 403,
  );
});

test("DLE webhook auth defaults to fail-closed in production and can be explicitly disabled in tests", () => {
  withEnv({ NODE_ENV: "production", DLE_WEBHOOK_AUTH_REQUIRED: undefined }, () => {
    assert.equal(isDleWebhookAuthRequired(), true);
  });
  withEnv({ NODE_ENV: "production", DLE_WEBHOOK_AUTH_REQUIRED: "false" }, () => {
    assert.equal(isDleWebhookAuthRequired(), false);
  });
  withEnv({ NODE_ENV: "test", DLE_WEBHOOK_AUTH_REQUIRED: undefined }, () => {
    assert.equal(isDleWebhookAuthRequired(), false);
  });
});
