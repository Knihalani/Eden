---
id: cli
title: Doctor CLI
sidebar_label: Doctor CLI
sidebar_position: 1
---

# Doctor CLI

Eden ships a **doctor** command with each SDK. It verifies org credentials,
connectivity to the API, and optionally emits a test event so you can
confirm the portal is receiving traffic.

A full interactive `eden` CLI (agent discovery, eval runs, chat) is **not
published** yet. Use the doctor commands below and the [portal](https://edenobservability.com)
for day-to-day work.

## Install

Doctor comes with the SDKs — no separate package:

```bash
pip install eden-sdk          # Python → eden-doctor / python -m eden_sdk.doctor
npm install @eden-ai/sdk      # TypeScript → npx eden-doctor
```

## Commands

### Python

```bash
python -m eden_sdk.doctor
# console script alias (same entry point):
eden-doctor
```

What it checks:

- `EDEN_ORG_ID` / `EDEN_API_KEY` (or aliases) are set
- API base URL is reachable
- Auth is accepted
- Optional: emits a test event (`emit_test_event=True` by default in the CLI)

From code:

```python
import eden

report = eden.run_doctor(emit_test_event=True)
print(report.ok, report.checks)
```

### TypeScript

```bash
npx eden-doctor
# equivalent:
node node_modules/@eden-ai/sdk/dist/doctor.js
```

Prefer `npx eden-doctor` over `npx @eden-ai/sdk doctor` — the published
bin name is `eden-doctor`.

## When to run it

| Situation | Command |
|-----------|---------|
| First install | `python -m eden_sdk.doctor` or `npx eden-doctor` |
| Rotated an API key | Re-run doctor before debugging “no traces” |
| CI smoke | Doctor exit non-zero → fail the job |
| Local “is my env wrong?” | Doctor before re-reading SDK docs |

See also: [Authenticate](/how-to/auth), [Environment variables](/reference/environment-variables),
[Python SDK](/reference/sdk-python), [TypeScript SDK](/reference/sdk-typescript).
