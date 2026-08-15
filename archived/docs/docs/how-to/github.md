---
id: github
title: Connect GitHub
sidebar_label: Connect GitHub
sidebar_position: 5
---

# How-to — Connect GitHub

Connect the Eden GitHub App so the portal can list your repos and
**Improve can open fix PRs** against an agent's linked repository.

## Required App permissions

On [the Eden Observability App](https://github.com/settings/apps/eden-observability)
→ **Permissions & events** → Repository permissions:

| Permission | Level | Why |
| --- | --- | --- |
| **Contents** | **Read and write** | Create branches, blobs, and commits for fix PRs |
| **Pull requests** | **Read and write** | Open / update / close PRs |
| **Checks** | **Read-only** | *New (§4.3 CI ingestion):* receive `check_run` / `check_suite` conclusions so Eden can stamp customer-CI results onto improvement plans and react to red CI |
| **Metadata** | Read-only | Always required |

Under **Subscribe to events**, enable: `Pull request`, `Check suite`,
`Check run`, `Installation`.

This is the App's *complete* minimal scope. Deliberately **no
`Workflows` permission**: Eden must never be able to edit
`.github/workflows/` — this pairs with the patch-path allowlist
(§7.1), which suppresses any generated diff touching workflow or CI
files. Together they make "an injected patch rewrites customer CI"
structurally impossible rather than merely reviewed-for.

If `Checks: Read-only` has not been granted (or an installation has
not re-accepted it), check webhooks simply never arrive — nothing
breaks; Eden stamps `ci_ingestion: "unavailable"` on plans at PR-open
when the App registration detectably lacks the permission.
Per-installation acceptance is not detectable from the App API alone,
so a stale installation just silently gets no CI evidence.

After saving, open
`https://github.com/settings/installations` (or the org's
Installed GitHub Apps page) and **Accept** the new permissions
on each installation. Until you accept, tokens stay on the old
scopes and PR create returns `403 Resource not accessible by
integration`.

## Install the GitHub App

1. Portal → **Agents** → pick an agent → **Connect repository**
   (or `/agents/connect?agent=<id>`).
2. Click **Install GitHub App**, pick the org/user, grant repos.
3. GitHub redirects to `/agents/connect` with `installation_id`;
   Eden claims the installation, then you pick the repo for that agent.

Webhook URL (for PR status sync):

`https://api.edenobservability.com/integrations/github/webhook`

Callback / Setup URL:

`https://edenobservability.com/agents/connect`

## Next

- [Instrument an existing repo](/how-to/auto-instrument)
- [Connect any agent](/how-to/connect-any-agent)
- [API keys](/how-to/api-keys)
