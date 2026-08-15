---
id: evals-in-ci
title: Gate PRs with evals in CI
sidebar_label: Evals in CI
sidebar_position: 13
---

# How-to — Evals in CI

Run your Eden regression suite on every pull request and **block the merge**
when it regresses. The Eden GitHub Action calls the CI-eval endpoint, posts a
sticky PR comment with a per-metric score table, and fails the check when the
gate is `block`.

## Quickstart

Add this workflow (uses the in-repo composite action):

```yaml
name: eden-eval
on: [pull_request]
jobs:
  eval:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v7
        with: { fetch-depth: 0 }
      - uses: ./.github/actions/eden-eval
        with:
          eden-api-key: ${{ secrets.EDEN_API_KEY }}
          eden-org: ${{ secrets.EDEN_ORG_ID }}
          change-id: ${{ github.event.pull_request.number }}
```

## Required secrets

Add these under **Settings → Secrets and variables → Actions**:

| Secret | Required | Purpose |
|--------|----------|---------|
| `EDEN_API_KEY` | yes | Bearer token for `POST /orgs/{org}/ci-eval/run` |
| `EDEN_ORG_ID` | yes | Target organization id |
| `EDEN_BASE_URL` | no | API base URL (defaults to `https://api.eden.com`) |
| `EDEN_PORTAL_URL` | no | Portal base for the comment's "view runs" link (defaults to `https://app.eden.com`) |

When a required secret is missing the job **fails loudly** — there is no silent
green.

## What the PR comment shows

The action posts (and stickily updates) one comment per PR:

- **Gate** — `pass` ✅ or `block` ❌.
- **Counts** — passed / failed / skipped / errors, and the total.
- **Score table** — one row per metric (`pass_rate`, `fail_rate`, `skip_rate`,
  `error_rate`) with `baseline`, `current`, `delta`, and a `verdict`
  (`improvement` / `regression` / `tie` / `new`). The baseline is the previous
  run for the same org/agent, or an explicit `baseline_experiment_id` if you
  pass one.
- **Skipped / errors breakdown** — each skipped or errored case with its
  reason (e.g. `no_trace`, `no_constraints`).
- A link to the run history in the Eden portal.

The step exits non-zero when the gate is `block` (`ok=false`), so it gates the
merge via branch protection.

## Skip policy — allow vs block

A case is **skipped** when it cannot be verified (no linked trace, no
constraints). What that does to the gate is controlled by the
`regression_gate_skip_policy` setting:

- **`allow`** (default) — skipped cases do **not** fail the gate. Only real
  failures and errors block. Fail-closed still applies to errors: a telemetry
  outage counts as an error, never a silent pass.
- **`block`** — any skipped case fails the gate. Use this when you require full
  coverage before a change can merge.

The active policy is reported in the PR comment and in the API response under
`skips.policy`.

## Run history

Every run is persisted. List and inspect them via the API:

- `GET /orgs/{org}/ci-eval/runs?limit=20&offset=0` — paginated list (run id,
  ref/commit, counts, `ok`, `created_at`).
- `GET /orgs/{org}/ci-eval/runs/{id}` — full detail including per-case
  outcomes.

## Optional: commit-status writeback

When enabled server-side (`ci_eval_commit_status_v1`) and the org has the Eden
GitHub App installed, pass `repo_full_name` + `commit_sha` + `post_commit_status:
true` in the request and Eden posts a **Check Run** with the verdict directly on
the commit. Off by default; absent config, install, or repo/sha it silently
no-ops and never fails the eval.
