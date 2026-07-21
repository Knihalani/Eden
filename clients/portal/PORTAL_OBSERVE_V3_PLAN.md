# PORTAL_OBSERVE_V3_PLAN.md

**Observe V3 interaction contract** — locked decisions for Waves 2–9.  
**Gap source:** [`.wave-v3-0-gaps.md`](./.wave-v3-0-gaps.md)  
**Frozen:** Dual `/observability` IA · Live always-on primary · DESIGN.md bans · Evaluate/Improve redesign

---

## 1. Locked decisions (no optionality in impl)

1. **Master–detail stays.** List never unmounts on select. Split ≥1280 / drawer &lt;1280. URL `traceId` + `spanId`. Esc closes detail.
2. **Default reader = transcript.** Mode control = Tree | Timeline | Meta | Scores (single segmented control / tabs). Timeline is power mode, not default.
3. **Toolbar grammar:** View tabs · Search · ≤3 filters · Views · Overflow · **Display** (first-class). Display owns columns / density shortcut / LIVE opt-in. Clutter lint ≤8 Traces primary controls.
4. **Latency · tokens · cost** on every list row and every tree node (when API provides fields).
5. **Facet chips with counts;** saved views per lens (Traces / Spans / Sessions) + amber dirty indicator.
6. **Timeline = synced Gantt** overview bidirectional with transcript (select row ↔ select bar; optional range brush). Not default mode.
7. **Sessions lens = numbered turn cards** (`1/N`) with Input + last LLM Output before drill-in.
8. **Issues / Alerts** keep master–detail; evidence → traces with **preserved** `pastHours` / `q` / `realm` / `outcome` / `agent_id` via `TracePreserveParams`.

---

## 2. Canonical URL grammar

| Param | Role |
|-------|------|
| `view` | `traces` \| `spans` \| `sessions` (+ legacy embeds: inspect/replay/debug/query) |
| `traceId` | Selected trace (canonical writer) |
| `spanId` | Selected / highlighted span (canonical writer) |
| `mode` | `transcript` \| `tree` \| `timeline` \| `meta` \| `scores` |
| `pastHours` | Time window (drives list fetch; default 168 = 7d) |
| `q` / `realm` / `outcome` / `agent_id` | Filters |
| `viewId` | Saved view |
| `cols` | Display optional columns |
| `live=1` | Live tail opt-in |
| `facet` | Advanced facet embeds |

**Alias-read only (never write):** `span`, `span_id`, `trace_id`, path `/traces/:id`.

---

## 3. Wave deliverables

| Wave | Ship | Exit |
|------|------|------|
| **2 Hub** | Display first-class; `pastHours`→query; URL dialect unify; I/O preview cols; built-in views (Errors / High-latency / Unreviewed); empty≠loading≠filtered-empty; merge SpanSearchBar into hub Search | `.wave-v3-2-critic.md` |
| **3 Reader** | Metadata pill strip; Formatted↔JSON; tree metrics; in-tree search; subagent cards collapsed + 1-line I/O; failure callout; inspector pane; `spanId` write-back | `.wave-v3-3-critic.md` |
| **4 Timeline+Sessions** | Bidirectional Gantt sync; zoom/brush/error tint; session turn cards; session page modes | `.wave-v3-4-critic.md` |
| **5 Issues+Alerts** | Evidence peek with stumble→trace; preserve filters on cross-links; Alerts density; shared empty grammar | `.wave-v3-5-critic.md` |
| **6 Loop+Keyboard** | Dataset/playground first-class; citation chips; j/k Enter Esc ⌘K; golden path refresh; **core signoff** | `.wave-v3-6-core-signoff.md` |
| **7 Advanced** | Agents / Analytics / Debug density alignment | `.wave-v3-7-critic.md` |
| **8 Power shells** | Replay/Query/Inspector ≤400 LOC; Overflow-only | `.wave-v3-8-critic.md` |
| **9 Freeze** | axe serious=0; clutter≤8; vitest; CHANGELOG; freeze | `.wave-v3-9-freeze.md` |

---

## 4. Hard gates (every wave)

- DESIGN.md density (≤2 chrome bands; ≤5–8 primary toolbar; transcript-first)
- Clutter lint ≤8 on Traces toolbar (`data-primary-control`)
- axe serious=0 on `/traces` `/issues` `/alerts` (Wave 9 full; earlier waves: touched surfaces)
- No dual-IA reopen; Live remains opt-in
- Prefer existing APIs — no backend redesign unless proven missing field

---

## 5. Built-in views (Wave 2)

| View id | Lens | Filter intent |
|---------|------|---------------|
| `builtin:errors` | traces | `outcome=error` (or equivalent) |
| `builtin:high-latency` | traces | sort duration desc / latency threshold when available |
| `builtin:unreviewed` | traces | unscored / no human review when field exists; else soft filter placeholder |

Amber dirty when user drifts from saved/builtin selection.

---

## 6. Non-goals

- Helicone Home card-grid as Traces grammar
- Waterfall/flame as default agent reader
- New top-level Observe nav leaves
- Evaluate/Improve redesign
- Backend API redesign (unless Wave 0 proved missing field — none proven; use existing list/tree/timeline/search)

---

## 7. API preference

| Need | Prefer |
|------|--------|
| List + filters | `listObservabilityTraces` |
| Tree | `getTraceTree` |
| Timeline | `getTraceTimeline` |
| Span search | `searchSpans` |
| Cross-links | `traceHref(..., TracePreserveParams)` |

Map `pastHours` → API `days` or `past_hours` if supported; else `days = ceil(pastHours/24)`.
