# Pass 4 Notes — 15-artifacts-behavior-record.md — Agent A (Fact-Verifier & Pruner)

Scope: re-verify (1) the external Lemma `docs.uselemma.ai` corroboration and (2) the internal eden
codebase mapping cited in the doc; prune false/speculative/redundant/filler content; draft a first-pass
UX & Value section. Did not edit the source doc.

## VERIFIED

### External claim — docs.uselemma.ai `Artifacts` API (the doc's central pass-3 finding)

This is the strongest, most load-bearing claim in the doc, and it holds up completely on direct re-fetch
of the actual doc pages (not just the `llms.txt` index the doc cites):

- `POST /projects/{project_id}/artifacts/regenerate` — fetched directly, title "Regenerate project
  artifacts," description verbatim "Starts the learn-agent workflow for a tenant-owned project and
  optional agent," response schema `{workflow_id, project_id, agent_name}` — **matches the doc's quote
  exactly**, including the dedupe/poll semantics language.
- `GET /issues/{issue_id}/artifact-context` — fetched directly, tag "Issues," description verbatim
  "Returns bounded learn-agent and uploaded text artifact context for validation and debugging," response
  schema `available: {learn_agent_kb, uploaded_text_artifacts}`, `learn_agent_kb: {version, agent_name,
  knowledge_preview, mermaid_preview, knowledge_truncated, mermaid_truncated}`,
  `uploaded_text_artifacts: [{id, filename, content_type, size_bytes, content_preview,
  preview_truncated}]`, `caveats: []` — **matches the doc's quoted schema field-for-field**, including
  `mermaid_preview`/`knowledge_preview`, which the doc's Market Context section leans on heavily.
- `GET /projects/{project_id}/artifacts/versions` ("List learn-agent artifact versions") — confirmed
  live, description verbatim matches the doc's quote. Minor imprecision: the doc's TL;DR abbreviates the
  path as `GET .../artifacts`; the real path has a `/versions` suffix. Cosmetic, not a false claim (the
  doc never asserts the eden design must match this exact path — its own proposed eden route,
  `GET /orgs/{org_id}/agents/{agent_id}/artifacts`, is its own invention, not a copy of Lemma's path).
- `uselemma.ai/blog/introducing-lemma` (Jerry Zhang, Apr 24 2026) — confirmed: never uses the word
  "Artifact"/"Artifacts," describes exactly the four capabilities the doc lists (surfacing failure
  patterns, diagnosing issues, proposing improvements, expanding evaluations). Confirms the doc's honest
  framing that the marketing site and the API docs tell two different stories.
- Lemma is YC **F25** ("Production Monitoring for AI agents... catches the silent, semantic failures your
  observability tools miss") — confirmed via YC company profile, matches doc's parenthetical.
- Galileo/Cisco: Cisco's own blog confirms announce date **Apr 9, 2026**, close **May 22, 2026** — exact
  match to the doc. The "living asset... continuously grounds your AI systems" and "today's evals are
  tomorrow's guardrails" quotes are correctly sourced to `galileo.ai`, not the Cisco blog — verified
  present verbatim on galileo.ai's homepage.
- One caveat the doc itself already flags honestly (not a finding of mine, but worth affirming as
  correct): the docs do **not** expose an endpoint proving the "every confirm/dismiss updates what it
  looks for next" half of the product-owner's copy. Confirmed on this pass too — the Issues tag has
  `Set issue status`/`Flag or unflag issue`/`Start issue review` but nothing that visibly writes into an
  artifact.

One caution for whoever reads Lemma's OpenAPI spec going forward: fetching
`docs.uselemma.ai/api-reference/openapi.json` directly returns a generic Mintlify-starter "Plant Store"
placeholder spec (paths `/plants`, `POST /plant/webhook`) — **not** Lemma's real spec. The real content
only surfaces on the per-endpoint doc pages (confirmed above) and presumably a different underlying spec
URL. Doesn't invalidate the doc's claims (which cite the per-endpoint pages, not the raw JSON), but worth
flagging so a future pass doesn't mistakenly "debunk" Artifacts by hitting the wrong spec file.

### Internal codebase mapping — every cited fragment checked

All of the following file:line citations were independently re-verified against the live tree and are
accurate:

- `SoftIssueReviewer._review_org` `src/eden/services/soft_issue_review.py:139`; `_hot_agents:119`;
  `_sample_traces:200`; `_existing_signal_descriptions:235`; `_parse_patterns:307`;
  `record_shadow_feedback:571`; `evaluate_shadow_precision:510`.
- `record_shadow_feedback` confirmed to have **zero real callers** — grep across `src/` finds only its
  own `def`, its own `logger.debug` string, and its `__all__` export. Matches doc claim exactly.
- `PromptService` `src/eden/services/prompt_versioning.py:69`; `template_hash:36`; `create_version:223`;
  `run_auto_eval:378`; `_llm_score:447`.
- `TriageAgent.triage` `src/eden/issues/triage_agent.py:107`; `_gather_evidence:319`;
  `_MAX_REACT_CALLS = 8` at `:47`; `_enrich_playbook:594`.
- `playbook_router` `PLAYBOOK_CATEGORIES` at `src/eden/closed_loop/playbook_router.py:14-36` — **counted
  by hand: exactly 22 entries**, confirms the doc's "22-category classifier."
- `IssuePromptEvolver.evolve_from_issue` `src/eden/agents/evolution/components.py:674`; guardrail text
  construction confirmed byte-for-byte: `f"{current_prompt}\n\n# Resolved issue guardrail
  ({issue.fingerprint})\nAvoid recurrence of: {summary}"`; canary enrollment via
  `PromptEvolvers._auto_create_canary` confirmed called after `create_version`.
- `resolve_issue` `src/eden/api/routes/agent_issues.py:167` (doc cites `:201-203` for the
  `IssuePromptEvolver` call — confirmed at `:201`, inside the `if ok and target == "resolved":` gate).
  Confirmed it is one of **four** best-effort side effects (regression builder, regression runner,
  `IssuePromptEvolver`, flywheel coordinator) as the doc's Phase 3 describes.
- `IssuesRepo.get_stumble` confirmed present at `src/eden/issues/repo.py:193-209` — the doc's TL;DR
  correction to F13 is accurate, and F13's own current text (re-verified, see below) already
  incorporates this same correction independently, so the two docs agree here.
- `nl_signals` migration `src/eden/db_migrations/versions/090_nl_signals.py:49-64` — column list
  confirmed exactly as quoted: `id, org_id, description, rule, enabled, created_by, cluster_id,
  last_matched_at, match_count, created_at, updated_at`. No `agent_id` column — confirmed.
- Migration `055`'s `_table()` helper confirmed present, `src/eden/db_migrations/versions/055_prompt_versioning.py`
  (helper function definition, sha256/whitespace-normalized-hash docstring matches doc's claim).
- `mcp_server/tools.py` — confirmed 497 lines, tool defs span line 10 (`search_traces`) to line 470
  (`checkpoint_rerun`), including `triage_issue:97`, `run_autofix:107`, `get_improvement_plan:136`,
  `export_fixture:157` as cited. **No** tool named `artifact`/`behavior_record` exists — confirmed by
  full grep.
- Portal: `DETAIL_TABS` array confirmed verbatim at
  `clients/portal/src/app/(portal)/agents/agents-client.tsx:95-98` — exactly `runs | quality |
  experiments`, dynamically imported per lines ~65-82. `agents/[id]/page.tsx` confirmed to be a pure
  30-line redirect to `/agents?id=`, matching the doc's characterization (doc cites `:1-31`, file is 30
  lines — off by one, immaterial).
- `prompts-list-view.tsx` / `prompts-detail-view.tsx` / `agent-quality-tab.tsx` /
  `agent-experiments-tab.tsx` all confirmed to exist at the cited paths in `clients/portal/src/`.

**Verdict on internal mapping: exceptionally well-verified.** Every specific file:line citation checked
out. This is the most rigorously fact-checked doc encountered in this pass so far.

## CUT

1. **Internal contradiction on `nl_signals.agent_id` column type — needs correction, not necessarily
   deletion.** F15's Data Model section says:
   > "`ALTER TABLE nl_signals ADD COLUMN agent_id UUID` — already F13's P1 recommendation"
   (`15-artifacts-behavior-record.md`, Data model design → Shared prerequisite with F13)

   But F13's own current text (`13-continuous-improvement-loop.md`) explicitly and deliberately
   *corrects* this exact suggestion:
   > "Column type: `VARCHAR(256)`, not `UUID`. This corrects the prior pass, which suggested `agent_id
   UUID`. Verified this pass: `agent_issues.agent_id` and `agent_stumbles.agent_id` are both
   `VARCHAR(256)` (`src/eden/db_migrations/versions/084_agent_issues.py:49,93`)..."

   I independently re-verified `084_agent_issues.py:49` (`agent_stumbles.agent_id VARCHAR(256)`) and
   `:93`-region (`agent_issues.agent_id VARCHAR(256)`) — F13 is correct, F15 is wrong. **F15's own
   `agent_artifacts.agent_id` column is also inconsistent with the convention**, declared as
   `VARCHAR(128)` rather than the `VARCHAR(256)` used by every sibling table it needs to join against
   (`agent_issues`, `agent_stumbles`). Reason to flag: this is a genuine cross-doc factual disagreement,
   not stylistic — a builder following F15's schema literally would create a type mismatch against the
   real `nl_signals`/`agent_issues`/`agent_stumbles` convention F13 correctly documents. Recommend pass 4
   synthesis correct F15's schema to `VARCHAR(256)` for both `agent_artifacts.agent_id` and the
   `nl_signals.agent_id` ALTER statement, deferring to F13's (correct, re-verified) column type.

2. **"Broader 2026 competitive landscape" academic citations (ABC / AgentPex paragraphs) — trim, don't
   cut wholesale.** (`## Market context` → `### Broader 2026 competitive landscape...`, the two bullet
   points on arXiv:2602.22302 and arXiv:2603.23806, plus the closing paragraph). These are accurately
   cited (I did not re-fetch the arXiv papers themselves, but the citations are specific and the framing
   is appropriately hedged) but are the least load-bearing content in the doc: the doc's own verdict
   explicitly defers this entire academic framing to "Phase 6, explicitly out of v1 scope." Two full
   paragraphs of academic contextualizing for work that is deliberately not being built in v1 is filler
   relative to the doc's actual recommendation. Suggest compressing to 2-3 sentences ("harder-edged
   academic precedent for rule-extraction exists — ABC/AgentPex — explicitly deferred to Phase 6") rather
   than full paragraph treatment.

3. **Time/effort estimates throughout Build Sequence ("Est. 0.5–1 day," "Est. 2–3 days," "~1.5–2 weeks")
   — flag as unverifiable, not false.** These are the author's own judgment calls with no grounding
   (no comparison to actual historical eden PR sizes, no team velocity data cited). Not asserted as fact
   elsewhere in the doc and appropriately framed as estimates, so not a "false claim" — but worth flagging
   to synthesis as the one category of content in this doc that cannot be independently verified the way
   everything else was. Recommend keeping but not treating as a committed estimate.

No other cuts. Unlike most docs in this review, I found no speculative/unverifiable factual claims beyond
the two above — the doc's discipline about citing exact file:line and quoting exact API text made
verification unusually clean.

## Duplication check vs. 13-continuous-improvement-loop.md

**Not genuine duplication — confirmed complementary, cross-checked both directions.** F13's own text
explicitly delegates the "Artifacts" product-shape discussion to F15 ("Lemma's confirmed-real 'Artifacts'
... covered in depth in `features/15-artifacts-behavior-record.md`... this doc stays focused on eden's
own feedback-loop mechanics") and again at its "Behavior record — design sketch" section ("Full detail
(`features/15-artifacts-behavior-record.md`) covers the persistent-record product shape Lemma calls
'Artifacts'; this doc's join sketch is the substrate that would feed it, not the product design itself").
F15 reciprocally treats F13's P0/P1 as inputs rather than re-deriving them. The two docs read as
deliberately partitioned (F13 = wiring the confirm/dismiss substrate; F15 = the product/schema built on
top of it) and the only place they actually collide is the `nl_signals.agent_id` type contradiction
flagged under CUT #1 above — that should be reconciled in synthesis, but it is a factual bug, not
evidence of redundant scope.

## USER EXPERIENCE & VALUE (draft — Agent B going deeper)

- **What the user actually gets, concretely:** a fourth tab on the existing agent detail view (already a
  real page: `/agents?id=<id>`, no new navigation needed) showing (a) an LLM-synthesized prose summary of
  "what this agent currently does and is expected to do," (b) an optional mermaid diagram, (c) a version
  timeline (reusing the prompt-version UI pattern operators already know from the Quality/prompts tabs),
  and (d) a place to upload org-specific `.txt`/`.md` context ("our refund policy requires X"). This is a
  read surface, not a new workflow — it lowers the cost of answering "why does this agent behave the way
  it does" from "grep four different tables and re-read the current prompt" (the doc's own "concrete gap"
  bullets) to one page load.
- **Where the value is real vs. contingent:** the prose/diagram/version-timeline/upload pieces (Phases
  1-2, 4-5) deliver value immediately and independently — they're a UI/aggregation problem, not a new ML
  problem, since `SoftIssueReviewer`'s scout loop already does 90% of the LLM-call shape needed
  (`_scout_novel_patterns`'s call signature is explicitly reused). The **confidence score** field, however,
  is honestly flagged by the doc itself as "provably meaningless" until F13's P0 (`record_shadow_feedback`
  wiring) lands — today it would render as permanently `NULL`/zero on every agent, which is a real risk:
  shipping a confidence field that never moves teaches operators to ignore it, potentially poisoning trust
  in the whole feature before the wiring dependency lands. Recommend synthesis flag this as a **sequencing
  risk**, not just a phase dependency: if Phase 1-5 shipped before F13's P0, the "Artifact" tab's most
  differentiated element (a trust score, à la Lemma's confirm/dismiss loop) would visibly not work,
  undermining the pitch on day one.
- **Who benefits and how much:** the primary beneficiary per the doc's own evidence is `TriageAgent`
  itself, not just human operators — Section "concrete gap" bullet 5 notes `_gather_evidence` re-derives
  context from scratch on every triage call (bounded ReAct loop, `_MAX_REACT_CALLS = 8`), and a maintained
  Artifact would let triage read a pre-synthesized summary instead. That's a plausible latency/cost win
  for the *existing* triage path independent of whether any human ever opens the new portal tab — worth
  Agent B quantifying if triage call volume/cost data exists elsewhere in the review (F13 or the
  cost-related docs may have `_MAX_REACT_CALLS`-adjacent LLM spend numbers).
- **Novelty vs. competitive necessity:** the doc doesn't overclaim here — it's honest that this is chasing
  a specific, real Lemma capability (confirmed above) rather than a from-scratch differentiator. The
  interesting value angle Agent B might push further: eden's version already has an advantage Lemma's
  docs don't show — a real, wired `resolve_issue` hook that mutates prompts today (`IssuePromptEvolver`).
  Lemma's `learn_agent_kb` is described in its own docs as a read/preview artifact; nothing in Lemma's
  public API shows it *writing back into the agent's actual prompt*. If eden's Artifact tab surfaced "this
  guardrail was added because of issue X" pulled from `IssuePromptEvolver`'s already-live behavior, that
  would be a case where eden's existing infrastructure lets it ship something slightly ahead of what
  Lemma's docs prove it does — worth Agent B considering as a differentiation angle rather than pure
  parity chase.

## NEW FINDINGS

1. **`nl_signals.agent_id` type contradiction between F13 and F15** (see CUT #1) — F15 says `UUID`,
   citing F13; F13's current, re-verified text explicitly says `VARCHAR(256)` and explicitly corrects the
   "prior pass, which suggested `agent_id UUID`." F15 appears to be quoting an earlier/uncorrected version
   of F13's recommendation. Needs reconciliation in synthesis; F13 is the one grounded in an actual schema
   check (`084_agent_issues.py:49,93`, independently re-verified here) and should win.
2. **`docs.uselemma.ai/api-reference/openapi.json` serves a placeholder "Plant Store" spec**, not Lemma's
   real API — a trap for anyone re-verifying this doc's claims by fetching the raw OpenAPI JSON instead of
   the rendered per-endpoint doc pages. The doc's own citations (rendered pages, `llms.txt`) sidestep this
   correctly; noting it so a future pass doesn't wrongly conclude the Artifacts API is fake.
3. **`agent_artifacts.agent_id VARCHAR(128)`** (F15's own schema) is inconsistent with eden's live
   convention of `VARCHAR(256)` for `agent_id` columns on the exact tables (`agent_issues`,
   `agent_stumbles`) it's designed to join against — same root issue as finding #1, just in F15's own new
   table rather than the `nl_signals` ALTER.
4. All Lemma-side factual claims re-checked this pass (endpoint descriptions, response schemas, blog
   post content/author/date, YC batch, Cisco/Galileo acquisition dates, Galileo homepage quotes) were
   accurate on independent re-fetch — no external corroboration issues found, which is unusual rigor for
   a "new, less battle-tested" doc per the task brief.
