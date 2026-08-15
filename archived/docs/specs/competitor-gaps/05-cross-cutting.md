# Cross-Cutting Theme Specs

These themes span multiple per-competitor gaps. Each section references primary specs and adds integration/orchestration requirements.

---

## Theme 5.1 — Detect → Fix → Verify Loop Completeness {#theme-51}

**Severity:** 🔴

### Current Eden loop

```
Trace → RCA (manual/on-demand) → AI sidebar Q&A → [Cat 23 stub] → Cat 12 experiments (disconnected)
```

### Target Eden loop

```
Trace finalized
  → Auto scan (2.1) → Stumble (3.1) → Issue promotion
  → Triage agent (3.2) → Fix chat / MCP autofix (2.3, 3.10)
  → Experiment verify (3.5) → Issue resolve
  → Nudge promote (4.1) → Book update (4.2)
```

### Orchestration service

**`src/eden/closed_loop/orchestrator.py`**

State machine on `agent_issues.status`:

| Transition | Trigger | Actions |
|---|---|---|
| `open → triaging` | user or auto | start triage job |
| `triaging → fix_proposed` | triage complete | notify assignee |
| `fix_proposed → verifying` | PR merged / experiment started | link experiment_id |
| `verifying → resolved` | stumble rate ↓ significant | update book, archive shadow nudges |
| `resolved → regressed` | new stumble same fingerprint | reopen, alert |

### Event bus

Extend `promotion_hooks.py`:

```python
on_issue_created → slack_alert + triage_queue
on_issue_resolved → book_generator + eval_dataset_add_win
on_pr_merged → post_merge_monitor (Cat 23)
```

### Portal

Single **"Improvement Loop"** dashboard showing counts at each stage (Kanban).

### Primary specs

2.1, 2.3, 3.1, 3.2, 3.5, 4.1, 4.2, 4.3

### Acceptance criteria

- [ ] Demo script completes full loop on synthetic issue in staging <30 min
- [ ] Metrics: median time issue-open → resolved tracked in ClickHouse

---

## Theme 5.2 — Developer Experience / Local Iteration {#theme-52}

**Severity:** 🔴

### Components

| Component | Spec | Priority |
|---|---|---|
| Cached live debugger | 1.1 | P0 |
| MCP + CLI | 1.2 | P0 |
| Eden Workshop OSS | 3.4 | P1 |
| Local dev server | 1.5 | P1 |
| Session CLI | 2.6 | P2 |

### Unified env vars

Document standard:

```bash
EDEN_DEBUG=1
EDEN_DEBUG_SESSION=<uuid>
EDEN_DEBUG_CACHE_UNTIL=12
EDEN_API_KEY=...
EDEN_PROJECT_ID=...
```

SDK auto-reads across Python/TS/Go/Rust.

### Acceptance criteria

- [ ] One docs page lists all local dev paths
- [ ] `eden doctor` validates config + connectivity

---

## Theme 5.3 — Slack as Product (Not Webhook) {#theme-53}

**Severity:** 🔴

### Implementation bundle

1. **Outbound Block Kit** — replace stubs in `alert_stream.py`, `code_change/notify.py`
2. **Inbound bot** — Gap 3.3
3. **Interactive actions** — buttons → API callbacks with HMAC verify

### New module structure

```
src/eden/integrations/slack/
  __init__.py
  webhook.py      # outbound
  bot.py          # bolt app
  blocks.py       # message templates
  verify.py       # signature verification
```

### Issue alert template (Raindrop parity)

```
🚨 P1 Issue: agent loop in checkout_agent
Users affected: 47 | Stumbles: 312 | Since: 2h ago
[View Issue] [Triage] [Resolve]
```

### Acceptance criteria

- [ ] Zero `_dispatch_slack` placeholder logs in production config
- [ ] Interactive button resolves issue without opening portal

---

## Theme 5.4 — Semantic Monitoring Without Configuration {#theme-54}

**Severity:** 🔴

### Strategy

Layered detection defaults (no user config):

| Layer | Mechanism | Spec |
|---|---|---|
| L0 | Rule detectors on ingest | 2.1 |
| L1 | ETEC / loop / guardrails | existing |
| L2 | Default signal classifiers | 3.6 |
| L3 | Per-trace signals (optional) | 1.3 |

New orgs get L0+L1+L2 enabled automatically.

**`organizations.features.detection_profile`:** `minimal | standard | advanced`

### Acceptance criteria

- [ ] Fresh signup → first issue without visiting settings
- [ ] Advanced users can still add custom signals

---

## Theme 5.5 — Browser/Computer-Use Observability {#theme-55}

**Severity:** 🟠

### Bundle

1.4 (RRWeb) + 1.7 (integrations) + existing `computer_use.py`

### Unified browser agent trace schema

OTel attributes namespace `eden.browser.*`:
- `screenshot_uri`
- `dom_step_index`
- `browser_session_id`

Portal trace view: three-pane layout — transcript | browser replay | computer_use screenshots.

### Acceptance criteria

- [ ] Browser Use demo trace playable end-to-end in portal

---

## Theme 5.6 — Production Proof / GTM {#theme-56}

**Severity:** 🟡 (non-engineering)

### Deliverables

1. **Public case studies page** — template for 3 design partners
2. **Trust center** — SOC2 report link (existing mapping doc)
3. **Comparison pages** — `/compare/laminar`, `/compare/raindrop`, etc. (factual, gap-closed checklist)
4. **Open-source Workshop** — developer love funnel (3.4)

Track gap closure publicly in README badge table synced to these specs.

### Acceptance criteria

- [ ] Compare page updated within 1 week of each Wave ship
