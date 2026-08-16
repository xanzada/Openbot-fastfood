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

function captureInfo(run: () => void): string[] {
  const lines: string[] = [];
  const before = console.info;
  console.info = (...args: unknown[]) => { lines.push(args.map(String).join(" ")); };
  try {
    run();
  } finally {
    console.info = before;
  }
  return lines;
}

const RETIRED_MARK = "retired_kanban_secret";

test("kanban expected secret is the Alemi key only; the retired kanban_secret is rejected", () => {
  assert.equal(getTenantSecret({ alemi_secret: "a" }, "kanban"), "a");
  assert.equal(getTenantSecret({ kanban_secret: "legacy" }, "kanban"), "");
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

test("the retired kanban_secret fails like any wrong token and logs one instance-only line", () => {
  const config = { kanban_secret: "legacy-kanban-token", alemi_secret: "alemi", alemi_instance: "storefront_test_fe6d775" };
  const retired = captureInfo(() => {
    assert.throws(
      () => assertTenantSecret({ headers: {}, body: {}, query: { token: "legacy-kanban-token" } }, config, "kanban"),
      (error: any) => error?.message === "INVALID_TENANT_SECRET" && error?.statusCode === 403,
    );
  });
  const flagged = retired.filter((line) => line.includes(RETIRED_MARK));
  assert.equal(flagged.length, 1);
  assert.match(flagged[0], /still using the retired kanban_secret token/);
  assert.match(flagged[0], /storefront_test_fe6d775/);
  assert.ok(!flagged[0].includes("legacy-kanban-token"), "log line must never contain the token value");

  // Any other wrong token must not raise the retired-token flag.
  const other = captureInfo(() => {
    assert.throws(
      () => assertTenantSecret({ headers: {}, body: {}, query: { token: "some-other-wrong" } }, config, "kanban"),
      (error: any) => error?.message === "INVALID_TENANT_SECRET" && error?.statusCode === 403,
    );
  });
  assert.equal(other.filter((line) => line.includes(RETIRED_MARK)).length, 0);

  // A correct Alemi token must not raise it either.
  const accepted = captureInfo(() => {
    assert.doesNotThrow(() => assertTenantSecret({ headers: {}, body: {}, query: { token: "alemi" } }, config, "kanban"));
  });
  assert.equal(accepted.filter((line) => line.includes(RETIRED_MARK)).length, 0);
});

test("a tenant with only kanban_secret still denies, and the retired token is flagged", () => {
  const lines = captureInfo(() => {
    assert.throws(
      () => assertTenantSecret(
        { headers: {}, body: { instance: "kanban_only_tenant" }, query: { token: "legacy-kanban-token" } },
        { kanban_secret: "legacy-kanban-token" },
        "kanban",
      ),
      (error: any) => error?.message === "TENANT_SECRET_NOT_CONFIGURED" && error?.statusCode === 500,
    );
  });
  const flagged = lines.filter((line) => line.includes(RETIRED_MARK));
  assert.equal(flagged.length, 1);
  assert.match(flagged[0], /kanban_only_tenant/);
  assert.ok(!flagged[0].includes("legacy-kanban-token"));
});

test("kanban auth rejects process-wide Alemi secrets for every SaaS tenant", () => {
  withEnv({ ALEMI_SECRET: "deployment-alemi-secret", ALEMI_INSTANCE: "legacy_restaurant" }, () => {
    assert.throws(
      () => assertTenantSecret(
        { body: { instance: "legacy_restaurant" }, query: { token: "deployment-alemi-secret" } },
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

test("kanban auth keeps two environment-mapped tenants isolated", () => {
  withEnv({
    ALEMI_TENANT_SECRETS_JSON: JSON.stringify({
      alpha: { secret: "alpha-secret" },
      beta: { secret: "beta-secret" },
    }),
    ALEMI_SECRET: "must-never-be-used",
    ALEMI_INSTANCE: "alpha",
  }, () => {
    assert.doesNotThrow(() => assertTenantSecret(
      { body: { instance: "alpha" }, query: { token: "alpha-secret" } }, {}, "kanban",
    ));
    assert.doesNotThrow(() => assertTenantSecret(
      { body: { instance: "beta" }, query: { token: "beta-secret" } }, {}, "kanban",
    ));
    assert.throws(
      () => assertTenantSecret(
        { body: { instance: "beta" }, query: { token: "alpha-secret" } }, {}, "kanban",
      ),
      (error: any) => error?.message === "INVALID_TENANT_SECRET" && error?.statusCode === 403,
    );
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
