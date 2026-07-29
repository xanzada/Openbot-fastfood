import { readFileSync } from "node:fs";
import { join } from "node:path";
import assert from "node:assert/strict";
import { describe, it } from "node:test";

const root = join(process.cwd());
const compose = readFileSync(join(root, "docker-compose.yml"), "utf8");
const backup = readFileSync(join(root, "backup", "backup.sh"), "utf8");
const restore = readFileSync(join(root, "backup", "restore.sh"), "utf8");

describe("encrypted offsite backup", () => {
  it("mounts only backup state and protects credentials behind env values", () => {
    assert.match(compose, /backup_state:\/work/);
    assert.match(compose, /BACKUP_ENABLED: \$\{BACKUP_ENABLED:-false\}/);
    assert.doesNotMatch(backup, /BEGIN OPENSSH PRIVATE KEY/);
  });

  it("encrypts, splits and alternates snapshot branches", () => {
    assert.match(backup, /age -r "\$\{recipient\}"/);
    assert.match(backup, /split -b 90m/);
    assert.match(backup, /StrictHostKeyChecking=yes/);
    assert.match(backup, /BACKUP_GIT_BRANCH_PREFIX\}-\$\{slot\}/);
  });

  it("verifies both encrypted and decrypted checksums during restore", () => {
    assert.match(restore, /sha256sum -c encrypted-parts\.sha256/);
    assert.match(restore, /age -d -i/);
    assert.match(restore, /redisSha256/);
  });
});
