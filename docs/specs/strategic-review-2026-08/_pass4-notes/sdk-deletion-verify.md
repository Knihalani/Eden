# SDK Deletion — Pass 4 Final Verification

Independent re-check of `docs/specs/strategic-review-2026-08/sdk-deletion.md` against live
repo state (2026-08-05), performed from scratch (not trusting the doc's own prior
verification passes).

## VERIFIED

- `git status --short -- sdk/` — exactly 30 files, all `D ` (staged, not committed): 16 under
  `sdk/go/`, 14 under `sdk/rust/`. `ls sdk/` → `DEPLOY.md`, `python/`, `scripts/`, `ts-ai/` only.
  No untracked leftovers, no `M`/`A`/`??` entries under `sdk/`.
- `git status --short -- .github/workflows/` — `sdk-go-ci.yml` and `sdk-rust-ci.yml` both `D `,
  absent from disk. Only `sdk-python-ci.yml` and `sdk-ts-ci.yml` remain.
  `git diff --cached -- .github/workflows/sdk-go-ci.yml` confirms a clean full-file deletion.
- `docs/specs/SOTA-WAVE-TRACKER.md` — staged diff (`git diff --cached`) touches line 115
  (`Go / Rust SDK` → **DELETED**) and line 163 (`Go/Rust README` → **N/A — SDKs deleted**).
  `git diff` (unstaged) on this file is empty — fully staged, nothing left behind.
- Repo-wide grep for `sdk/go`, `sdk/rust`, `sdk_go`, `sdk_rust` (excluding `.git`,
  `node_modules`, `target`, `dist`, `build`) turns up nothing outside `docs/specs/`: `sdk/python`,
  `sdk/ts-ai`, `clients/` (portal), `docs/docs/**` (public docs site), `docs/docusaurus.config.js`,
  `docs/sidebars.js`, and repo-root `README.md` are all clean — zero Go/Rust SDK references,
  zero nav-menu/sidebar entries, zero portal doc/example links.
- `OPTIMIZATION-ID-CHECKLIST.md:32-33` (K36/K37 "Go SDK queue+batch flush" / "Rust send_batch")
  and `src/eden/observability/canonical.py:19` (comment: "TypeScript SDK, Go SDK, etc.") — both
  confirmed present, unchanged, prose-only, not broken links. Reasonable to leave out of this
  task's scope, though see REMAINING REFERENCES below for a cross-cutting note.
- `docs/docs/how-to/mcp-cursor.md` modification is **unrelated to the SDK deletion**. The
  diff only removes `unlisted: true` from the frontmatter (page is already `draft: true`); it
  has nothing to do with `sdk/go`/`sdk/rust` and needs no action here.

## REMAINING REFERENCES

None that are functionally broken (no dead links/paths). Two categories worth noting:

1. **Deliberately out-of-scope prose mentions** (doc already flags these correctly):
   - `docs/specs/OPTIMIZATION-ID-CHECKLIST.md:32-33` — K36/K37 rows still marked `DONE` for
     SDKs that no longer exist. `docs/specs/strategic-review-2026-08/bugs/01-dead-code-stale-docs.md:302-311`
     (a sibling doc in this same review) independently flags this exact item and recommends
     annotating K36/K37 as moot/superseded, consistent with how `SOTA-WAVE-TRACKER.md:115,163`
     now reads. Not blocking, but two separate passes in this review both landed on the same
     open recommendation — worth a one-line fix if anyone touches that checklist again.
   - `src/eden/observability/canonical.py:19` — comment mentioning "Go SDK" as a hypothetical
     future consumer. Harmless, no action needed.
2. **Self-referential meta-commentary, not real dangling references** — `docs/specs/strategic-review-2026-08/features/10-model-gateway.md:91,158-162`
   contains sentences that literally contain the strings `sdk/rust`/`sdk/go` (e.g. "zero
   dangling references to the deleted `sdk/rust`/`sdk/go` directories... `grep -n "sdk/rust\|sdk/go"`
   returns exactly one hit, the explanatory sentence above"). These are **not** broken links — the
   file has grown from ~39 lines (as `sdk-deletion.md` originally described it) to 207 lines,
   and now contains its own grep self-verification prose that trips a naive repo-wide grep.
   Functionally fine, but see CUT below — `sdk-deletion.md`'s claim of "zero matches" for this
   file is now stale/inaccurate as literally written.

No dead paths, no broken doc links, no stale CI badges, no portal-code references, no
docs-site nav entries reference the deleted SDKs anywhere in the repo.

## CUT

Recommend pruning/correcting the following from `sdk-deletion.md` — each is either now false,
unverifiable as cited, or redundant:

- > "**(3) Correction — `features/10-model-gateway.md:11,15` citation is WRONG, not a real
  > dangling reference.** Grepping that file directly for `sdk/rust`, `.rs`, and `rust`
  > (case-insensitive) — zero matches anywhere in the **39-line file**."
  **Reason:** `features/10-model-gateway.md` is now 207 lines (confirmed via `wc -l`), and a
  direct grep for `sdk/rust`/`sdk/go` returns 4 matches (lines 91, 158, 159, 162) — all
  self-referential "we already checked, this is deleted" commentary, not real dangling
  references, but the literal claim of "zero matches" is stale and will mislead a future reader
  who re-runs the grep and gets a nonzero hit count. Same issue repeated at line 75
  ("re-confirmed zero matches for `sdk/rust`/`.rs`/`rust`") — also stale for the same reason.

- > "`docs/specs/strategic-review-2026-08/INDEX.md:116, 120` — INDEX's own summary of this
  > task's status ("done", "fully removed", "struck" false positive for model-gateway.md). Not
  > dangling, accurate."
  **Reason:** Fabricated/incorrect citation. `INDEX.md` is 770 lines; lines 116-120 discuss an
  unrelated alerting/incident-notification bug (PagerDuty/Kafka/`AnomalyDetectorLoop`), with no
  mention of the SDK deletion at all. `INDEX.md`'s actual (and only) SDK-deletion reference is a
  single line at **line 17**: `` `sdk-deletion.md` is finalized, unchanged, and out of scope. ``
  The doc should cite line 17, not 116/120, or drop this bullet since line 17 says nothing
  substantive beyond "out of scope."

- The "Phase 2 Fact-Check" and "Final Verification" sections are almost entirely duplicative of
  each other (both re-run the same `git status`, same repo grep, same SOTA-WAVE-TRACKER diff
  check, same portal-code check) and of the top-level "Dangling references found and resolved"
  section above them. **Reason:** three near-identical audit passes stacked in one doc is
  redundant filler that obscures the one correction that actually matters (the
  model-gateway.md citation was wrong both times, and the INDEX.md citation is wrong too).
  Recommend collapsing to a single "Verification" section with the corrected citations, or
  leaving as historical audit trail only if the team wants that record — but as a finished doc
  read top-to-bottom it is far longer than the substance warrants.

## READY-TO-COMMIT verdict

**YES.** The staged deletion itself (`sdk/go/`, `sdk/rust/`, `sdk-go-ci.yml`, `sdk-rust-ci.yml`)
is clean, complete, and correctly staged — verified independently via `git status`,
`git diff --cached --stat`, and a repo-wide grep excluding only VCS/build noise. The one real
dangling reference from earlier passes (`SOTA-WAVE-TRACKER.md` rows 115/163) is fixed and
staged. `sdk/python`, `sdk/ts-ai`, portal code, and the public docs site are all untouched and
reference-free. `docs/docs/how-to/mcp-cursor.md` is an unrelated, harmless frontmatter change
riding along in the working tree — it does not block this commit but should probably be a
separate commit for a clean history (it's not part of the SDK deletion story).

The two `sdk-deletion.md` citation errors under CUT above are documentation-quality issues in
the review doc itself, not blockers to committing the actual deletion — they don't point at
anything left broken in the repo. Recommend fixing them in `sdk-deletion.md` before archiving
this review (so a future reader isn't sent to the wrong lines), but they do not need to hold up
`git commit`.
