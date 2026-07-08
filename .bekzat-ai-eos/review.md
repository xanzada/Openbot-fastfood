# Review

> **Rule:** All PRs must be reviewed. No exceptions.

## PR Process

```
Author creates PR → CI runs (lint → typecheck → test)
CI ✅ → Request Review
Reviewer reviews → Comments / Changes
Author fixes → Re-request
Approved → Merge (squash)
```

## Checklist (Quick)

### Logic
- [ ] Code does what it says? Edge cases handled?
- [ ] Business logic in code, not in prompt?
- [ ] 4-layer defense intact?

### Security
- [ ] No hardcoded secrets
- [ ] SSRF protected? Input validated?
- [ ] Tenant isolation maintained?

### Code
- [ ] Follows standards? (Biome passes)
- [ ] No dead code, no `console.log`
- [ ] Error handling: try/catch or .catch()

### Tests
- [ ] Unit tests for new logic
- [ ] Edge cases covered
- [ ] Regression: existing tests not broken

## PR Standards

| Field | Standard |
|-------|----------|
| Title | `<type>(<scope>): <description>` |
| Size | < 400 lines |
| Reviewers | ≥ 1 (2 for major) |
| Labels | `feature`, `bug`, `security`, etc. |

## Review Types

| Type | Meaning |
|------|---------|
| ✅ Approve | Good to merge |
| 💬 Comment | Suggestion, not blocking |
| ❌ Changes | Must fix before merge |

## When to Escalate

- Architecture change → Chief Architect
- Security change → Chief Architect
- Performance critical → Chief Architect
- ADR required → Chief Architect

## Merge Types

| Type | When |
|------|------|
| Squash merge | Default (clean history) |
| Rebase merge | Hotfix (linear history) |
| Merge commit | Large feature branch (preserve commits) |

---

_See: `25-review/README.md`, `19-standards/review-checklist.md`_
