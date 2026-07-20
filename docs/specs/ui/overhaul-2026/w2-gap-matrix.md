# Wave 3 — Eden vs Peers Gap Matrix (calm chrome focus)

**Date:** 2026-07-20  
**Agent:** `w3-gap-matrix` (10-wave plan Wave 3)  
**Status:** Refreshed against W1 surfaces + W2 systems baselines  
**Scope:** Research + docs only (no product UI code)  
**Inputs:** [`w1-consolidated-inventory.md`](./w1-consolidated-inventory.md), W2 systems append, peer `w2-*.md`  
**Companion:** [`w2-competitor-pattern-library.md`](./w2-competitor-pattern-library.md) · [`w2-laminar-contracts.md`](./w2-laminar-contracts.md)

---

## 0. How to read

| Column | Meaning |
|---|---|
| **Pattern area** | Chrome / OS contract |
| **Industry bar** | Best-in-class (primary first) |
| **Eden today** | Live W1/W2 cite |
| **Gap** | Missing vs bar |
| **Must-match?** | `YES` / `PARTIAL` / `NO` |
| **Moat keep?** | Differentiate — do not flatten |
| **Pri** | P0 blocks calm Observe; P1 next; P2 polish |

**Wave 3 lens:** Prefer gaps that reduce **simultaneous chrome** (bands, dual identity, overflow, progressive disclosure). Feature depth without band discipline is **not** a must-match.

---

## 1. Must-match industry vs Eden moat

### 1.1 Must-match (table stakes)

| Contract | Industry bar | Why must-match | Eden live (2026-07-20) |
|---|---|---|---|
| **≤2 Observe chrome bands** | Laminar: tabs + one toolbar | Traces archetype failure | **3 bands** — FAIL |
| **Secondary tools in overflow** | Laminar detail dropdown / SQL escape | Progressive disclosure | More menu partial; CrossLinkBars still band on Agents/Improve |
| **Master–detail** | Laminar / Braintrust / Helicone drawer | List stays put | `DetailPanelShell` present; uneven |
| **Table views (hide columns)** | Laminar amber dirty · scoped views | Calm via hide, not more chrome | ViewsMenu partial |
| **Filter ↔ URL without third band** | Langfuse dual editor; Laminar same toolbar | Dual editor ≠ dual bands | QueryFilterBar is band 3 under tabs |
| **State stack** | Skeleton ≠ blank; empty vs filter-empty | Confusion flash | QueryState ×6; `fallback={null}` ×2 |
| **Toolbar / KPI caps** | Helicone lean; Datadog overview restraint | Anti-clutter doctrine | Alerts/Artifacts/Audit clutter leaders |
| **Settings rail density** | Helicone ~9–10 tabs | Tab count = clutter | 19 visible / 6 groups; dual_title **N** (fixed) |

### 1.2 Eden moat (keep)

| Moat | Rule |
|---|---|
| Dark-terminal brand | Match structure, not light skins |
| AI rail (`ChatSidebar`) | Keep; span citations = progressive, not new hub band |
| U12 ≤12 core | Fix leaf drift via hubs/embeds — never raise count |
| Instrument density on analysis | Tokenize TranscriptView — don’t undensify |
| Improve / Artifacts / Promotions / Audit | Keep discoverable; declutter chrome, don’t delete |
| Governance surfaces | Thin peers here — keep with quiet Resource OS |

### 1.3 Explicit non-goals

| Do not | Why |
|---|---|
| Laminar SQL depth as P0 chrome | Escape hatch after views/filters |
| Langfuse permanent left filter rail | Match dual-editor contract; Eden stays toolbar |
| Flatten AI rail to header icon | Loses moat |
| Core nav >12 | U12 |
| Light-mode portal | Brand |
| Wave 4 contract synthesis in this file | Owned by Wave 4 agents |

---

## 2. Gap matrix

### 2.1 Shell chrome

| Pattern | Industry bar | Eden today | Gap | Must? | Moat? | Pri |
|---|---|---|---|---|---|---|
| Shell slots | Laminar inset + thin page Header | AppShell + sticky `h-11` + banners + AI rail | Shell OK; page bands overload | YES | YES (AI rail) | P0 |
| Org once + collapse-safe | Laminar monogram in icon rail | Dual org **fixed**; collapse-safe still critical | Ensure collapsed rail keeps org | YES | NO | P0 |
| Banner discipline | One blocking layer | Multi banner stack; ~7 worst-case main column | Cap / align `top-*` | PARTIAL | YES | P1 |
| ⌘K completeness | Linear | Present; action coverage uneven | Index without dumping into sidebar | YES | NO | P1 |

### 2.2 Sidebar IA

| Pattern | Industry bar | Eden today | Gap | Must? | Moat? | Pri |
|---|---|---|---|---|---|---|
| ≤12 + Advanced collapse | Helicone named groups | Core **12**; Advanced collapsed; icons **0** collisions | Leaf set ≠ U12 lock; group id≠label remains | YES (≤12) | YES | P0 |
| Named secondary groups | Helicone Segments/Improve/Monitor | Single “Advanced” dump | Label jobs inside Advanced (P1) | PARTIAL | NO | P1 |
| Orphan dual routes | Single hub URLs | Observability/fleet/signals/incidents redirects partial | Finish GAP map | YES | NO | P0 |

### 2.3 Traces / Observe chrome

| Pattern | Industry bar | Eden today | Gap | Must? | Moat? | Pri |
|---|---|---|---|---|---|---|
| Band budget ≤2 | Laminar | **3** (header + tabs + filter OS) | Collapse | YES | NO | **P0** |
| Facets as filters | Laminar secondary | In More (good) — must stay out of bands | Keep; no chip runway | YES | PARTIAL | P0 |
| Legacy tools overflow | Laminar SQL in detail | In More | Keep forever off tab row | YES | NO | P0 |
| Detail modes progressive | Laminar Transcript default + dropdown | Partial | One detail toolbar | YES | YES (density) | P0 |
| Live as one control | Laminar Live | `LiveTailPanel` | Toolbar control only | PARTIAL | YES | P1 |

### 2.4 Table OS

| Pattern | Industry bar | Eden today | Gap | Must? | Moat? | Pri |
|---|---|---|---|---|---|---|
| Views = filter+sort+columns | Laminar table-views | Partial dirty | Full ViewState dirty amber | YES | NO | P0 |
| Hide columns via views | Laminar “hide what you don’t need” | Display menu missing | Prefer hide over new chrome | YES | NO | P0 |
| Infinite table | Laminar | Uneven adoption | Observe core first | YES | NO | P0 |
| Scoped views per table | Laminar | Need enforce | Traces ≠ Spans lists | YES | NO | P0 |

### 2.5 Filters

| Pattern | Industry bar | Eden today | Gap | Must? | Moat? | Pri |
|---|---|---|---|---|---|---|
| Dual editor one slot | Langfuse | QueryFilterBar modes | Don’t add third band for sidebar | YES | NO | P0 |
| URL share | Langfuse/Laminar | Partial | Lossless round-trip | YES | NO | P0 |
| Suggestions/Recent | Braintrust | Uneven | Observe first | PARTIAL | NO | P1 |

### 2.6 Empty / loading

| Pattern | Industry bar | Eden today | Gap | Must? | Moat? | Pri |
|---|---|---|---|---|---|---|
| QueryState default | Linear | ×6 refs | Hub adoption | YES | YES (terminal empty) | P0 |
| No blank Suspense | Stripe | ×2 remaining | Ban outside overlays | YES | NO | P0 |

### 2.7 Dashboard / KPI

| Pattern | Industry bar | Eden today | Gap | Must? | Moat? | Pri |
|---|---|---|---|---|---|---|
| Calm Home | Datadog scan | Dashboard score **0.0** / 1 band | Keep calm; don’t import Observe chrome | PARTIAL | YES | P1 |
| Hub KPI cap | Restraint | Alerts severity strip stacks bands | Thin strip or overflow | PARTIAL | NO | P0 |

### 2.8 Settings

| Pattern | Industry bar | Eden today | Gap | Must? | Moat? | Pri |
|---|---|---|---|---|---|---|
| Single title | Stripe | dual_title **N** | Done — don’t regress | YES | NO | — |
| Tab count clutter | Helicone ~9–10 | 19 visible | Collapse Advanced groups | PARTIAL | YES (governance) | P1 |
| Org once | — | Fixed | Don’t reintroduce page Select | YES | NO | — |

### 2.9 Satellite hubs (copy Trace grammar)

| Hub | Score / bands (W1) | Industry cue | Gap | Pri |
|---|---|---|---|---|
| Alerts | 5.5 / 4–5 | Helicone lean list | Collapse severity + ack strips | P0 |
| Artifacts | 6.5 / 5 | — | Worst clutter; Resource OS + overflow | P0 |
| Audit | 5.0 / 4 | Quiet governance | Quiet Resource OS | P0 |
| Agents | 4.0 / 4 | Helicone Sessions | Kill CrossLinkBar band | P0 |
| Issues | 4.0 / 4 | Braintrust Filters | Status strip into filters | P0 |
| Improve | 1.5 / 3 | — | CrossLink → overflow | P1 |
| Evals | 0.0 / 2 | LangSmith compare discipline | Keep ≤2; don’t add filter band badly | P1 |
| Guardrails / Studio | Top-20 | — | Wrong-role density | P1 |

### 2.10 Density / card-nest

| Pattern | Industry bar | Eden today | Gap | Pri |
|---|---|---|---|---|
| Role density | Datadog | Chrome micro-typed; Transcript densest | Calm chrome; tokenize instrument | P0 |
| Flatten nests | Peers: hairlines | Observe nest depth ~5 | One chrome owner; less boxes-on-boxes | P0 |

---

## 3. Priority roll-up (declutter)

```
P0 band-budget:     Traces ≤2 → Alerts/Agents/Issues/Artifacts/Audit copy grammar
P0 overflow:        CrossLinks · legacy · facets-as-presets · SQL/Live extras
P0 hide-via-views:  columns+sort+filter dirty amber
P0 states:          QueryState · ban blank Suspense
P0 density-role:    shell/hub calm; Transcript tokenize
P1:                 Settings Advanced collapse · Display menu · Live control · AI citations
P2:                 SQL depth · Loop/render templates · filter undo
```

---

## 4. Wave 3 exit

- [x] Gap matrix refreshed to W1 Top-20 + W2 systems  
- [x] Must-match emphasizes **calm chrome / progressive disclosure**  
- [x] Moat keep explicit  
- [x] Feeds Pattern Library §1 + Laminar contracts declutter lines  
- [x] No product UI code; Wave 4 owns binding Design Brief / anti-clutter contract docs

*End of w2-gap-matrix (Wave 3 refresh).*
