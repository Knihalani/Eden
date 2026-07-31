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
| **Metadata** | Read-only | Always required |

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
