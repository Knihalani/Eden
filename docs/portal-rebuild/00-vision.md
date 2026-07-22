# 00 — Vision

> **Status:** Authoritative  
> **Decision date:** 2026-07-21  
> **Supersedes:** Incremental overhaul narratives in `clients/portal/PORTAL_*.md`  
> **Companion docs:** [01-product-bible.md](./01-product-bible.md) · [02-information-architecture.md](./02-information-architecture.md) · [README.md](./README.md)

---

## 1. Problem statement

Eden’s portal today fails the only user who matters tonight: a solo AI engineer whose agent is misbehaving in production and who needs a trustworthy instrument panel — not a marketing dashboard, not a hub of hubs, not seventy-five routes that disagree with each other.

The failure modes are structural, not cosmetic:

| Failure | What the engineer experiences |
|---------|-------------------------------|
| **Cluttered chrome** | Competing bands, decorative cards, KPI spam, purple SaaS glow. The eye never finds the agent. |
| **Hub-of-hubs** | Observe / Improve / Evaluate each spawn secondary hubs that spawn tertiary tabs. Navigation becomes archaeology. |
| **Dual entry points** | Same concept reachable via two or three URLs (`/observability` vs `/traces`, `/signals` vs `/alerts`, `/promotions` vs `/ledger`). Trust collapses. |
| **Agent buried** | Agents live under “Advanced.” The primary object of the product is demoted behind generic telemetry. |
| **Observe ≠ Improve** | Failure diagnosis and fix artifacts live in different mental models. Closing the loop requires too many clicks and too much context loss. |
| **Mobile broken** | First adaptation failure. Phone becomes a bounce, not a triage surface. |
| **Visual wrongness** | Placement, density, and components read as unfinished SaaS. Success criterion inverted: the user thinks “that looks wrong.” |

Incremental waves cannot recover trust. The rebuild is a greenfield product UI on a teardown stub (mode **A**), governed by this directory as the contract.

**Out of scope for this problem (explicitly preserved):** the docs site; i18n (`en` / `de`).

---

## 2. Vision paragraph

Eden Portal is the **agent-centric operating system** for debugging and improving AI agents: gateway-captured truth in, transcript-first observation, Signals-style diagnosis, and a closed path from failure → plan → artifact → PR — all in one dark, dense, calm product. The landing page is not a Helicone-style KPI card wall; it is an **agent-first home** (Laminar energy) that answers: *what are my agents doing, what is broken, what do I do next?* The AI assistant is a first-class `/agent` surface plus a floating clickable bubble — always one click from the current evidence. Brand: precise, technical, calm; dark-terminal; Terminal Blue for action; Phosphor Green only for running/active; Geist Sans / Geist Mono. When an engineer opens Eden at 11pm, they should feel: *I trust this with my production traces.*

---

## 3. Dual wedge (locked)

Eden wins on **both** sentences. Neither is optional marketing copy; both are product architecture.

### Wedge A — Closed loop

```
failure → fix artifact → PR
```

- Failures surface as Issues / Alerts / Findings with evidence links into Traces/Sessions.
- Improve owns the queue: Plan → Artifact → Promotion → PR (and ledger memory).
- PRs are a **first-class Improve outcome**, not a side quest.
- Max-click contracts live in [01-product-bible.md](./01-product-bible.md) (closed-loop grammar).

### Wedge B — Gateway + observe + improve in one product

```
gateway ingest → observe (trace/session) → diagnose → (optional eval) → improve → ship
```

- The OpenAI-compatible gateway (and SDKs) are how truth enters the product.
- Observe is transcript-first, agent-as-primary-object.
- Improve is not a separate “AI ops” product bolted on — it consumes the same objects.
- One org, one agent identity, one evidence chain from span → issue → artifact → PR.

**Refuse in v1:** red-team UI. Guardrails ship as **policies** only (no attack-simulation surface).

---

## 4. Who it’s for

| Priority | Persona | Lens |
|----------|---------|------|
| **Primary** | Solo AI engineer debugging their agent **tonight** | Trace → root cause → fix path. Density, keyboard, honesty about timestamps/units. |
| **Secondary** | EM / platform lead | Same surfaces, later lens: cost, regression rate, coverage, audit. Board-trustworthy numbers without re-running math. |

Secondary never gets a separate “manager app.” Same IA, same objects, different default filters and Dashboard tiles over time.

Full persona detail: [01-product-bible.md](./01-product-bible.md).

---

## 5. Emotional goal

> **I trust this with my production traces.**

Sub-feelings that must hold on first session:

| Emotion | Product proof |
|---------|---------------|
| **Calm** | Dark-terminal, restrained motion, no decorative glow, Phosphor Green only when something is actually running. |
| **Oriented** | ≤12 core nav leaves; agent is a core group; landing answers “what next?” in one glance. |
| **Capable** | Transcript-first reader; issue → improve without losing `traceId` / filters. |
| **Honest** | Units, timestamps, cost, and scores labeled; empty ≠ loading ≠ filtered-empty. |
| **Closed** | Every failure path offers a next Improve action or an explicit “not actionable yet.” |

Anti-emotion: *ooh, that looks wrong.* Any surface that triggers this fails the 30-day success bar.

---

## 6. Laminar north star

**UI grammar to steal wholesale** (intent, not pixel-for-pixel cloning):

| Steal | Why |
|-------|-----|
| **Dark, dense chrome** | Instrument panel, not marketing. |
| **Transcript-first** | Message stream is the default canvas; tree/timeline are modes. |
| **Agent as primary object** | Agent list / agent page energy on Home and `/agents`. |
| **Signals-style diagnosis** | Failure/signal language that points at evidence, not vanity metrics. |
| **Clean chrome budget** | ≤2 bands; ≤5 primary toolbar actions per surface. |
| **Master–detail that doesn’t unmount the list** | Select row → detail; Esc closes; URL holds selection. |

**Eden-unique (do not dilute to become Laminar clones):**

| Eden-unique | What it means in product |
|-------------|--------------------------|
| **Gateway as product story** | Connect agent tonight via gateway/SDK; first-run journey centers ingest, not “invite teammates.” |
| **Improve / PR closed loop** | Plans, artifacts, promotions, PRs, ledger — first-class, not a blog post about “AI suggestions.” |
| **Dual wedge unity** | Observe and Improve share object identity (Agent, Trace, Issue, Artifact). |
| **Dedicated AI Agent page + bubble** | `/agent` plus floating bubble; cited to real org data. |
| **Guardrails as policies (no red-team UI)** | Policy CRUD and attachment; attack-sim surface killed. |
| **Audit packs** | Compliance / chain-verified audit as a must-ship Workspace surface. |
| **Debugger / replay / time-travel** | Must-ship; deep-linked from traces without inventing a second Observe product. |

Brand anchors (from `.impeccable.md`): precise / technical / calm; backgrounds `#03060A` → `#151B23`; accent Terminal Blue `#5B9EFF`; Phosphor Green `#5FE5A8` = running only; Geist Sans + Geist Mono; motion answers “did something change?”

**Kill visually:** purple SaaS glow, decorative cards, KPI card spam, hub-of-hubs, dual routes, clutter, red-team.

---

## 7. Non-goals (v1)

| Non-goal | Rationale |
|----------|-----------|
| Red-team / attack-simulation UI | Explicit refuse (Round 1). Guardrails = policies only. |
| Prompts registry as core nav | **Later.** No top-level Prompts leaf in v1 rebuild. |
| Analytics / users / tools / topics as core | **Later.** Soft-redirect old URLs; do not rebuild as hubs yet. |
| Helicone-style KPI dashboard as landing | Landing is agent-centric OS, not card spam. |
| Hub-of-hubs IA | One leaf per concept; tabs/modes under that leaf. |
| Dual routes for the same concept | Canonical URL + redirect map only. |
| Separate “manager product” | Secondary persona uses same surfaces. |
| Docs site rewrite | Docs untouched; link out to quickstart. |
| Dropping i18n | Keep `en` / `de` via `next-intl`. |
| Decorative Phosphor Green / purple glow | Brand violation. |
| Marketplace / builder / sandbox / multi-agent playgrounds as product | Already removed or soft-land; stay dead. |
| Incremental “wave N polish” of the old portal | Teardown mode A — delete, stub, rebuild. |

---

## 8. Success criteria

### 8.1 Feel (30-day qualitative bar)

An engineer who has never seen the rebuild should, within **60 seconds** of login:

1. Say (or think): **“This looks good — I can use this.”**
2. Point correctly at: where agents live, where traces live, where to start a fix.
3. **Never** think: “ooh, that looks wrong.”

Additional feel checks:

- Dashboard reads as **agent OS**, not KPI collage.
- Opening a failing trace defaults to **transcript**.
- Issue → Improve preserves evidence identity in the URL.
- Mobile bottom nav (5 items) reaches the overnight triage path without “More” archaeology for core jobs.
- AI bubble is visible and opens context-aware chat; `/agent` exists as a real page.

### 8.2 Measurable (instrument after P1+)

| Metric | Target (directional) | Notes |
|--------|----------------------|-------|
| Core nav leaf count | ≤ **12** | Enforce in sidebar config tests. |
| Distinct product concepts with dual top-level routes | **0** | Redirect map only. |
| Time-to-first-trace (empty org → gateway connect → visible trace) | ≤ **15 min** documented; measure in onboarding funnel | First-run journey in bible. |
| Clicks: Issue → open linked Trace with filters preserved | ≤ **2** | Closed-loop grammar. |
| Clicks: Issue → create Improve Plan | ≤ **3** | Closed-loop grammar. |
| Clicks: Artifact → open PR suggestion / create PR flow | ≤ **3** | From artifact detail. |
| Routes under authenticated portal (real pages, not redirects) | Far below legacy ~75; target **≤ ~25** path templates | See IA routes table. |
| i18n coverage on new chrome + must-ship surfaces | **100%** keys for `en` + `de` | No hardcoded user-visible strings. |
| WCAG AA body text / AA non-text borders | Pass on shell + must-ship | Token discipline. |
| `prefers-reduced-motion` | Honored for ambient motion | Design system. |

Feel overrides spreadsheet: if measurable is green but feel fails, the surface is not done.

---

## 9. Principles (ranked)

Resolve conflicts in this order. Higher always wins.

| Rank | Principle | Application |
|------|-----------|-------------|
| **1** | **Legibility** | Density without unreadability. Contrast, mono micro-labels as recipe, empty≠loading. |
| **2** | **Agent-first** | Agent is a core nav group and Dashboard’s primary object. Telemetry serves the agent, not the reverse. |
| **3** | **Closed-loop honesty** | Every Observe surface must offer a truthful next step into Improve or an explicit dead-end. |
| **4** | **One concept, one URL** | Modes/tabs/query — not sibling hubs. |
| **5** | **Transcript-first Observe** | Default canvas is the conversation/tool stream; tree/timeline/meta/scores are modes. |
| **6** | **Chrome budget** | ≤2 bands; ≤5 primary toolbar actions; no decorative cards. |
| **7** | **Gateway as day-0 truth** | Empty states teach connect-via-gateway/SDK, not feature tourism. |
| **8** | **Restraint (brand)** | Precise, technical, calm. Terminal Blue = action; Phosphor Green = running only. |
| **9** | **Keyboard & deep links** | Cmd+K, Esc, URL state = shareable truth. |
| **10** | **Same surfaces, dual lens** | Primary eng tonight; secondary EM later — no fork. |
| **11** | **Motion has a job** | 150–300ms state/layout; ambient only if sub-attentional + reduced-motion safe. |
| **12** | **Docs & i18n preserved** | Never “temporary English-only” or in-app docs rewrite. |

---

## 10. What “done” means for P0 (teardown)

P0 is **not** a usable product. P0 is a deliberate stub that proves the rebuild can start clean.

### 10.1 Documentation done

- [x] This vision (`00-vision.md`)
- [x] Product bible (`01-product-bible.md`)
- [x] Information architecture (`02-information-architecture.md`)
- [ ] Competitive synthesis, design system v2, surface specs, engineering runbooks (tracked in README reading order)

`docs/portal-rebuild/` is the contract. Code that contradicts it is a bug.

### 10.2 Teardown mode A done

Per Round 1 decision **D9 / Q11**:

1. **Delete** authenticated portal app surfaces (routes/components that constitute the old product UI) according to `engineering/01-teardown-runbook.md`.
2. Leave a **stub shell**: auth still works; chrome may be minimal; pages do not pretend to be the old product.
3. Stub points engineers at **these docs** until rebuild phases land.
4. **Do not** keep half-living hubs “for convenience.” Dual routes and dead concepts go to the kill list / redirect map.
5. **Preserve:** docs site; i18n plumbing (`en`/`de`); design tokens that match `.impeccable.md` where the stub still renders UI.

### 10.3 Explicitly not done at P0

- Must-ship surfaces implemented
- Dashboard agent OS
- Improve PR loop
- Mobile polish
- Feature parity with legacy portal

Those begin at **P1** (shell + design system) per README phase table.

### 10.4 Exit criteria checklist (P0)

| Check | Pass condition |
|-------|----------------|
| Authority docs | Vision + bible + IA present and mutually consistent |
| Teardown | Old product UI removed or unreachable except via documented stub |
| No false product | User cannot navigate a “zombie” Improve/Observe that looks half-real |
| Docs site | Untouched and linked externally |
| i18n | Locale wiring retained for rebuild |
| Kill list | Red-team, dual hubs, clutter patterns banned in engineering kill list |
| Next phase ready | P1 can implement shell from IA + design system without rediscovering product |

---

## 11. Phase north stars (post-P0)

| Phase | Outcome in one line |
|-------|---------------------|
| P1 | Auth, sidebar (FINAL IA), header, kit, i18n, empty Dashboard |
| P2 | Agents + Dashboard agent-first home |
| P3 | Observe: Traces/Sessions/Issues/Alerts — transcript-first |
| P4 | Evals hub |
| P5 | Improve queue → artifact → PR; Cost + Guardrails policies |
| P6 | `/agent` + bubble; Debugger sessions / replay / time-travel |
| P7 | Settings, Audit, mobile QA, density pass |

---

## 12. Change control

1. Update the relevant doc in this directory.  
2. Bump decision date or append a dated note in `04-interview-log.md`.  
3. Never silently diverge in code.  

**Locked Round 1 IDs (D1–D10)** are listed in [README.md](./README.md). Contradicting them requires an interview amendment, not a PR description.

---

*End of 00-vision.md*
