import test from "node:test";
import assert from "node:assert/strict";
import axios from "axios";
import { redisClient } from "../src/services/redis.service.js";
import { getAllRestaurantConfigs, getRestaurantConfig } from "../src/services/platformConfig.service.js";

// Live boot log, 2026-08-12:
//   [OPENBOT:BOOT:FAIL] alemi_hub[prestige] detail=tenant carries no alemi_secret
// while the per-instance endpoint returned a 12-character alemi_secret for that
// exact tenant. getAllRestaurantConfigs() seeded its 60s runtime memory with the
// REDACTED index record whenever there was no earlier entry to carry secrets
// over from - a cold boot - so every getRestaurantConfig() read for the next
// minute returned a config with no secret in it. Hub calls repair themselves via
// withRotatedSecretRetry(); the boot check and anything else reading the config
// directly just saw a tenant that looked unconfigured.
process.env.TENANTS_PLATFORM_BASE_URL = "https://platform.test";
process.env.TENANTS_PLATFORM_API_TOKEN = "platform-token";

const store = new Map<string, string>();
Object.defineProperty(redisClient, "isOpen", { get: () => true, configurable: true });
(redisClient as any).connect = async () => undefined;
(redisClient as any).get = async (key: string) => store.get(key) ?? null;
(redisClient as any).setEx = async (key: string, _ttl: number, value: string) => { store.set(key, value); return "OK"; };
(redisClient as any).del = async (key: string) => (store.delete(key) ? 1 : 0);

const INDEX_ROW = { instance_id: "prestige", brand: "Crazy Sushi", alemi_secret: "", alemi_api_url: "https://hub.alemi.kz" };
const BY_ID = { instance_id: "prestige", brand: "Crazy Sushi", alemi_secret: "real-secret", alemi_api_url: "https://hub.alemi.kz" };

let byIdReads = 0;
(axios as any).get = async (url: string) => {
  if (url.endsWith("/api/wa/runtime-configs")) return { data: { configs: [INDEX_ROW] } };
  byIdReads += 1;
  return { data: { config: BY_ID } };
};

test("a cold-boot index read never hides the tenant secret behind its own cache", async () => {
  store.clear();
  byIdReads = 0;
  const index = await getAllRestaurantConfigs({ forceRefresh: true });
  assert.equal(index.length, 1);
  assert.equal(String(index[0].alemi_secret || ""), "", "the index really is redacted");

  const config = await getRestaurantConfig("prestige");
  assert.equal(config?.alemi_secret, "real-secret");
  assert.equal(byIdReads, 1, "the redacted row must not satisfy a by-id read");
});

test("an index refresh keeps the secret a by-id read already established", async () => {
  store.clear();
  await getRestaurantConfig("prestige", { forceRefresh: true });
  await getAllRestaurantConfigs({ forceRefresh: true });
  byIdReads = 0;
  const config = await getRestaurantConfig("prestige");
  assert.equal(config?.alemi_secret, "real-secret");
  assert.equal(byIdReads, 0, "the carried-over secret means no extra platform read");
});
