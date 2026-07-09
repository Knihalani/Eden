# F31: Interactive Slack Bot

| Field | Value |
|---|---|
| **Feature ID** | F31 |
| **Slug** | `interactive-slack-bot` |
| **Priority** | P0 |
| **Effort** | L |
| **Eden status** | **MISSING** |
| **Competitive source** | Raindrop,Laminar |
| **Closes gap** | 3.3,5.3 |

---

## 1. Summary

@eden commands; interactive issue buttons.

## 2. Eden current state

Slack stub only (`alert_stream.py` placeholder).

## 3. Target behavior

Bolt app; OAuth per org.

## 4. Architecture

slack_installations table.

## 5. Data model

/integrations/slack/events

## 6. API specification

See implementation plan — no new public HTTP routes unless noted.

## 7. Implementation plan

`integrations/slack/{bot,blocks,verify}.py`

## 8. SDK / CLI / Portal

Settings connect UI

## 9. Feature flags & rollout

None

## 10. Test plan

Mock Slack test

## 11. Acceptance criteria

- [ ] Resolve from button

## 12. Dependencies

F29,F47

---

*Spec generated from codebase audit + competitor research, July 2026. See [FEATURE-GAP-MASTER.md](../FEATURE-GAP-MASTER.md).*
