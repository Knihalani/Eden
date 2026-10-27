# R10 — Domain audit: coding-only assumptions in the retrieval decision

**Dated 2026-10-18.** Part A of R10. Eden ships first on Claude Code, but the same store and retrieval are meant to serve personal assistants, proactive agents, coworkers, tutors and companions (the user, 2026-10-18). This audit lists every place where the **core retrieval decision** (what to inject, when, and when to stay silent) assumes a coding agent. It does not propose removing the coding machinery: paths, slots and git classes stay as the coding host's adapters. It asks that the core not depend on them.

Read with: `DECISIONS.md` D1–D37, `A4-DELIVERY-CONTRACT.md`, `A7-CUES.md`. New slices: `ROADMAP.md` Phase 8; arms: `A5-EVALUATION.md` §4 "Beyond coding" (proposed here, built by P8.6).

## 1. Findings

| # | Where | Coding-only assumption | Why it breaks for other agents | Severity |
|---|---|---|---|---|
| F1 | D1, A4 §1 | The store is keyed by a git common dir; with no git, by the SessionStart cwd | An assistant, tutor or companion has no repo and often no meaningful cwd. Every conversation of one user would land in whatever folder the host happened to start in, or in one undivided store | high |
| F2 | D3–D5, A4 §2 | Scope = a repo folder from manifests; the read set comes from file paths (D4) | The personal analogue of "place" is the **entity or life area in play** (Sam, the kitchen renovation, the Lisbon trip, work vs home). There are no paths, so the place signal is empty and every memory is in one scope | high |
| F3 | A7 §4, P4.3 | STRONG evidence is an **identifier-shaped** token (path, `ERR_*`, flag, version). P4.3 demotes capitalised names in prose ("TypeScript", "GitHub") to MEDIUM words | In a personal store the most diagnostic cue is a **person or place name** ("dinner with Sam" → Sam's diet). Under P4.3's rule "Sam" is a plain word that needs a second word to admit anything | high |
| F4 | D16, A7 §3 | The situation cue is prompt ⊕ previous turn ⊕ **path tokens** ⊕ previous assistant message | Non-coding situations carry other state: the date and time, the calendar, the recipient of a message being drafted, the location, the open document. None is a cue part | high |
| F5 | D18, A7 §5 | Compiled action classes are git/dev actions (merge, push, deploy, delete, dependency…) | The personal high-stakes actions are **book, buy, send, schedule, pay, cancel, share**. Their policies ("never book layovers over 3 h", "don't schedule before 10 am") are exactly D18's shape, but the lexicon and the PreToolUse `if` map have none of them | high |
| F6 | D19, A4 §5.4 | The guard matches Bash command strings (`Bash(git merge*)`) | Personal agents act through MCP/tool calls (`calendar.create_event`, `gmail.send`, `shop.checkout`). The guard's matcher needs tool-name + argument patterns, not shell globs | medium |
| F7 | D23, A4 §5 | Delivery is reactive: a human Submit, SessionStart, SubagentStart, tool batches | A **proactive** agent wakes on events (a calendar alarm, an incoming message, a time of day) with no user prompt. There is no delivery point and no cue for "Lunch with Priya in 1 hour" → "Priya is coeliac" | high |
| F8 | D7, D8, P3.3–P4.4 | The slot table is ~15 dev slots, mined from lockfiles | Personal "slots" are per-entity attributes (diet, allergy, birthday, address, preferred airline). They are open-ended and keyed by entity, not a fixed table | medium |
| F9 | D9 | Temporal qualifiers make intents that expire after 7 days or on action completion | Personal plans carry **explicit dates** ("dentist on the 28th") and recurrences ("swim on Wednesdays"). A plan whose date has passed is stale whatever its age; a routine is never stale. A 7-day expiry is wrong both ways | medium |
| F10 | A7 §2 | Turn modes `debug`, `how-to` and the `continuation` rule after a proposal are coding-tuned | Fine as lanes, but a non-coding host also has `planning`, `drafting-to-someone`, `emotional` turns, where what is needed differs (a companion turn should not get logistics) | low |
| F11 | A7 §4, D17, P4.3 | The silence set and τ seeds are R1/R8 coding negatives | τ calibrated on coding chatter says nothing about a personal store, where hard negatives share names and places ("what's the capital of Portugal?" vs the Lisbon trip) | medium |
| F12 | A5 §4 | Every cue arm (CueBench-code, policy-trigger) is coding | Nothing gates a regression for other agents. **Proactive need** (the agent should surface a memory the user never asked about) is not measured at all | high |
| F13 | D26, D27 | Residual and shadow sets read CLAUDE.md, AGENTS.md, MEMORY.md | Other hosts have a system prompt or a profile; the "already in context" check needs a host-neutral input (any text block the host declares as in-context) | low |
| F14 | D10, P4.5–P4.6 | Gotchas and how-to lanes are error-signature and command shaped | Lanes, not core: they stay coding adapters. The core should allow other lanes (e.g. a "person card" lane) without special cases | low |

## 2. What is already domain-general

- The ledger (D25), refractory and re-eligibility: per window, host-neutral.
- Supersession and history (D6, A4 §3.1–3.2), once a slot is "entity × attribute" (F8).
- The trust gate (D12–D13): authority by entry type and paste stripping hold for any chat host.
- The packet shape and the silence-first stance (D28): silence matters more for a companion than for a coding agent.
- Sleep-time heavy work (D34) and the no-model hot path (D15) are constraints, not coding assumptions.

## 3. What this asks of the plan

1. A **host-neutral situation**: `situation = {prompt?, prev_turn?, prev_assistant?, paths?, entities_in_play?, now, calendar_window?, recipient?, event?}`; the coding host fills `paths`, others fill the rest. One retrieval core scores whichever parts are present (P8.2).
2. **Entities as place**: an entity layer (people, places, pets, projects, trips) extracted at write, used as scope and as STRONG evidence when an entity's own name (not a common word) appears (P8.3; a DECISIONS proposal to revise A7 §4's "names in prose" rule for non-code stores).
3. **Personal action classes and a tool-call guard**: book / buy / send / schedule / pay / cancel / share, with MCP tool-name matchers (P8.4).
4. **Dated validity**: plans with dates expire when the date passes; routines recur; corrections supersede by entity × attribute (P8.5).
5. **A proactive delivery point**: an event-driven cue for hosts that wake without a prompt (`eden memory recall --situation <json>` in the SDK/wrap) (P8.7).
6. **Arms that gate it**: LifeBench (`benchmarks/memory-life/`) with direct, paraphrase, proactive, multi-memory, stale-vs-current and hard-negative cues, dev/test and a sealed holdout (P8.6, A5 §4).

Which of these the research supports, and how much each buys, is R10's question (`R10/STATE.md`). The slices are planned now so their arms exist before any of them is built.
