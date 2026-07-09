# F47: Slack Block Kit Outbound Alerts

| Field | Value |
|---|---|
| **Feature ID** | F47 |
| **Slug** | `slack-block-kit-alerts` |
| **Priority** | P0 |
| **Effort** | M |
| **Eden status** | **MISSING** |
| **Competitive source** | Raindrop,Laminar |
| **Closes gap** | 5.3 |

---

## 1. Summary

Replace webhook placeholders with rich alerts.

## 2. Eden current state

`_dispatch_slack` logs only.

## 3. Target behavior

httpx POST Block Kit; issue templates.

## 4. Architecture

None

## 5. Data model

None

## 6. API specification

See implementation plan — no new public HTTP routes unless noted.

## 7. Implementation plan

`integrations/slack/webhook.py`

## 8. SDK / CLI / Portal

None

## 9. Feature flags & rollout

None

## 10. Test plan

Template snapshot test

## 11. Acceptance criteria

- [ ] P0 shows user_count

## 12. Dependencies

F29,F31

---

*Spec generated from codebase audit + competitor research, July 2026. See [FEATURE-GAP-MASTER.md](../FEATURE-GAP-MASTER.md).*
