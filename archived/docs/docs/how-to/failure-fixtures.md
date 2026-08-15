---
id: failure-fixtures
title: Failure fixtures
sidebar_label: Failure fixtures
sidebar_position: 12
---

# How-to — Failure fixtures (D6)

**Failure fixtures** are redacted trace bundles you export from a
production agent issue and replay locally — without hosted environment
clones. They replace the retired env-gen workflow (N07).

Use fixtures to:

- Reproduce a failure in your IDE with real (redacted) inputs
- Seed regression eval datasets (N01 synergy)
- Share minimal repro artifacts across teams (compliance-safe)

## Export from the portal

1. Open **Agent Issues** → select an issue.
2. Click **Export fixture** on the issue detail page.
3. Download the JSON bundle (transcript, quality signals, metadata —
   PII redacted per org policy).

## Export via API

Prefer **Export fixture** in the portal. The HTTP route is session-auth
(Clerk), same as other agent-issues endpoints:

`POST /orgs/{org_id}/agent-issues/{issue_id}/export-fixture`

Response shape:

```json
{
  "fixture_id": "fix_abc123",
  "issue_id": "iss_456",
  "exported_at": "2026-07-13T12:00:00Z",
  "redaction_applied": true,
  "traces": [
    {
      "trace_id": "tr_789",
      "source_format": "openai",
      "transcript": [],
      "quality": {"loops": 2, "statgate_verdict": "P0"}
    }
  ]
}
```

## Export via MCP

From Cursor with Eden MCP connected:

> **"Export a failure fixture for issue `iss_456`."**

The `export_fixture` tool (when enabled) wraps the same API and returns
a local-file path suggestion.

## Local replay

1. Save the bundle as `fixture.json`.
2. Point the live-prefix debugger or hermetic runner at the fixture:

```bash
eden debugger replay --fixture fixture.json --from-step 0
```

3. Compare the new trace to the exported `quality` block to verify your
   fix.

## Regression memory (D7)

Every resolved failure can auto-create a permanent regression case:

- Portal: issue → **Add to regression suite**
- MCP: `add_trace_to_dataset` with the exported trace id
- CI: N01 gate blocks merges when the regression case fails

## Redaction defaults

Fixtures honor org PII policy (Settings → PII Policy):

- Emails, phone numbers, and credit cards masked by default
- `redact_on_client` SDK setting applies before export
- Custom regex patterns from the PII policy tab are applied server-side

## Compliance

Fixture export is logged in the org audit log (`action: fixture.export`).
Autonomy policy (N22) may block export for HIPAA/SOC2-restricted orgs
without admin role.

## What's next

- [Connect any agent](/how-to/connect-any-agent) — capture from any stack
- [Agent sessions](/how-to/agent-sessions) — group traces by user interaction
