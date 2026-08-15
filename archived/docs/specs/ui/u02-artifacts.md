# U02: Artifacts (Bento-class lifecycle UI)

| Field | Value |
|---|---|
| **Spec ID** | U02 |
| **Priority** | P0 |
| **Effort** | L |
| **Eden status** | MISSING page — data via `/improve` cards + learn API only |
| **Clone targets** | BentoLabs Artifacts (candidate→promoted); Eden EvidenceGate as differentiator |
| **Dependencies** | F39, F41, N17, U00 |
| **Route** | `/artifacts` (new); agent-scoped `/agents/[id]/artifacts` |

---

## 1. Summary

First-class home for **trigger-based fixes** (skills, prompt appends, tool policies, subagent hints). Operators see shadow performance, promote/demote with evidence, and export YAML to the customer repo. This is the portal face of Eden’s Bento counter.

---

## 2. Nav placement

Under **Improve** (U12): Artifacts · Book · Drift · Improve queue. Badge count = shadow artifacts awaiting review + promotion candidates past EvidenceGate threshold.

---

## 3. List page layout

```
┌ KPI: Shadow active · Promoted · Archived 7d · Avg lift ──────────────┐
├ Tabs: All | Shadow | Candidates | Promoted | Archived                 │
├ FilterBar: agent · action_type · source_issue · mode                  │
├ Table: name · agent · trigger summary · mode · fires · success Δ ·   │
│         evidence gate · updated                                       │
└ Detail panel / full page on row click ────────────────────────────────┘
```

### Columns
| Column | Notes |
|---|---|
| Name | Link; source issue chip if present |
| Trigger | Humanized one-liner from DSL |
| Action | `system_append` / `tool_block` / `tool_rewrite` / `subagent_hint` |
| Mode | Badge: shadow (amber) · promoted (green) · archived (muted) |
| Fires | Shadow match count (7d) |
| Success Δ | Percentage points vs baseline |
| Gate | Pass / Fail / Collecting (n/N) |
| Updated | Relative time |

---

## 4. Detail page

### Header
Name (editable) · mode badge · agent · created · Promote / Archive / Export YAML

### Tabs
1. **Overview** — content markdown preview; trigger DSL editor (YAML); action type
2. **Evidence** — EvidenceGate checklist (n, effect size, regressions, conformal); sparkline of outcomes; link to matching traces
3. **Outcomes** — table of `nudge_outcomes` (trace, matched, success, metric_delta); click → U01 trace
4. **History** — mode transitions + audit (N06)
5. **Export** — preview YAML + copy / download / open PR instructions

### Evidence panel (differentiator vs Bento)
```
Min samples     ████████░░  24/30
Effect size     ✓  Cohen's d = 0.31
Regressions     ✓  No secondary metric drop
Conformal       ✓  Coverage OK
────────────────────────────
Status: READY TO PROMOTE
[ Promote to 100% ]  [ Keep shadow ]  [ Archive ]
```

If autonomy policy `auto_nudge_promote` (N22): show “Auto-promote when ready” toggle (default off).

---

## 5. Authoring flows

### A. From Issue
Issue detail → **Create artifact** → NudgeAuthor drafts trigger+content from example traces → opens detail in **shadow** mode.

### B. Manual
Artifacts → New → form: name, agent, trigger builder (visual + YAML), action, content.

### C. From Improve queue
Kanban card → Open artifact (deep link).

---

## 6. Interactions

| Action | Behavior |
|---|---|
| Promote | Calls EvidenceGate; on pass sets mode=promoted; audit log; optional Book update (F40) |
| Demote / Archive | Immediate; stops injection; alert if was promoted |
| Export | `{agent_id}/{nudge_id}.yaml` download |
| Compare | Side-by-side two versions of content (if versioned later) |

Keyboard on list: `j/k`, `Enter` open, `p` promote (if gate pass), `a` archive (confirm).

---

## 7. Empty state (Gap 4.8)

> “Artifacts are reusable fixes Eden learns from production. After ~7 days of traffic, recurring issues become shadow candidates here.”
>
> CTA: View Agent Issues · Connect agent

---

## 8. Acceptance criteria

- [ ] `/artifacts` listed in core Improve nav
- [ ] Shadow → promote requires EvidenceGate pass (or explicit override with reason)
- [ ] Outcome table links to traces
- [ ] YAML export matches F39 schema
- [ ] Improve queue and Issues deep-link here
- [ ] Demotion within 1h of regression still surfaces as alert (F41)

---

## 9. Performance

List p95 < 800ms; evidence compute cached 60s Redis. No LLM on page load (authoring only).
