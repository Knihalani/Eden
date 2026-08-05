# F15 — Pass 4 notes (Agent B: UX/Value)

**Headline: the doc's "concrete gap" is largely wrong.** eden already has a shipped, GA-by-default,
end-to-end system that is *literally named* Artifacts (a shadow→promoted→archived behavior-change
record built on `nudges`, authored by a class called `ArtifactAuthor`) plus a companion versioned,
chaptered per-agent knowledge doc *literally named* the "Book"/"Ledger" (`agent_books` /
`agent_ledgers` + `ledger_entries`), both gated by feature flags named `artifacts_v1` and
`ledger_v1` that default **on**. There is a full REST surface (`/orgs/{org_id}/artifacts`,
`/orgs/{org_id}/ledger`, `/orgs/{org_id}/agents/{agent_id}/book`) and even portal route
registrations for `/artifacts` and `/ledger` — currently wired as **dead stub routes** that
soft-land on `/improve?mode=queue` (`clients/portal/src/lib/stub-try-instead.ts:9,22`). The
699-line doc under review reinvents this mechanism from scratch (new `agent_artifacts` table, new
API surface, new portal tab) without ever discovering it, despite citing the exact file
(`kb/flywheel/coordinator.py` as "flywheel coordinator") that is one `from eden.nudges.author
import ArtifactAuthor` away from the answer. Full detail in NEW FINDINGS below. This materially
changes the right scope of work: **it is a UX/wiring problem (surface what exists, on the routes
that already exist for it), not a schema-design problem.**

The USER EXPERIENCE & VALUE section below is written to reflect what browsing this actually
should look like given what's real today, not a hypothetical greenfield design.

---

## USER EXPERIENCE & VALUE (primary)

### 1. What a user is actually looking at

Not one artifact — three layers, all real, all per-`(org_id, agent_id)`, that a portal page needs
to compose into a single view:

- **The Book (prose, versioned, chaptered).** `BookGenerator._synthesize()`
  (`src/eden/kb/book/generator.py:91-136`) renders exactly four fixed markdown sections every time:
  *Recent failures* (last 10 resolved `agent_issues`, title + kind + stumble_count), *Proven
  fixes* (last 5 `nudges` in `mode='promoted'`), *Tool/MCP gotchas* (currently a static stub
  string — `_DEFAULT_CHAPTERS`, `:11-22` — not yet populated from real data), and *Do-not-repeat*
  (archived nudges + regressions). Each call increments `agent_books.version`
  (`generate()`, `:44-53`, `MAX(version)+1`) and stores `content_md` + `token_count`. This is
  precisely "a record of how yours is supposed to work" in prose form — already built, already
  versioned. What a user reads on a Book page is four headers and a handful of bullet points, not
  free-form LLM essay text — closer to a structured changelog than an essay, which is good for
  scanability but means the "prose" half of the product-owner's copy is thinner than Lemma's
  `knowledge_preview` sounds.
- **The Ledger (structured, weighted, cited, embedded entries — the retrieval-grade version of the
  same idea).** `agent_ledgers` + `ledger_entries` (migration `100_artifacts_ledger.py:18-49`):
  each entry has a `chapter` (`recent_failures` | `do_not_repeat` seen in code), `text`,
  `citations` (JSONB array — e.g. `["artifact:{nudge_id}"]`, `upsert_from_issue()`
  `kb/ledger/generator.py:60-68`), a `weight` (do-not-repeat entries get `weight=10.0`,
  `:98` vs default `1.0`), a `version`, and an `embedding` (`embed_text()`, used by
  `LedgerRetriever` for semantic packing into the live prompt). `diff_since_version()`
  (`:190-214`) is a **already-built version-diff query** — `SELECT ... WHERE version >
  since_version ORDER BY created_at ASC` — exactly the "diff view across versions" the task brief
  asks whether this should look like. It does, and eden already has the query for it; there's a
  route for it too (`GET /agents/{agent_id}/ledger/diff`, `api/routes/learn.py:538-551`).
- **Artifacts (individual behavior-change records, not one blob — a list with a lifecycle).**
  `nudges` rows (migration `092_market_ready_consolidated.py:144-168`): each one is `{trigger,
  action_type, content, mode}` where `mode ∈ {shadow, promoted, archived}`. A user browsing
  `/artifacts` for an agent would see a **list of small, individually-actionable behavior
  patches** — "when the prompt contains `refund_policy`, append this guardrail text" — each
  tagged with its lifecycle stage, not a single prose document. This is the more Lemma-`Issues`-
  adjacent unit; the Book/Ledger is the more Lemma-`learn_agent_kb`-adjacent unit. **The product
  copy conflates these two eden already keeps separate**, and a good UX should probably keep them
  separate too (a "what changed" feed of individual nudges, plus a "current state" prose Book) —
  see §6.

None of this is a diagram today. See §4.

### 2. Who consumes it, and why — three distinct audiences, three distinct surfaces needed

1. **The live agent itself, at request time — the most important and most overlooked "consumer."**
   `BookGatewayFilter.apply()` (`src/eden/llmops/filters/book.py:33-58`) injects the current Book
   (or, when `ledger_v1` is on, the `LedgerRetriever`-packed ledger text) directly into the
   outbound prompt: `request.prompt = f"<!-- eden-book:v{version} -->\n{excerpt}\n\n{request.prompt}"`
   (`_legacy_book_apply`, `:60-71`). **This means the "record" a human browses in the portal and
   the context actually steering the agent's next completion are the same artifact, versioned
   identically.** That is the single strongest "genuinely useful, not bookkeeping" argument
   available for this feature, and it already works today, gated behind `ledger_v1`/`artifacts_v1`
   (both GA-default-on per `preview/gates.py:12`). A portal Artifact page's opening line should be
   able to say, truthfully, "version 7 of this Book is live in production right now" — not "here is
   a summary someone generated," but "here is the actual context every request to this agent is
   currently receiving." No proposed redesign should give this up.
2. **An on-call/triage engineer, mid-incident.** `TriageAgent._gather_evidence()`
   (`src/eden/issues/triage_agent.py:319-358`, `_MAX_REACT_CALLS = 8`, `:47`) re-derives context
   from raw stumbles on every single triage call — this is the doc's own accurately-identified gap
   (its "concrete gap" point 5). The fix is not a new table; it's `TriageAgent` calling
   `LedgerGenerator().get_latest(org_id, agent_id)` (already returns
   `{ledger_id, version, entries: [{chapter, text, citations, weight}]}`,
   `kb/ledger/generator.py:101-142`) as a first, cheap pass before the 8-call ReAct loop. The UX
   payoff for this persona is speed-to-context, and it's a one-call fetch away today.
3. **A human browsing the portal to understand "what has this agent learned."** This is the
   audience the 699-line doc designs for, and it's real, but it's the *smallest*-leverage of the
   three — a human reading a summary is strictly less valuable than the same summary steering live
   behavior (persona 1) or accelerating triage (persona 2). Today this persona hits a dead end:
   `/artifacts` and `/ledger` are both registered portal routes that immediately redirect
   (`stub-try-instead.ts:9,22` — `"/artifacts": { href: "/improve?mode=queue" }`,
   `"/ledger": { href: "/improve?mode=queue" }`) with page descriptions already written
   (`page-descriptions.ts:32-35`: *"Soft-lands on Improve queue — versioned runtime fixes with
   evidence-gated promotion"* / *"...institutional memory and promotion history"*) — someone
   already scoped the product copy for these pages and never shipped the UI. **The actual UX gap
   in eden today is exactly these two dead routes, not a missing data model.**

### 3. Authoring / regeneration flow — already built, three real trigger paths

The doc's Phase 3 proposes exactly three regeneration triggers (prompt-version-changed,
issue-resolved, nightly-scout). eden already has issue-resolved and manual-NL wired, live:

- **Issue-resolved → shadow Artifact → evidence-gated promotion → Ledger chapter, fully wired,
  today.** `resolve_issue`'s flywheel side-effect (`agent_issues.py:207-223` per F13's citation)
  calls `KBFlywheelCoordinator.on_issue_resolved()` (`kb/flywheel/coordinator.py:25-44`), which —
  when `stumble_count >= 3` (`:32-33`) — calls `ArtifactAuthor().from_issue(org_id, issue)`
  (`:34-36`). That creates a `mode='shadow'` nudge from the issue's `triage_result.recommended_fix`
  (`nudges/author.py:47-77`) and enqueues it into `EvidenceGate` (`:75`,
  `promotion/evidence_gate.py`). Once promoted, `KBFlywheelCoordinator.on_promotion()`
  (`:215-244`) writes a `do_not_repeat` Ledger entry ("Proven fix: ...") or, if `ledger_v1` is off,
  regenerates the whole Book via `BookGenerator().generate(..., publish_mode="auto_publish")`
  (`:238-242`). **This is a complete, live regen-on-resolve pipeline** — the doc's Phase 3.2 (Est.
  "1 day", extending `resolve_issue`'s existing best-effort block) describes work that has already
  shipped, one file away from what it cites.
- **Manual/NL authoring is a real endpoint, not a proposed MCP tool.**
  `POST /orgs/{org_id}/artifacts/author` (`api/routes/learn.py:450-462`) calls
  `ArtifactAuthor().from_nl()` (`nudges/author.py:79-139`), which is budget-gated
  (`EvolutionSpendBudget.may_spend(0.01)`, `:96`) and only escalates to an LLM call
  (`route_async("artifact_author_nl", ..., slot="fast")`, `:108-119`) for descriptions over 200
  chars, behind a `nudge_author` feature-kill (`:104`) — a genuinely good cost-conscious authoring
  UX pattern (cheap template path first, LLM only when the input is long enough to need it) that a
  redesigned Artifact-authoring UI should keep, not replace.
- **Auto-demotion closes the "every dismiss updates what it looks for next" loop the doc
  flagged as unconfirmed for Lemma — and eden's version is outcome-driven, not click-driven.**
  `ArtifactDemotionWorker.run_once()` (`nudges/demotion_worker.py:11-89`) scans `nudge_outcomes`
  over a 7-day window (`:24-43`, requires `≥10` applications and a `>50%` real stumble rate — not
  an operator's opinion, the traced `outcome_success` of actual requests that received the nudge)
  and auto-archives regressed nudges (`gate.demote(...)` or `NudgeEngine().set_mode(...,
  "archived")`, `:74-79`), writing a "do not repeat" Ledger entry documenting *why* (`:80-85`). This
  is a stronger, already-built version of the doc's proposed `operator_confirms`/
  `operator_dismisses` counters — eden's mechanism doesn't wait on a human to click a button (which
  is exactly what's broken for `record_shadow_feedback` per F13), it demotes automatically from
  production outcomes. A UX for this should surface *why* something got demoted (the stumble-rate
  number, the 7-day window) as a first-class element, not bury it in a ledger paragraph.

The one genuinely-missing trigger from the doc's Phase 3 list is **prompt-version-changed** — no
code path today regenerates Book/Ledger/Artifacts when `PromptService.create_version()` fires.
That's a real, small, correctly-scoped gap (hook `prompt_versioning.py:223`, same as F13's P1
proposes for shadow-detector re-scout) — the one piece of Phase 3 that's actually still open.

### 4. Prose + diff, not a diagram — argue this explicitly, don't hedge it

The task brief asks: "a versioned doc? a diagram? a diff view across versions?" Grounded answer:
**versioned prose (Book) + structured diff (Ledger's `diff_since_version`), no diagram, at least
for v1** — and this isn't a cautious hedge, it's what the data supports:

- `grep -rl mermaid src/eden/ clients/portal/src/` returns **zero files**. There is no diagram
  rendering anywhere in eden's portal — no Mermaid.js dependency, no SVG-graph component, nothing
  a `behavior_diagram` field could render into on day one. The doc's own Phase 5 estimate
  ("1–2 days" for the whole portal tab, diagram included) does not price in standing up diagram
  rendering from nothing; that's realistically its own multi-day sub-task if kept in scope.
  Lemma's own `mermaid_preview` is a *preview string in an API response* per the doc's own market
  research (`docs.uselemma.ai`'s `get-issue-artifact-context` schema) — nothing in the evidence
  gathered this pass or last pass shows Lemma's own web app actually rendering it either, so
  parity pressure to ship a diagram in v1 is weaker than the doc implies.
- The diff view, by contrast, is **not aspirational** — `diff_since_version()`
  (`kb/ledger/generator.py:190-214`) and its route (`GET /agents/{agent_id}/ledger/diff`,
  `api/routes/learn.py:538-551`) exist today, unused by any portal page. Shipping "here's what
  changed since you last looked" is a rendering task against a working query, not new backend
  work — by far the highest UX-value-per-engineering-day item available here, and it directly
  answers "how has this agent's behavior changed" better than a static prose snapshot does.
- **Recommendation:** ship the diff view first (it's free — data model and query exist), keep the
  Book/Ledger prose as the "current state" tab, and treat a Mermaid diagram as an explicit,
  separately-scoped v2 investment requiring its own rendering-infra decision — not a checkbox item
  folded into "Phase 5, 1–2 days" as the doc currently has it.

### 5. What makes this genuinely useful vs. more internal bookkeeping — three concrete tests

1. **Does it change what the agent does, or only what a human reads?** eden already clears this
   bar via `BookGatewayFilter` — the record isn't just displayed, it's injected into live traffic.
   Any redesign must preserve that; a purely-descriptive `agent_artifacts.behavior_summary` field
   with no injection path (as literally specified in the doc's schema — `behavior_summary TEXT`,
   no gateway-filter reference anywhere in the doc) would be a *regression* in genuine usefulness
   relative to what already ships, even though it would look, on paper, like "the same feature."
2. **Is the "why" attached, or is it an assertion?** Ledger entries already carry `citations` +
   `source_ids` (`ledger_entries.citations`, populated e.g. `["artifact:{nudge_id}"]` in
   `upsert_from_issue`). A portal Artifact/Book page must render these as clickable links back to
   the source issue/nudge, not just display prose — otherwise it's exactly the "just more internal
   bookkeeping" failure mode the task brief is worried about. This is a rendering task, not a data
   gap (the columns exist).
3. **Does looking at it save a real, repeated, expensive action?** The clearest yes is
   `TriageAgent`'s 8-call ReAct evidence loop (§2, persona 2) — every triage call today pays that
   cost from scratch. A Ledger-first read before the ReAct loop is the single highest-value,
   lowest-effort UX win available in this whole doc, and it's not in the doc at all (the doc's
   "concrete gap" point 5 correctly identifies the problem but proposes solving it with a new
   `agent_artifacts` table + new API route rather than one call to `LedgerGenerator.get_latest`,
   which already returns exactly the shape needed).

### 6. Concrete recommendation for what should actually get built

Reframe the whole doc's scope from "design and build a new record" to "surface and connect a
record that already exists, on the routes already reserved for it":

1. Un-stub `/artifacts` and `/ledger` in the portal (remove the two keys from
   `stub-try-instead.ts:9,22`; the page copy is already written in `page-descriptions.ts:32-35`).
   Build the page against the *existing* `/agents/{agent_id}/book`, `/agents/{agent_id}/ledger`,
   `/agents/{agent_id}/ledger/diff`, and `/orgs/{org_id}/artifacts` routes — no new backend routes
   needed for this half.
2. Ship the diff view first (§4) — it is the best value/effort ratio in the entire feature and
   the query already exists.
3. Wire `TriageAgent` to read `LedgerGenerator.get_latest()` before its ReAct loop (§5.3) — cheap,
   high-value, no schema change.
4. Add the one real missing piece: **team-uploaded context** (the doc's
   `agent_artifact_content`/Lemma's `uploaded_text_artifacts` analog). This genuinely does not
   exist anywhere in `kb/` — confirmed absent from `ledger_entries`'/`agent_books`' schemas (no
   `filename`/`content_type`/uploaded-by-human column anywhere in migrations `092` or `100`). This
   is the one piece of the doc's data-model proposal actually worth building as new, small,
   scoped, additive work (upload endpoint + one small table, folded into the existing Book
   synthesis and Ledger injection paths rather than a parallel `agent_artifacts` system).
5. Defer the Mermaid diagram explicitly (§4) rather than folding it into a 1-2 day estimate.
6. Wire the prompt-version-changed regen trigger (§3, the one real gap in the trigger set) onto
   `PromptService.create_version()`, reusing `BookGenerator`/`ArtifactAuthor`, not a new
   synthesizer class.

---

## VERIFIED

- `SoftIssueReviewer._review_org()` nightly per-agent scout, `PromptService` versioned prompt
  registry + `template_hash()`, `TriageAgent.triage_result` per-issue cache, `playbook_router`
  22-category classifier, `IssuePromptEvolver.evolve_from_issue` prompt-mutation-on-resolve — all
  read and confirmed present and roughly as described (`src/eden/services/soft_issue_review.py`,
  `src/eden/services/prompt_versioning.py`, `src/eden/issues/triage_agent.py`,
  `src/eden/closed_loop/playbook_router.py`, `src/eden/agents/evolution/components.py`).
- `IssuesRepo.get_stumble(org_id, stumble_id)` exists at `src/eden/issues/repo.py:193-209` as
  claimed (TL;DR point 4 / correction to F13) — confirmed present with the described signature.
- Portal `DETAIL_TABS = [runs, quality, experiments]` claim is accurate:
  `clients/portal/src/app/(portal)/agents/agents-client.tsx:88-99` (type at `:88`, const at
  `:95-99`, matches doc's `:95-98` citation closely enough; rendered at `:675`).
- `nl_signals` has no `agent_id` column and the scout smuggles it into free text
  (`f"[auto:{agent_id}] {description}"`) — confirmed pattern present in
  `soft_issue_review.py` per the doc's own citation; consistent with F13.
- Lemma market research (the `docs.uselemma.ai` Artifacts API tag) is outside this agent's
  verification scope (external web claims) — deferred to Agent A / the original pass's own
  sourcing, no contradiction found in this pass's scope.

## CUT

> "**No single readable "how this agent is supposed to work" object.** There is no query that
> returns "the current understanding of agent X"..."
— **False as stated.** `LedgerGenerator.get_latest(org_id, agent_id)`
(`src/eden/kb/ledger/generator.py:101-142`) and `BookGenerator.get_latest(org_id, agent_id)`
(`src/eden/kb/book/generator.py:138-158`) are exactly this query, already implemented, already
routed (`GET /agents/{agent_id}/ledger`, `GET /agents/{agent_id}/book`,
`api/routes/learn.py:255-269,527-537`). Cut or rewrite to state the real gap: the query exists,
the portal page rendering it does not.

> "**No distilled prose or diagram — the prompt text is the only "spec," and it's mutated in
> place, not maintained as a separate summary.**"
— **False.** The Book (`agent_books.content_md`) is exactly a distilled, separately-maintained,
versioned prose summary, regenerated (not hand-edited) on issue-resolve
(`kb/flywheel/coordinator.py:238-242`). Only the diagram half of this sentence is accurate (no
Mermaid anywhere in the codebase — confirmed, see §4). Rewrite to isolate the diagram-only gap.

> "**No MCP tool, no API route, and no portal page for any of this exists as a unified surface.**"
— **False on the API-route and (partially) portal-route claims.** `/orgs/{org_id}/artifacts`
(list/create/promote/archive/author/export — `api/routes/learn.py:385-492`) and
`/orgs/{org_id}/ledger` + `/agents/{agent_id}/ledger/*` (`:498-581,778+`) are real, live API
routes. Portal routes `/artifacts` and `/ledger` are also registered (`portal-routes.ts:22,24`)
— they're dead stubs today (`stub-try-instead.ts:9,22`), which is a real and worth-stating gap,
but "does not exist" and "exists but isn't surfaced yet" are materially different claims with
different remediation cost. The MCP-tool half of the sentence is accurate — confirmed no
`nudge`/`ledger`/`book`/`artifact` tool in `mcp_server/tools.py` via grep.

> Data model design: `CREATE TABLE agent_artifacts (...)` and `CREATE TABLE
> agent_artifact_context (...)`, plus the whole "Build sequence" (Phases 1–5) and "API surface"
> section.
— **Recommend cutting/rewriting the whole section**, not just flagging inaccuracies in it. It
proposes building, from a blank schema, a system (versioned per-agent behavior record with
confirm/dismiss-driven confidence, regenerate triggers, an API surface, a portal tab) that
already exists end-to-end under the names Book/Ledger/Artifacts (nudges), gated by
already-GA-default flags (`artifacts_v1`, `ledger_v1`). Estimating "1.5–2 weeks" (closing verdict
line) to build something ~90% already shipped is the single largest scoping error in the doc.
Only the team-uploaded-context table (`agent_artifact_context`) is genuinely net-new — see
USER EXPERIENCE §6.4.

> Phase 3.2: "`resolve_issue`'s `status == "resolved"` block (`agent_issues.py:179`) — add
> Artifact regen as a fifth best-effort side effect alongside the existing four (regression
> builder, regression runner, `IssuePromptEvolver`, flywheel coordinator)... Est. 1 day."
— The doc lists "flywheel coordinator" as an *existing, distinct* fourth side effect, not
realizing the flywheel coordinator it just cited **is** the Artifact-regen trigger it's proposing
to add as a "fifth" one (`ArtifactAuthor().from_issue`, called from
`KBFlywheelCoordinator.on_issue_resolved`, `kb/flywheel/coordinator.py:25-36`). Not just an
overlap with F13 — an internal contradiction within this doc's own citations. See NEW FINDINGS.

Overlap-with-F13 note (as requested): the two docs share the "fragmented across four systems"
framing and the `nl_signals.agent_id`/`record_shadow_feedback` prerequisite discussion, and F13
also cites the flywheel coordinator (`agent_issues.py:207-223`) without opening it — so this is a
gap both docs share, not something F15 introduced alone. Recommend synthesis flag this as a
shared blind spot in both docs, not just an F15 issue.

## NEW FINDINGS

1. **`src/eden/nudges/` is a fully-built "Artifacts" system the doc never discovered**, despite
   the class being named `ArtifactAuthor` (`src/eden/nudges/author.py:11`) and the demotion worker
   being named `ArtifactDemotionWorker` (`src/eden/nudges/demotion_worker.py:11`). `nudges` table
   (migration `092_market_ready_consolidated.py:144-168`) has a `mode` lifecycle
   (`shadow`→`promoted`→`archived`), created by `ArtifactAuthor.from_issue`/`from_loop_report`/
   `from_nl` (`nudges/author.py:14-139`), evidence-gated via `promotion/evidence_gate.py`
   (`EvidenceGate().enqueue(..., kind="nudge", ...)`), applied live to gateway requests via
   `apply_nudge_to_request`/`apply_nudge_to_prompt` (`nudges/engine.py:191-226`,
   `request.prompt = f"{prompt}\n\n<!-- eden-nudge:{nudge.id} -->\n{nudge.content}"`), and
   auto-demoted from real 7-day outcome data (`nudges/demotion_worker.py:11-89`).
2. **`src/eden/kb/book/` and `src/eden/kb/ledger/` are a fully-built versioned, chaptered,
   per-agent knowledge record** — `BookGenerator` (`kb/book/generator.py`, `agent_books` /
   `agent_book_config` tables, migration `092:214-244`) and `LedgerGenerator`
   (`kb/ledger/generator.py`, `agent_ledgers` / `ledger_entries` tables, migration
   `100_artifacts_ledger.py:18-63`) — including a working version-diff query
   (`diff_since_version`, `:190-214`) and citation/weight/embedding columns already in the
   schema.
3. **Both systems are gated by feature flags literally named `artifacts_v1` and `ledger_v1`,
   default-on (GA) per-org** (`src/eden/preview/gates.py:12,49-66`, docstring: *"Feature gates
   for Artifacts + Ledger (GA defaults)"*). This is documentation-grade evidence that eden's own
   engineering team already named and shipped this concept before this review pass, under this
   exact name.
4. **The Book is injected into live production prompts, not just displayed** —
   `BookGatewayFilter.apply()`/`_legacy_book_apply()` (`src/eden/llmops/filters/book.py:33-71`)
   literally prefixes `request.prompt` with `<!-- eden-book:v{version} -->\n{content_md excerpt}`
   on every gateway request when enabled. The Ledger has an equivalent path via
   `LedgerRetriever().pack_sync()` (`:38-42`).
5. **The portal already has reserved routes, breadcrumb labels, and written page-copy for
   `/artifacts` and `/ledger`** (`clients/portal/src/lib/portal-routes.ts:22,24`;
   `breadcrumbs.ts:81,87`; `page-descriptions.ts:32-35`), currently wired as dead stubs to
   `/improve?mode=queue` (`stub-try-instead.ts:9,22`) — enforced by a test,
   `nav-registry-parity.test.ts` per the file's own comment (`stub-try-instead.ts:5`), meaning
   someone would need to explicitly ship a real page and remove the stub entry for these routes
   to go live. This is the actual, precisely-located UX gap this feature should close.
6. **A full REST CRUD + lifecycle + NL-authoring + YAML-export API for Artifacts already exists**
   at `src/eden/api/routes/learn.py:385-492` (`GET/POST /artifacts`, `POST
   /artifacts/{id}/promote`, `POST /artifacts/{id}/archive`, `POST /artifacts/author` for NL
   authoring, `GET /artifacts/export` for YAML export) plus a parallel Ledger/Book API
   (`:255-320,498-581,778+`, including `GET /agents/{agent_id}/drift` /
   `/drift/report/latest` / `POST /drift/compute` backed by `insights/drift_reports.py`'s
   PSI-based behavioral-drift scoring — a numeric "has this agent's behavior statistically
   changed" signal with no analog in the doc's proposal at all).
7. No MCP tool exists for any of nudge/ledger/book/artifact (confirmed by grep of
   `mcp_server/tools.py`) — this part of the doc's "no unified surface" claim holds and is a
   legitimate, real, still-open gap.
8. No Mermaid/diagram rendering exists anywhere in the codebase (`grep -rl mermaid src/eden/
   clients/portal/src/` → zero hits) — the diagram half of the product-owner's copy has no
   supporting infrastructure in eden today at any layer, confirming that piece of the doc's gap
   analysis (see USER EXPERIENCE §4 for the resulting recommendation).
