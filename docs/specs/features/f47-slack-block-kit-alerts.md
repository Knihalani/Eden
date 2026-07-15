# F47: Slack Block Kit Outbound Alerts

| Field | Value |
|---|---|
| **Feature ID** | F47 |
| **Slug** | `slack-block-kit-alerts` |
| **Priority** | P0 |
| **Effort** | M |
| **Eden status** | **SHIPPED (v0)** — `integrations/slack/alerts.py` outbound webhooks |
| **Competitive source** | Raindrop, Laminar |
| **Closes gap** | 3.3, 5.3 |
| **Dependencies** | F29 (issues), N08 (StatGate P0), F04 (deep links) |

---

## 1. Summary

Replace placeholder Slack logging with rich **Block Kit** outbound webhooks — issue created, P0 stumble, StatGate escalation, promotion demotion. Interactive buttons deep-link to portal or MCP docs (not full F31 bot — outbound-only for speed to ship).

---

## 2. Eden current state

| Component | Status |
|---|---|
| `integrations/slack.py` | **Does not exist** (docs reference only) |
| `alert_stream.py` Slack dispatch | `logger.info` placeholder |
| Slack OAuth/Bolt bot (F31) | Deleted — outbound webhooks sufficient v1 |

---

## 3. Target behavior

```
on_issue_created(P0/P1) → SlackAlertDispatcher.send_issue_created
on_statgate_p0 (N08)    → send_statgate_escalation
on_promotion_demoted    → send_promotion_alert
on_mcp_auth_spike (N02) → send_mcp_alert

Each message: Block Kit with severity, user_count, trace link, action buttons
```

---

## 4. Architecture

```
src/eden/integrations/slack/
  __init__.py
  webhook.py       # httpx POST incoming webhook URL
  blocks.py        # Block Kit builders
  templates.py     # Jinja → block JSON
  verify.py        # Optional signing secret for interactive (future)

Org settings:
  slack_webhook_url_encrypted
  slack_alert_min_severity: p1
  slack_channels_config JSON
```

**No Bolt app v1** — incoming webhook URL per org (Settings → Integrations).

---

## 5. Block templates

### Issue created (P0)

```json
{
  "blocks": [
    {"type": "header", "text": {"type": "plain_text", "text": "🚨 P0 Agent Issue"}},
    {"type": "section", "fields": [
      {"type": "mrkdwn", "text": "*Issue:*\n<url|checkout bash loop>"},
      {"type": "mrkdwn", "text": "*Users affected:*\n12"},
      {"type": "mrkdwn", "text": "*Agent:*\ncheckout-v2"},
      {"type": "mrkdwn", "text": "*Events:*\n47 stumbles/24h"}
    ]},
    {"type": "actions", "elements": [
      {"type": "button", "text": {"type": "plain_text", "text": "View Issue"}, "url": "..."},
      {"type": "button", "text": {"type": "plain_text", "text": "Triage in Cursor"}, "url": "cursor://..."}
    ]}
  ]
}
```

---

## 6. API / settings

| Method | Path | Purpose |
|---|---|---|
| `GET/PATCH` | `/orgs/{org_id}/settings/integrations/slack` | Webhook URL, severity threshold |
| `POST` | `/orgs/{org_id}/integrations/slack/test` | Send test message |

---

## 7. Hook registration

```python
# promotion_hooks.py / issue hooks
@on_issue_created
async def slack_notify_issue(event: IssueCreatedEvent):
    if event.severity > org.slack_alert_min_severity:
        return
    await slack_dispatcher.send_issue_created(event)
```

---

## 8. Performance & cost optimization

### Latency budgets

| Operation | p95 | SLA |
|---|---|---|
| Hook → Slack POST dispatched | <500ms | async, non-blocking |
| Slack API round-trip | <2s | — |
| Issue → alert delivered | <60s | end-to-end |

### Cost model

- **$0** — incoming webhooks free
- **No LLM** for alert content — template + data only
- **Rate limit:** max 30 alerts/hour/org (prevent storms); bundle duplicates

### Storm protection

```python
# Dedupe: same issue fingerprint within 15min → update existing message (if thread_ts supported) or skip
# Digest mode: >10 P2 issues/hr → single hourly digest block
```

### Degradation

- Slack 429 → exponential backoff queue (Redis)
- Webhook invalid → disable + email org admin
- Alert dispatch fail never blocks issue creation

### Monitoring

```
eden_slack_alert_sent_total{template}
eden_slack_alert_failed_total{reason}
eden_slack_alert_deduped_total
eden_slack_alert_latency_seconds
```

---

## 9. Feature flags

| Flag | Default |
|---|---|
| `slack_block_kit_alerts_v1` | false |

---

## 10. Test plan

- Snapshot test block JSON for P0 issue fixture
- Mock httpx — verify POST URL and payload
- Storm: 100 stumbles → ≤30 alerts (dedupe)
- Test webhook endpoint in portal

---

## 11. Acceptance criteria

- [x] P0 issue → Slack message <60s with user_count
- [x] Block Kit validates against Slack API linter
- [x] Alert storm deduped (15min window)
- [x] Failed Slack never fails issue write
- [x] Cursor deep link documented in button URL

---

*Future F31 interactive bot can extend with same `blocks.py`. See N08 for StatGate triggers.*
