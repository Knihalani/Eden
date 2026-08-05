# SDK Deletion: Go and Rust SDKs Removed

## What was removed

`git rm -r sdk/go sdk/rust` — staged, not committed. 30 files deleted (confirmed via `git status --porcelain -- sdk/`):

**sdk/go/** (16 files): `README.md`, `client.go`, `client_test.go`, `edge_test.go`, `go.mod`, `go.sum`, `ingest_format.go`, `ingest_format_test.go`, `json.go`, `trace.go`, `trace_test.go`, `anthropic/anthropic.go`, `anthropic/anthropic_test.go`, `openai/openai.go`, `openai/openai_test.go`, `examples/basic/main.go`

**sdk/rust/** (14 files): `.gitignore`, `Cargo.lock`, `Cargo.toml`, `README.md`, `examples/basic.rs`, `src/anthropic.rs`, `src/client.rs`, `src/config.rs`, `src/errors.rs`, `src/event.rs`, `src/lib.rs`, `src/openai.rs`, `src/trace.rs`, `tests/integration.rs`

Note: `sdk/rust/src/*.rs` had uncommitted modifications from earlier work this session (adding `agent_id` handling, cargo fmt, etc.). Those were discarded as part of the deletion — expected per this task's directive. A gitignored `sdk/rust/target/` build-artifact directory (untracked, ~MBs of build cache) was also removed with plain `rm -rf` since it was never part of git history.

Surviving SDKs: `sdk/python`, `sdk/ts-ai`.

Also removed: `.github/workflows/sdk-go-ci.yml` and `.github/workflows/sdk-rust-ci.yml` — both show `D ` in `git status`. `.github/workflows/` now only has `sdk-python-ci.yml` and `sdk-ts-ci.yml` for SDK CI.

## Dangling references found and resolved

1. `.github/workflows/sdk-go-ci.yml` and `.github/workflows/sdk-rust-ci.yml` — **FIXED**: both files are deleted and staged (`D `), confirmed absent from `.github/workflows/` on disk.
2. `docs/specs/SOTA-WAVE-TRACKER.md:115,163` — **FIXED**: line 115 (`Go / Rust SDK`) now reads `**DELETED** (strategic-review-2026-08)`; line 163 (`Go/Rust README`) now reads `**N/A — SDKs deleted**`. Both edits are staged (`git diff --cached` shows them; unstaged `git diff` on this file is empty).
3. `docs/specs/strategic-review-2026-08/features/10-model-gateway.md` — **not a real dangling reference**, but the original citation (`:11,15`, "zero matches in the 39-line file") is stale: the file has since grown to 207 lines and now contains 4 matches for `sdk/rust`/`sdk/go` at lines 91 and 158–162. All 4 are self-referential "this was already verified deleted" commentary (e.g. "zero dangling references to the deleted `sdk/rust`/`sdk/go` directories... confirmed absent from the repo"), not a citation of a live file path. Net effect is unchanged — no real dangling reference exists in this file — but any future grep of this doc will report a nonzero match count for that file, which is expected and not a regression.

## Remaining stale prose mentions (not fixed — deliberately out of scope, low severity)

These are conceptual/prose mentions of "Go SDK", not broken paths or links — nothing points at a dead file or directory, so nothing is functionally broken. Left as-is per this task's scope (repo/CI hygiene of the `sdk/` deletion itself, not a general SDK-mention sweep):

- `docs/specs/OPTIMIZATION-ID-CHECKLIST.md:32-33` — `K36`/`K37` rows mark Go/Rust SDK optimization work `DONE` for SDKs that no longer exist. Historically accurate (the work happened pre-deletion) but reads as if the SDKs still ship. `docs/specs/strategic-review-2026-08/bugs/01-dead-code-stale-docs.md:302-311` independently flags the same rows and recommends annotating them moot/superseded — worth a one-line fix next time that checklist is touched, not blocking.
- `src/eden/observability/canonical.py:19` — comment: `- any future consumer (TypeScript SDK, Go SDK, etc.) — as long as`. Prose-only, no broken reference.

Not dangling (informational, no action needed): `docs/specs/strategic-review-2026-08/features/09-sdk-dx.md:3,5` scope note ("`sdk/go` and `sdk/rust` were removed from the repo in a separate, unrelated housekeeping pass this session") — written with the deletion in mind and accurate. `README.md` (repo root) has zero Go/Rust SDK references (it does mention `sdk/` generically at line 142 as "Python SDK", a pre-existing minor inaccuracy now that `ts-ai/`, `scripts/`, `DEPLOY.md` also live there — unrelated to the Go/Rust deletion, not flagged as an action item here). `docs/specs/strategic-review-2026-08/INDEX.md:17` — the only SDK-deletion mention in that file — reads `` `sdk-deletion.md` is finalized, unchanged, and out of scope. `` and is accurate.

## Unrelated observation (out of scope, flagging only)

At the start of this task, `git log`/`reflog` showed two commits (`64233475` "feat(debug): per-trace RCA chain, F06 signal-investigate endpoint, MCP checkpoint re-run + transcript tools" and `6f2a09d3` "style(sdk-rust): apply cargo fmt") landed since this session began, absorbing what was previously uncommitted work in the working tree. This was not done by this task — noting for the parent's awareness, not investigated further.

## Verification (pass 4, independent re-check)

Re-ran every check from scratch against the live repo, not trusting prior passes:

- `git status --short -- sdk/` — 30 files, all `D `, matching the file list above exactly. `ls sdk/` → `DEPLOY.md`, `python/`, `scripts/`, `ts-ai/` only.
- `git status --short -- .github/workflows/` — `sdk-go-ci.yml`/`sdk-rust-ci.yml` both `D `; only `sdk-python-ci.yml`/`sdk-ts-ci.yml` remain.
- `docs/specs/SOTA-WAVE-TRACKER.md` staged diff (`git diff --cached`) confirmed for lines 115 and 163; unstaged `git diff` on this file is empty.
- Repo-wide grep for `sdk/go`, `sdk/rust`, `sdk_go`, `sdk_rust` (excluding `.git`, `node_modules`, `target`, `dist`, `build`) — clean everywhere except the items already listed above: `sdk/python`, `sdk/ts-ai`, `clients/` (portal), `docs/docs/**` (public docs site), `docs/docusaurus.config.js`, `docs/sidebars.js`, and repo-root `README.md` all have zero Go/Rust SDK references.
- `docs/docs/how-to/mcp-cursor.md` (shows as `M` in `git status`) is **unrelated** to this deletion — its diff only drops `unlisted: true` from the frontmatter, unconnected to `sdk/go`/`sdk/rust`.

### Final verdict

**Fully clean and commit-ready.** All 30 `sdk/` file deletions and both CI workflow deletions are correctly staged. The one real dangling reference (`SOTA-WAVE-TRACKER.md`) is fixed and staged. `sdk/python`/`sdk/ts-ai`, the portal, and the public docs site are untouched and reference-free. The only remaining "Go SDK" mentions in the repo are prose-only, non-broken, and deliberately out of scope (`OPTIMIZATION-ID-CHECKLIST.md:32-33`, `canonical.py:19`). No untracked leftovers, no wrongly-staged files.
