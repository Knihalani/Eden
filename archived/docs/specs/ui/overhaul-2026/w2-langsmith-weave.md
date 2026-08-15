# Wave 3 — LangSmith & Weave (eval compare chrome discipline)

**Agent:** `w3-langsmith-weave`  
**Date:** 2026-07-20  
**Docs:** [Compare experiment results](https://docs.langchain.com/langsmith/compare-experiment-results) · [Analyze experiment](https://docs.langchain.com/langsmith/analyze-an-experiment) · [Filter traces](https://docs.langchain.com/langsmith/filter-traces-in-application) · Weave: Weights & Biases eval/trace UX (peer)  
**Baseline:** Evals hub **2 bands / score 0.0** (calm) — protect; Studio/experiments leaves risk chrome piles; Top-20 Studio

---

## Steal — compare without chrome explosion

### S1 — Compare is a mode, not a new shell

LangSmith: select experiments → **Compare** view. Filters and display toggles (Compact / Full / Diff) live in the **compare toolbar**. Details panel toggles **Details | Traces** — progressive, inside the panel.

**Eden:** Keep Evals ≤2 bands. Compare/diff controls belong in experiment leaf toolbar or detail — **not** new hub bands.

### S2 — Filter Shortcuts as side panel (optional)

LangSmith Filter Shortcuts sit in a **right sidebar** of attribute chips — useful power UX.  
**Eden caution:** A permanent shortcuts rail on Traces would recreate band overload. Prefer overflow / optional panel when `?filters=open`, not always-on.

### S3 — Saved filters scoped to project

Custom trace filters saved per project — aligns with Laminar scoped views.

### S4 — Column filters in headers

Per-column filter icons — power without a global third band (use sparingly; don’t stack with facet runways).

### S5 — Weave / W&B cue

Weave emphasizes run comparison and trace inspection with **focused panels**; avoid dashboard-widget walls on eval leaves.

---

## Eden gap

| Surface | Risk | Steal |
|---|---|---|
| Evals hub | Currently calm (2 bands) | Don’t add filter/KPI bands carelessly |
| Studio | Top-20 sprawl | One toolbar grammar; purge accent CTA piles |
| Experiments compare | May invent snowflake chrome | LangSmith compare toolbar discipline |
| Trace filters | Filter Shortcuts temptation | Optional panel only |

---

## Priority

| ID | P |
|---|---|
| S1 Compare mode toolbar | P0 (Evals leaves) |
| S2 Shortcuts optional | P1 — never always-on hub |
| S3 Saved filters scoped | P0 |
| S4 Column header filters | P2 |
| S5 Weave panel focus | P1 |

**Non-goal:** Pixel-clone LangSmith; expand U12 for Datasets/Experiments leaves without IA program.

*End of w2-langsmith-weave (Wave 3).*
