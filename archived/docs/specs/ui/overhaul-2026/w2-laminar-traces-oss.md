# Wave 3 — Laminar traces OSS (≤2 bands · overflow)

**Agent:** `w3-laminar-traces`  
**Date:** 2026-07-20  
**Scope:** Docs only. Master–detail + what Laminar **hides**.  
**Baseline:** W1 Traces **3 bands** (PageHeader + Tabs + QueryFilterBar); facets/legacy in More  
**Docs:** [Viewing Traces](https://laminar.sh/docs/platform/viewing-traces) · [Table views](https://laminar.sh/docs/platform/table-views) · [Live tracing](https://laminar.sh/docs/platform/live-tracing)

---

## P0 summary

| Pattern | Laminar | Eden | Steal |
|---|---|---|---|
| **≤2 list chrome bands** | Tabs + one table toolbar | **3 bands** FAIL | Merge tabs into toolbar band |
| **Hide secondary tools** | SQL / Chat / Metadata / Timeline in **detail** toolbar or Trace dropdown | More (good) — must stay off tab row | Overflow forever |
| **Modes in detail** | Transcript default; Tree dropdown; Timeline toggle | Mode UX uneven; hub chrome distracts | Progressive disclosure in panel |
| **Master–detail** | `?traceId=` side panel; Esc clears | `DetailPanelShell` present | Keep; don’t navigate-away |

---

## What Laminar hides (progressive disclosure)

| Capability | Where it lives | Not on list chrome |
|---|---|---|
| Tree / custom render templates | Trace view-mode **dropdown** | ✓ |
| Timeline Gantt | **Toggle** in trace header | ✓ |
| Metadata JSON | Toolbar button | ✓ |
| Chat with trace | Toolbar; span chips jump | ✓ |
| Open in SQL | Trace **dropdown** → new tab | ✓ |
| Subagent flood | Collapsed **cards** until click | ✓ |
| Wrapper/framework spans | Elided from transcript | ✓ |
| Column clutter | Hidden into **table views** | ✓ |

---

## Hub composition (peer)

```
Header path "traces" (thin)
└── Tabs: traces | spans | sessions
    └── ONE toolbar: search · filters · date · views · columns · live · refresh
        └── Infinite table
            └── Side panel when ?traceId=
                └── Transcript (default) | Tree | Timeline | Metadata | Chat
```

Eden today:

```
PageHeader Observe/Traces     ← band 1
Tabs traces|spans|sessions    ← band 2
QueryFilterBar+Views+More     ← band 3  ← FAIL
```

**Target:** bands 2+3 become **one** toolbar band (tabs sit with filters).

---

## Pattern notes

| ID | Pattern | Priority |
|---|---|---|
| T1 | Hub views = list modes only (`traces|spans|sessions`); legacy ≠ `view=` | P0 |
| T2 | Single toolbar under/with tabs | P0 |
| T3 | Facets = filter presets, not chip band | P0 |
| T4 | Detail modes via dropdown/toggle | P0 |
| T5 | Esc closes detail URL params | P1 |
| T6 | Live = one control | P1 |
| T7 | Sessions may full-page (Laminar evolved) — OK if list chrome stays calm | P2 |

---

## Declutter acceptance (traces research)

- [ ] Explicit hide-list for SQL/Chat/Metadata/Timeline/legacy  
- [ ] Band-budget target ≤2 with composition diagram  
- [ ] Transcript-first + collapsed subagent cards noted for detail work  

*End of w2-laminar-traces-oss (Wave 3).*
