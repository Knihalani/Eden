# Wave 3 — Helicone IA (lean nav · Settings tab count = clutter lesson)

**Agent:** `w3-helicone`  
**Date:** 2026-07-20  
**Sources:** Helicone OSS Sidebar / settingsLayout; [Requests](https://docs.helicone.ai/) observability docs; dashboard IA (Requests · Sessions · Users · Models · Properties)  
**Baseline:** Eden Settings **19 visible tabs / 6 groups**; dual_title **N**; Advanced dump; U12 ≤12 OK

---

## Why Helicone matters for declutter

Helicone’s product chrome is **lean**: high-frequency observe leaves at top level; everything else in **named** accordion groups; Settings ≈ **9–10** tabs in 3 sections (Organization / Developer / Accounts). Request detail is a **drawer**, not a navigate-away + second title stack.

**Lesson:** Tab count and unnamed “Advanced” buckets are clutter — even when titles aren’t duplicated.

---

## Patterns

| ID | Pattern | Helicone | Eden gap | P |
|---|---|---|---|---|
| H1 | Top-level only for highest-frequency | Dashboard + Requests | Keep Traces/Issues/Alerts core; don’t promote Cost as peer chrome | P0 |
| H2 | Named accordion groups | Segments / Improve / Monitor | Advanced is one opaque dump | P0 |
| H3 | Atomic → session progressive drill | Requests list → drawer → Sessions | Good Trace detail direction; kill dual orphan routes | P0 |
| H4 | Cost inside observe views | Metrics on request/session | Cost as Advanced leaf OK; don’t dual-chrome deep links | P1 |
| H5 | Settings ~9–10 tabs | 3 sections | **19** visible — collapse Advanced groups | P1 |
| H6 | Configure in footer | Settings entry once | Don’t reintroduce dual Settings title | P0 |
| H7 | Request drawer | List stays | Master–detail parity | P0 |

---

## Settings clutter lesson (binding input for Wave 4/9)

| Metric | Helicone | Eden live |
|---|---|---|
| Visible settings destinations | ~9–10 | **19** |
| Sections | 3 named | 6 groups |
| Dual title | No | **N** (fixed) |
| Dual org | Avoid | Fixed |

**Steal:** Collapse rarely-used tabs into Advanced (default collapsed). Search stays. Governance tabs may remain but must not all shout at equal volume.

---

## Anti-patterns (Helicone itself)

Helicone sometimes dual-mounts Alerts (Monitor + Settings) — **don’t copy**. Eden redirect/embed map should stay single-job.

---

## Priority roll-up

1. Named groups > opaque Advanced (IA)  
2. Settings tab collapse (clutter)  
3. Drawer/detail without navigate-away  
4. Keep U12 — Helicone lean is inspiration, not a license to add core leaves  

*End of w2-helicone-ia (Wave 3).*
