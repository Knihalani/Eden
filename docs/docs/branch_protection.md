---
id: branch_protection
title: Branch protection
sidebar_label: Branch protection
sidebar_position: 99
---

# Branch Protection Policy

> Phase 5.6.5: codified review gates. Apply via GitHub repo settings (or
> terraform) — settings.json / GitHub UI doesn't enforce these from the
> repo tree itself, but the policy is recorded here for ops to apply.

## `main`

| Setting | Value |
|---------|-------|
| Require pull request before merging | ✅ |
| Required approvals | 2 |
| Dismiss stale pull request approvals when new commits pushed | ✅ |
| Require review from Code Owners | ✅ |
| Require status checks to pass before merging | ✅ |
| Required status checks | `lint`, `typecheck`, `unit-tests`, `security-scan`, `bench-regression` |
| Require branches up to date before merging | ✅ |
| Require linear history (squash or rebase) | ✅ |
| Restrict who can push | None (admins only outside PRs) |
| Allow force pushes | ❌ |
| Allow deletions | ❌ |

## `release/*`

| Setting | Value |
|---------|-------|
| Require pull request before merging | ✅ |
| Required approvals | 1 from `@eden/platform` lead |
| Required status checks | `lint`, `typecheck`, `unit-tests`, `integration-tests` |

## `feature/*` and `fix/*`

No branch protection — feature work proceeds against main via PR.

## How to apply

```bash
gh api \
  --method PUT \
  repos/eden/platform/branches/main/protection \
  -H "Accept: application/vnd.github+json" \
  --input .github/branch-protection.json
```

A sample `branch-protection.json` should be generated from this document
by ops; it isn't checked in to keep secrets and team IDs out of git.
