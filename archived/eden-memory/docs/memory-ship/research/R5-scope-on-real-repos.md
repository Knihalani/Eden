# R5 — Scope derivation (A4 §2.1) on real repositories

**Dated 2026-09-29.** This is an empirical test of the A4 §2.1 scope rule (nearest workspace manifest) and the R3 F9 amendment. The test covers 18 public repos plus Eden. Scripts live in the session scratchpad `scope/` (`scope.ts` is the rule with its switches, `run.ts` runs the variants and holds the ground truth, `perf.ts`, `eden_pred.ts`, `commits.ts`). They are not committed.

## 0. Result in one paragraph

The spec rule as written (**v0**) works for mid-size JS, Python and Rust workspaces: babel, langchain, airflow, vscode, tokio and react agree with a human "product folder" on 93–100% of files. It fails in four ways:

1. **Test/fixture/example manifests become scopes.** turborepo has 1,185 scopes, of which 1,080 are fixtures or examples. cargo has 660, 631 of them fixtures. deno has 529, 457 of them fixtures. nx has 1,269, of which 1,110 are one-file synthetic benchmark packages.
2. **Polyglot and Bazel repos collapse to `""`.** arrow has 78% root-leak and buildbuddy 67%.
3. **Vendored compiled packages become scopes.** next.js has 145 of them under `packages/next/src/compiled/*`.
4. **An untracked-aware or naive filesystem walk explodes.** Eden has 577 on-disk manifests under `.claude/worktrees` against 25 tracked ones, and 368k files on disk against 5.3k from `git ls-files`.

A plain exclusion list (R3 F9 style) fixes the explosion but **makes leakage worse**. Excluded trees such as `examples/`, `archived/`, `tests/*` crates and `fixtures/*` apps collapse into `""`, so their facts become visible repo-wide. Under R3 F9 as written, mean root-leak goes from 10.7% to 22.4%. deno drops to 14.7% agreement and Eden to 17.3%.

The recommended rule (**REC**, §9) keeps members and buckets excluded trees instead of flattening them. It also adds a polyglot manifest set, drops manifest-only scopes, and applies a top-level split only in Bazel roots. Results:

| Metric | v0 | REC |
|---|---|---|
| Mean agreement | 80.9% | **90.2%** |
| Worst-case agreement | 21.9% | 57.9% |
| Mean root-leak | 10.7% | 3.8% |
| Scopes across the 19 repos | 4,961 | 1,251 |
| Scopes with fewer than 5 files | 3,442 | 141 |

**Eden is hard for worktree reasons, not rule reasons.** 75% of the Eden tool paths in transcripts sit under `.claude/worktrees/agent-*/`. Once those paths are made relative to their worktree toplevel, next-turn scope prediction goes from 13/22 to 21/22 (§6).

## 1. Method

- **Repos.** Shallow, blob-filtered partial clones with a sparse checkout of manifest files only:
  - JS/TS workspaces: vercel/turborepo, vercel/next.js, nrwl/nx, microsoft/vscode, facebook/react, babel/babel, supabase/supabase
  - Rust (Cargo workspaces): tokio-rs/tokio, rust-lang/cargo, denoland/deno
  - Go: golang/tools (2 modules), kubernetes/kubernetes (go.work + 30 staging modules)
  - Python monorepos: langchain-ai/langchain, apache/airflow (~100 providers)
  - Single-package: sindresorhus/got (JS), psf/requests (Python)
  - Polyglot: apache/arrow (C++, GLib, Ruby, R, MATLAB, Python)
  - Bazel: buildbuddy-io/buildbuddy
  - Eden itself, read-only, tracked plus untracked-not-ignored files.

  Full clones of got, requests, tokio, react and turborepo were used for the filesystem-walk timings.
- **File universe.** `git ls-files -co --exclude-standard`. This includes untracked files that are not ignored, because an agent edits those too.
- **Ground truth.** For each repo I wrote a glob list of "product folders", meaning what a human would call a sub-project (`run.ts: TRUTH`). A file's product is its deepest matching ancestor, or `""`. The truth was written before the runs. I revised it three times, where my first guess was plainly wrong:
  - airflow provider groups (only `apache|atlassian|cncf|common|dbt|ibm|microsoft/*` are groups);
  - deno `tests/*` (these are Cargo crates);
  - Eden `archived` (a single old Python project).

  In some places the truth is deliberately generous, and the derived scope cannot match it by design: turborepo `turborepo-tests/*` has no manifest; `examples/*` apps; kubernetes `pkg/*` and `cmd/*`.
- **Metrics.**
  - **agree**: share of files whose derived scope equals the truth product.
  - **recall**: share of truth products that appear exactly as a scope.
  - **root-leak**: share of files whose truth product is not `""` but whose derived scope is `""`. Facts learned there are written at root and read everywhere, so this is the metric that maps to G3.
  - **tiny**: scopes with fewer than 5 files.
  - **fixture-like**: scopes with a test, fixture, example or vendor segment in the path.
- **Interpretation of the spec.** "nx.json globs" does not exist as such. nx discovers projects through `project.json`, so v0 treats `project.json` dirs as scopes when an `nx.json` is present. Workspace declarations are honoured wherever they appear: `package.json#workspaces`, `pnpm-workspace.yaml`, `Cargo [workspace].members/exclude`, `go.work use`, `[tool.uv.workspace].members`.

### T1. v0 (spec as written)

| repo | files | products (truth) | scopes | files in `""` | files/scope p50 / p90 / max | scopes < 5 files | fixture/example/vendor scopes | nested scopes | agree | product recall | root-leak | ls-files ms | derive ms |
|---|---|---|---|---|---|---|---|---|---|---|---|---|---|
| vercel/turborepo | 5816 | 130 | 1185 | 2.1% | 2 / 9 / 573 | 874 | 1080 | 1005 | 43.2% | 98% | 0.6% | 134 | 187.6 |
| vercel/next.js | 33374 | 331 | 543 | 63.7% | 3 / 15 / 1891 | 349 | 395 | 271 | 72.1% | 30% | 13.1% | 139 | 144.3 |
| nrwl/nx | 10913 | 136 | 1269 | 2.8% | 1 / 8 / 1568 | 1127 | 56 | 1130 | 84.7% | 96% | 0% | 112 | 34.5 |
| microsoft/vscode | 19549 | 109 | 143 | 61.8% | 8 / 52 / 3998 | 16 | 35 | 125 | 97.5% | 96% | 0.1% | 50 | 36.7 |
| facebook/react | 7252 | 77 | 106 | 4.1% | 13 / 71 / 3873 | 6 | 35 | 28 | 93.2% | 90% | 1.3% | 35 | 28.5 |
| tokio-rs/tokio | 882 | 10 | 13 | 4.1% | 19 / 94 / 574 | 3 | 1 | 2 | 99.3% | 100% | 0% | 20 | 3.9 |
| rust-lang/cargo | 3073 | 27 | 660 | 58.5% | 2 / 3 / 48 | 641 | 631 | 200 | 66.1% | 96% | 0.3% | 81 | 130.6 |
| golang/tools | 2870 | 1 | 4 | 56.3% | 54 / 1195 / 1195 | 0 | 1 | 1 | 97.9% | 100% | 0% | 20 | 3 |
| kubernetes/kubernetes | 31425 | 108 | 51 | 46.3% | 29 / 765 / 4838 | 4 | 14 | 15 | 72.4% | 31% | 26.1% | 44 | 39.5 |
| langchain-ai/langchain | 3169 | 23 | 23 | 3.7% | 36 / 200 / 1655 | 0 | 0 | 0 | 99.9% | 96% | 0.1% | 40 | 14.2 |
| apache/airflow | 14404 | 135 | 155 | 3.1% | 40 / 115 / 1827 | 1 | 1 | 12 | 91.4% | 99% | 0.7% | 48 | 30.2 |
| sindresorhus/got | 132 | 0 | 1 | 100% | 0 / 0 / 0 | 0 | 0 | 0 | 100% | 100% | 0% | 20 | 0.7 |
| psf/requests | 130 | 0 | 1 | 100% | 0 / 0 / 0 | 0 | 0 | 0 | 100% | 100% | 0% | 19 | 0.7 |
| apache/arrow | 5335 | 14 | 2 | 94.5% | 291 / 291 / 291 | 0 | 0 | 0 | 21.9% | 7% | 78.1% | 38 | 4.5 |
| buildbuddy-io/buildbuddy | 3525 | 6 | 2 | 85.3% | 519 / 519 / 519 | 0 | 0 | 0 | 32.9% | 17% | 67.1% | 78 | 3.9 |
| babel/babel | 27735 | 155 | 172 | 0.6% | 24 / 215 / 13093 | 15 | 14 | 8 | 99.6% | 100% | 0% | 49 | 44.7 |
| supabase/supabase | 17669 | 93 | 66 | 6.1% | 20 / 192 / 5324 | 3 | 41 | 0 | 95.4% | 62% | 4% | 43 | 23.4 |
| denoland/deno | 14896 | 74 | 529 | 11.1% | 3 / 9 / 9245 | 400 | 457 | 237 | 79.9% | 93% | 10.2% | 138 | 140.9 |
| Eden (this repo) | 5289 | 34 | 36 | 4.1% | 24 / 118 / 2608 | 3 | 12 | 10 | 89% | 88% | 0.7% | 43 | 9.9 |

**T1 notes:**
- Top-level directories that collapse to `""` under v0 are the expected ones in JS/Rust/Python repos: `.github`, `scripts`, `docs`, `src` and `tests` of single-package repos (got, requests, the root crate of cargo). In three repo types they are whole products:
  - arrow: `cpp` (2,119 files), `r`, `ruby`, `c_glib`, `matlab`;
  - buildbuddy: `enterprise` (1,025), `app`, `cli`, `server`;
  - kubernetes: `pkg` (3,593), `cmd`, `test`, `vendor` (5,271).
- vscode's `src/` (11,645 files, the core) is correctly `""`: it is the root package.

## 2. Pathologies found under v0

| # | Pathology | Where (count of v0 scopes) | Effect |
|---|---|---|---|
| P1 | Test-fixture manifests | cargo `tests/testsuite/cargo_add/*/in` (409), `cargo_remove` (72); deno `tests/registry/npm/*` (210), `tests/specs/npm` (94); turborepo `lockfile-tests/fixtures/*` (~120 dirs, each also declaring its own workspace), `crates/*/fixtures`; vscode `extensions/copilot/test/simulation/fixtures` | Hundreds of 1–3-file scopes. A fact learned while editing a fixture is isolated from the package it tests |
| P2 | Example and template apps, nested 3 deep | turborepo `examples/basic/apps/web` … (~900 incl. nested); next.js `examples/*` (~250); supabase `examples/*/*` (41) | Each example is its own tiny workspace, so its nested `pnpm-workspace.yaml` members become scopes too |
| P3 | Vendored / compiled packages that are tracked | next.js `packages/next/src/compiled/*` (130–145); `test/e2e/*/node_modules` (27); deno `tests/testdata/**/node_modules` | Scopes named after third-party packages |
| P4 | Synthetic packages with only a manifest | nx `benchmarks/packages/group-*/sub-*/leaf-*` (1,110 scopes, 1 file each) | Pure noise. p50 files per scope in nx = **1** |
| P5 | Workspace globs that match dirs without a manifest | Eden `benchmarks/*` matched `benchmarks/lme-v2`, `packages/.tmp-coding`; kubernetes 12 | Scopes that no package manager recognizes. Removing them (F0) changes little (−72 scopes in total) but is correct |
| P6 | Polyglot manifests not recognized | arrow: CMake `project()`, R `DESCRIPTION`, `*.gemspec`, meson → 94.5% of files in `""` | 78% root-leak |
| P7 | Bazel / single-module Go roots | buildbuddy (`MODULE.bazel` + one `go.mod` at root) → 85% in `""`; kubernetes `pkg/*`, `cmd/*` (one module) → 46% in `""` | 67% / 26% root-leak |
| P8 | Filesystem walk instead of git | Eden on disk: 577 manifests under `.claude/worktrees/`, 3,803 under `node_modules`, `.venv`, `.gauntlet` vs 25 tracked | A naive walk would create about 600 scopes, plus one per agent worktree (see §6) |
| P9 | Nested product inside a product | airflow `airflow-core/src/airflow/ui` (JS UI inside the Python core), `providers/fab/.../www`; react `compiler/` (a root-level workspace) | **Correct** behaviour. The UI is its own product. Listed because a max-depth rule would kill it |
| P10 | Bazel `BUILD` files as scopes | buildbuddy: 794 scopes, p50 = 3 files, 711 under 5 files | BUILD marks a build *target* package, not a product. Rejected |

## 3. Before / after
### T2. Before / after: scopes · agree% · root-leak%

| repo | v0 scopes | deny only scopes | R3 F9 scopes | REC scopes | v0 agree | deny only agree | R3 F9 agree | REC agree | v0 leak | deny only leak | R3 F9 leak | REC leak |
|---|---|---|---|---|---|---|---|---|---|---|---|---|
| vercel/turborepo | 1185 | 106 | 95 | 98 | 43.2 | 57.8 | 57.9 | 57.9 | 0.6 | 13.4 | 42.1 | 13.4 |
| vercel/next.js | 543 | 141 | 108 | 140 | 72.1 | 80.1 | 85.1 | 80.1 | 13.1 | 13.9 | 14.3 | 1.8 |
| nrwl/nx | 1269 | 1243 | 1206 | 236 | 84.7 | 84.6 | 80.3 | 84.6 | 0 | 3.9 | 8.3 | 0.1 |
| microsoft/vscode | 143 | 108 | 124 | 108 | 97.5 | 95.2 | 96.9 | 95.2 | 0.1 | 3.5 | 1.1 | 3.5 |
| facebook/react | 106 | 71 | 64 | 71 | 93.2 | 88.1 | 88.4 | 88.1 | 1.3 | 7.8 | 7.8 | 7.8 |
| tokio-rs/tokio | 13 | 13 | 12 | 13 | 99.3 | 99.3 | 96.8 | 99.3 | 0 | 0 | 2.5 | 0 |
| rust-lang/cargo | 660 | 29 | 27 | 29 | 66.1 | 99.5 | 99.7 | 99.5 | 0.3 | 0.3 | 0.3 | 0.3 |
| golang/tools | 4 | 3 | 3 | 3 | 97.9 | 98.1 | 98.1 | 98.1 | 0 | 0 | 0 | 0 |
| kubernetes/kubernetes | 51 | 37 | 38 | 38 | 72.4 | 73.8 | 73.7 | 72.7 | 26.1 | 26.1 | 26.1 | 26.1 |
| langchain-ai/langchain | 23 | 23 | 23 | 23 | 99.9 | 99.9 | 99.9 | 99.9 | 0.1 | 0.1 | 0.1 | 0.1 |
| apache/airflow | 155 | 155 | 154 | 168 | 91.4 | 91.4 | 91.5 | 91.6 | 0.7 | 0.7 | 0.7 | 0 |
| sindresorhus/got | 1 | 1 | 1 | 1 | 100 | 100 | 100 | 100 | 0 | 0 | 0 | 0 |
| psf/requests | 1 | 1 | 1 | 1 | 100 | 100 | 100 | 100 | 0 | 0 | 0 | 0 |
| apache/arrow | 2 | 2 | 2 | 16 | 21.9 | 21.9 | 21.9 | 96.8 | 78.1 | 78.1 | 78.1 | 0.1 |
| buildbuddy-io/buildbuddy | 2 | 2 | 2 | 6 | 32.9 | 32.9 | 32.9 | 98 | 67.1 | 67.1 | 67.1 | 2 |
| babel/babel | 172 | 164 | 157 | 164 | 99.6 | 99.7 | 99.8 | 99.7 | 0 | 0 | 0 | 0 |
| supabase/supabase | 66 | 29 | 25 | 32 | 95.4 | 91.8 | 91.2 | 91.5 | 4 | 8.2 | 8.8 | 0 |
| denoland/deno | 529 | 85 | 65 | 87 | 79.9 | 84.9 | 14.7 | 84.5 | 10.2 | 14.2 | 84.8 | 14.2 |
| Eden (this repo) | 36 | 16 | 16 | 17 | 89 | 17.3 | 17.3 | 76.9 | 0.7 | 82.7 | 82.7 | 3.6 |

- **v0**: mean agree 80.9%, min 21.9%; mean root-leak 10.7%, max 78.1%; total scopes 4961
- **deny only**: mean agree 79.8%, min 17.3%; mean root-leak 16.8%, max 82.7%; total scopes 2229
- **R3 F9**: mean agree 76.1%, min 14.7%; mean root-leak 22.4%, max 84.8%; total scopes 2123
- **REC**: mean agree 90.2%, min 57.9%; mean root-leak 3.8%, max 26.1%; total scopes 1251

### T3. Ablation (all 19 repos): one fix at a time

| variant | total scopes | scopes < 5 files | fixture-like scopes | mean agree | min agree | mean root-leak | max root-leak |
|---|---|---|---|---|---|---|---|
| v0-spec | 4961 | 3442 | 2773 | 80.9 | 21.9 | 10.7 | 78.1 |
| F0 glob-needs-manifest | 4889 | 3393 | 2723 | 80.7 | 21.9 | 10.8 | 78.1 |
| F0+F1 deny | 2229 | 1255 | 63 | 79.8 | 17.3 | 16.8 | 82.7 |
| F0+F2 membership | 4196 | 2889 | 2093 | 80.5 | 21.9 | 11.6 | 78.1 |
| F0+F1+F2 | 2166 | 1218 | 63 | 79.8 | 17.3 | 16.9 | 82.7 |
| F0+F1+bucket | 2234 | 1255 | 68 | 82.9 | 21.9 | 11.4 | 78.1 |
| F0+F1+bucket+min2 | 1214 | 134 | 68 | 82.9 | 21.9 | 11.4 | 78.1 |
| F0+F1+bucket+min3 | 1174 | 94 | 67 | 82.9 | 21.9 | 11.5 | 78.1 |
| F0+F1+bucket+depth4 | 1210 | 139 | 67 | 83.3 | 21.9 | 11.4 | 78.1 |
| F0+F1+bucket+min2+poly | 1247 | 141 | 70 | 86.8 | 32.9 | 7.3 | 67.1 |
| …+top200 (any repo) | 1256 | 141 | 70 | 87.8 | 50.8 | 3.7 | 26.1 |
| REC (…+top200 bazel-only) | 1251 | 141 | 70 | 90.2 | 57.9 | 3.8 | 26.1 |
| REC but bucket all test/fixture | 1270 | 142 | 89 | 81.8 | 23.4 | 1.9 | 26.1 |
| R3-F9 literal | 2123 | 1217 | 19 | 76.1 | 14.7 | 22.4 | 84.8 |
| bazel BUILD as manifest | 3026 | 1966 | 68 | 82.3 | 21.2 | 7.9 | 78.1 |

(`agree`, `leak` in %. `REC` is the recommended rule in §9. `deny only` = tracked + exclusion list + members beat exclusion, with no bucketing.)

### What each fix does (read from T3 and per-repo rows)

- **F0 (a glob match needs a manifest).** Negligible in size (−72 scopes). Keep it for correctness: it matches npm, pnpm and Cargo semantics.
- **F1 (exclusion list), applied alone, is a trade.** It removes 2,700 junk scopes: fixture-like scopes fall from 2,773 to 63; cargo 660 → 29 (agreement 66 → 99.5%); deno 529 → 85; turborepo 1,185 → 106. It also **raises mean root-leak from 10.7% to 16.8%**:
  - react `fixtures/*` apps: leak 1.3 → 7.8%;
  - supabase `examples/*`: 4 → 8.2%;
  - next.js `examples/*`: 13.1 → 13.9%;
  - turborepo, where examples are members but lockfile fixtures are not: 0.6 → 13.4%.

  An excluded tree does not vanish. It goes to its nearest ancestor, which is often `""`, where its facts are visible everywhere.
- **Bucketing fixes that leak.** A denied manifest under an *examples/archive-class* segment (`examples`, `example`, `samples`, `templates`, `starters`, `boilerplates`, `archived`, `attic`, `legacy`, `deprecated`) makes **one** scope at that segment, e.g. `examples` or `archived`. It does not make one scope per app. Mean root-leak drops to 11.4 (then 3.8 with the other fixes) and agreement rises 79.8 → 82.9. Buckets are created only when a manifest actually sits under the segment, so got's and requests' `test/` stay `""`.
- **Bucketing test/fixture-class trees as well** ("bucket all") is rejected. It drives root-leak to 1.9%, but it splits `tests/` from `src/` in root crates: cargo's agreement goes 99.5 → 27%, next.js 80 → 23%. That is the A1 C1.2 `"" ↔ src` invisibility regression again. Test fixtures belong to the package they test, so collapsing them into it is right.
- **Members beat exclusion.** nx declares `e2e/*` and next.js declares `turbopack/crates/turbopack-tests/tests/execution`. Explicit declarations are human intent and should win. Workspace declarations that are *themselves* inside an excluded dir are ignored. Without that, the ~120 fixture workspaces in turborepo re-admit their own members: 876 scopes instead of 106.
- **F2 (members only, when a workspace is declared) is rejected as a hard filter.** It cuts next.js well (543 → 116), but the exclusion list already gets there (141). Where they disagree, F2 drops real products:
  - Eden `archived/clients/portal` (819 files, not a root member);
  - react `fixtures/*`;
  - supabase `examples`;
  - deno recall 93 → 86%.

  "Members first" is right as a *tie-break* (members beat the exclusion list), not as a filter.
- **Minimum files.** `min2`, i.e. a scope must own at least one file besides its manifest, removes P4. nx goes 1,244 → 234 scopes and tiny scopes across all repos go 1,255 → 134, with **no** agreement loss. `min3` also drops real small crates: cargo recall 96 → 74%, where the `crates/xtask-*` crates have 2 files; tokio `tokio-macros` too. Use 2.
- **Max depth 4** helps next.js (agree 80 → 85: deep `turbopack/.../tests/execution` and `evals/evals/*`), but kills legitimate deep products: airflow `providers/*/src/airflow/providers/*/www`, depth 6–7. Its net effect is small (+0.4 mean). Rejected; `min2` and the exclusion list already bound the damage.
- **Polyglot manifests** (CMake/meson files containing `project(`, R `DESCRIPTION` with `Package:`, `*.gemspec`, `pom.xml`, `build.gradle(.kts)`, `*.csproj`, `composer.json`, `mix.exs`, `Package.swift`, `pubspec.yaml`, `setup.py`, `setup.cfg` with `[metadata] name`, `deno.json`):
  - arrow: 21.9 → 96.8%, leak 78 → 0.1;
  - no regressions elsewhere: airflow +0.2, supabase ±0; deno −0.4 from `deno.json` test dirs.
- **Top-level split (≥ 200 files, only when `""` would own > 50% of files).**
  - In a Bazel/Buck/Pants root: buildbuddy 32.9 → 98%.
  - Applied to any repo, it breaks golang/tools (98 → 51%): `go/` and `internal/` split off the root module.
  - Scoped to Bazel roots it has no side effects on the other 18 repos.
  - It does not fire on kubernetes (`""` = 46.6%). kubernetes stays the worst case, at 26% leak. A single Go module with a `pkg/<component>` layout is not recoverable from manifests. That is what the `.eden/scopes` override is for.
- **Bazel `BUILD` as a manifest: rejected.** buildbuddy gets 794 scopes, p50 = 3 files, agreement 21%.

## 4. R3 F9, evaluated as written

R3 F9 = tracked-only candidates; exclude the segments `{test, tests, __tests__, fixtures, __fixtures__, testdata, examples, example, e2e, vendor, third_party, archived, .claude}`; if the root declares workspaces, scopes = matched members only; two-segment fallback for `apps|packages|services|libs|cmd/*` when only `""` remains.

| repo | v0 agree / leak | R3 F9 agree / leak | REC agree / leak | Why R3 loses |
|---|---|---|---|---|
| denoland/deno | 79.9 / 10.2 | **14.7 / 84.8** | 84.5 / 14.2 | `tests/*` are **Cargo members** (`tests/specs`: 9,895 files); the exclusion beats membership, so 85% of the repo falls to `""` |
| Eden | 89.0 / 0.7 | **17.3 / 82.7** | 76.9 / 3.6 | `archived` (4,182 files, a whole old project) falls to `""` |
| vercel/turborepo | 43.2 / 0.6 | 57.9 / **42.1** | 57.9 / 13.4 | `examples` is a declared member but excluded, so it falls to `""`; lockfile fixtures too |
| nrwl/nx | 84.7 / 0 | 80.3 / 8.3 | 84.6 / 0.1 | `e2e/*` members excluded; no minimum size, so 1,206 scopes (1-file benchmark leaves survive as named npm packages) |
| supabase | 95.4 / 4 | 91.2 / 8.8 | 91.5 / 0 | `examples/*` falls to `""` |
| apache/arrow | 21.9 / 78.1 | 21.9 / 78.1 | 96.8 / 0.1 | no polyglot manifests; the fallback dirs don't exist |
| buildbuddy | 32.9 / 67.1 | 32.9 / 67.1 | 98.0 / 2.0 | Bazel; fallback dirs (`app`, `server`, `enterprise`) are not in the fallback list |
| vercel/next.js | 72.1 / 13.1 | **85.1** / 14.3 | 80.1 / 1.8 | R3 wins on agreement. Members-only drops deep test packages, but 4k `examples/` files leak to `""` |

R3's parts that hold up: tracked-only discovery (P8), an exclusion list, `.eden/scopes` override, and rebuilding on manifest writes. Its parts that fail are the ordering (exclusion must lose to explicit membership) and the destination of excluded trees (`""`). In aggregate, R3 F9 as written is **worse than v0**: mean agreement 76.1 vs 80.9, mean root-leak 22.4 vs 10.7. The two-segment fallback never fired on these 19 repos. It is harmless, but it did not rescue the root-only repos here (arrow, buildbuddy, kubernetes), because their product dirs are not named `apps|packages|services|libs|cmd`.

## 5. How often the derived scope is the "product folder"

Under REC:
- **Workspace repos with honest manifests** reach ≥ 91% agreement with product recall ≥ 90%: babel 99.7, langchain 99.9, tokio 99.3, cargo 99.5, airflow 91.6, vscode 95.2, arrow 96.8, buildbuddy 98.0.
- **Mid band, 80–92%:** react 88, nx 85, deno 85, next.js 80, supabase 92. The remaining misses are:
  - intentional buckets (`examples/*` → `examples`, react `fixtures/*` → `""`, since top-level `fixtures` is not bucketed);
  - products with no manifest (next.js `evals`, `bench/basic-app`; turborepo `turborepo-tests/*`).
- **Worst cases:**
  - **turborepo 58%**: 1,668 example files go to one `examples` bucket (truth: per example), plus 777 files of the manifest-less `turborepo-tests/integration`;
  - **kubernetes 73%**: one Go module, components under `pkg/*` / `cmd/*`.

Single-package repos (got, requests) are 100% `""`, as intended. No split of `src/` versus `test/` was produced in any repo.

## 6. Why Eden is hard (R6: manifest prediction 46% in Eden vs 85% overall)

The rule is not the cause. The inputs are.

1. **Agent worktrees.** In this machine's Eden transcripts (4 main sessions plus their subagents), 463 of 621 Eden tool paths (**75%**) are under `Eden/.claude/worktrees/agent-*/…`. A further 127 paths went to a sibling repo's worktrees. `git rev-parse --show-toplevel` there returns the worktree, so a cwd- or disk-relative walk yields scopes like `.claude/worktrees/agent-a07…/packages/know`: a new scope per agent. 27 distinct scope strings appear for what is 5 real scopes.
2. **On-disk junk.** A filesystem walk sees 577 manifests under `.claude/worktrees`, plus `.venv`, `.venv-test`, `.gauntlet` and 3,803 in `node_modules`. `git ls-files` sees 25.

Next-turn prediction on the same transcripts (prev-3-turn majority equals this turn's majority; 28 turns with Eden paths, 22 with a predecessor):

| Scheme | Distinct scopes seen | Multi-scope turns | Prediction |
|---|---|---|---|
| Naive disk walk, worktree prefix kept (≈ R6's proxy) | 27 | 11 / 28 | 13 / 22 (59%) |
| `scope2` (first two segments), worktree-normalized | 17 | 14 / 28 | 14 / 22 (64%) |
| v0 rule, worktree-normalized, tracked files | 6 | 6 / 28 | 19 / 22 (86%) |
| **REC, worktree-normalized, tracked files** | 5 | 5 / 28 | **21 / 22 (95%)** |

Small n, so treat these as directional. The effect is large, and it is the same fix as R3 F7: resolve every path to `(git-common-dir, path relative to *its own* worktree toplevel)` before scoping.

Eden's commit history shows the work itself is not scattered. Of the last 400 commits, 388 touch exactly one REC scope, and all 12 multi-scope ones are `""` plus `packages/cli`.

Eden's remaining structural quirks:
- `docs/`, `src/`, `scripts/` and `examples/` live at `""`;
- `benchmarks/*` members mostly have no manifest (only `benchmarks/campaign` does);
- `archived/` is a whole previous product. REC buckets it as `archived`. v0 split it into 10 scopes. R3 flattened it into `""`.

## 7. Repo identity

Tested in a scratch repo with a linked worktree, a submodule, a symlinked path, a second clone and a non-git dir. Eden's own worktrees were used too (`git worktree list` shows 30, most of them prunable under `/private/tmp`, plus 21 under `.claude/worktrees`).

| Case | `--show-toplevel` | `--git-common-dir` (absolute) | remote URL | Right key |
|---|---|---|---|---|
| main checkout | `main` | `main/.git` | `git@github.com:Acme/Repo.git` | common-dir |
| linked worktree `wt` | **`wt`** (differs) | `main/.git` (same) | same | common-dir ✓ (toplevel ✗) |
| Eden agent worktree `.claude/worktrees/agent-*` | the worktree path | `Eden/.git` | same | common-dir ✓ |
| path through a symlink `link/packages/a` | `main` (resolved) | `main/.git` | same | either |
| case-variant path `/users/…/downloads/eden` (APFS) | canonical `…/Downloads/Eden` | canonical | — | either (git and `fs.realpathSync(.native)` both canonicalize) |
| submodule `vendor/sub` | `main/vendor/sub` | `main/.git/modules/vendor/sub` | its own | its own store (by design); the superproject's `ls-files` lists it as one gitlink, so it never enters the parent's scopes |
| second clone `clone2` | `clone2` | `clone2/.git` | `main` (a local path) | separate store unless relinked. The remote-URL key would merge clones but also forks, and local-path remotes make it meaningless |
| bare repo | error: "must be run in a work tree" | — | — | no store |
| non-git dir | error | error | — | `hash(realpath(cwd at SessionStart))`, scope `""` |

`git rev-parse --show-toplevel --path-format=absolute --git-common-dir` costs 20–40 ms per call here (cold process). Cache `cwd → (repo, toplevel)` as R3 F7 says, and make every path relative to the toplevel **of the worktree that contains that path**, not the session cwd's.

**Verdict:** adopt R3 F7 (`repo = hash(realpath(git-common-dir))`). Do not key on the remote URL by default.

## 8. Performance

Full checkouts; macOS APFS; warm cache unless noted.

| repo | files (ls-files -co) | `git ls-files` tracked / -co --exclude-standard | disk walk all / without node_modules | derive REC | scopes.json | cached lookup | uncached per-file stat walk |
|---|---|---|---|---|---|---|---|
| got | 132 | 14 / 26 ms | 132 files, 2 ms | 5 ms | 6 B | 0.45 µs | 8 µs |
| requests | 130 | 17 / 23 ms | 1 ms | 2 ms | 6 B | 0.23 µs | 15 µs |
| tokio | 882 | 14 / 23 ms | 3 ms | 7 ms | 196 B | 0.16 µs | 7 µs |
| react | 7,252 | 19 / 67 ms | 14 ms | 31 ms | 2.5 KB | 0.28 µs | 14 µs |
| turborepo | 5,816 | 16 / 134 ms | 45 ms | 130 ms | 2.8 KB | 0.27 µs | 6 µs |
| Eden | 5,289 | 15 / 39 ms | **368,358 files, 1,145 ms** / 225,105, 769 ms | 15 ms | 297 B | 0.28 µs | 14 µs |
| next.js (sparse) | 33,374 | 90–215 ms | — | 90–170 ms | ~5 KB | — | — |
| kubernetes (sparse) | 31,425 | 38–44 ms | — | 40–50 ms | — | — | — |

- A **sleep-time rebuild** is ≤ 0.4 s even on next.js-sized repos. Cold-cache first runs were 1–5 s.
- The **Submit-time cost** is one longest-prefix lookup, under 1 µs.
- The spec's per-file upward stat walk (6–15 µs per path, uncached) is also affordable. It is **wrong**, though, because it sees untracked `node_modules` and worktrees. Use the catalog.
- The filesystem walk is 30–70× slower than `ls-files` in a real dev checkout (Eden). It is also semantically wrong.

## 9. Recommended rule (replaces A4 §2.1 steps 1–4 and R3 F9 steps 2–5)

**9.1 Identity** (= R3 F7)
- `repo = hash(realpath(git rev-parse --path-format=absolute --git-common-dir))`.
- For every path, `top = git -C <dir of path> rev-parse --show-toplevel`, cached per worktree root. `rel = realpath(path)` made relative to `top`, with `/` separators. On case-insensitive filesystems, use the canonical case returned by `realpath.native`.
- A path whose `top` has a different common-dir belongs to another repo (submodule, or a sibling repo's worktree) and is ignored for this repo's scope.
- No git: `repo = hash(realpath(cwd at SessionStart))`, and every scope is `""`.

**9.2 Catalog** (built at sleep; rebuilt after any PostToolUse `Write`/`Edit` whose basename is in the manifest set or a workspace file)
1. `F = git ls-files -z -co --exclude-standard` in the main worktree. Tracked plus untracked-not-ignored; never a filesystem walk.
2. **Manifest set.** A directory `d` is a *candidate* if `F` contains `d/X` for any of:
   - `package.json` with a string `name`;
   - `Cargo.toml`, `go.mod`, `pyproject.toml`;
   - `deno.json`, `setup.py`, `setup.cfg` containing `[metadata]` … `name =`;
   - `pom.xml`, `build.gradle`, `build.gradle.kts`, `*.gemspec`, `*.csproj`, `*.fsproj`, `composer.json`, `mix.exs`, `Package.swift`, `pubspec.yaml`;
   - R `DESCRIPTION` whose first field is `Package:`;
   - `CMakeLists.txt` or `meson.build` containing a line matching `^\s*project\s*\(`;
   - `project.json`, only if `nx.json` is in `F`.

   Bazel `BUILD` files are **not** manifests.
3. **Workspace declarations**, read from files in `F`: `package.json#workspaces` (array or `.packages`), `pnpm-workspace.yaml#packages`, `Cargo.toml [workspace].members` minus `.exclude`, `go.work use`, `pyproject [tool.uv.workspace].members` minus `.exclude`.
   - Globs resolve relative to the declaring file's directory and use `!` for negation.
   - A *member* is a matched directory that is also a candidate. A glob match without a manifest is not a scope.
   - A declaration whose own directory is excluded (step 4) is ignored.
4. **Exclusion.** A candidate is *excluded* if any segment of `d` (case-insensitive) is in one of:
   - `VENDOR = {node_modules, bower_components, vendor, vendored, third_party, third-party, thirdparty, external, dist, build, out, target, compiled, precompiled}`;
   - `TEST = {test, tests, __tests__, __mocks__, __snapshots__, snapshots, fixtures, fixture, __fixtures__, testdata, test-data, testcases, e2e, integration-tests}`;
   - `EXAMPLE = {examples, example, samples, sample, templates, template, starters, boilerplates, archived, attic, legacy, deprecated}`;

   or if the segment starts with `.`, or starts with a single `_` (Go's rule).

   **Exception:** a member (step 3) is never excluded.
5. **Buckets.** An excluded candidate whose first excluded segment `s` is in `EXAMPLE` adds one scope: the path up to and including `s`, provided no earlier segment is excluded. Examples: `examples`, `archived`, `packages/foo/templates`. `TEST` and `VENDOR` exclusions add nothing: those files belong to the enclosing package.
6. **Scopes** = `{""}` ∪ non-excluded candidates ∪ members ∪ buckets.
7. **Minimum size.** Deepest first, drop any scope `s ≠ ""` that owns fewer than 2 files of `F` (i.e. only its manifest). Its files re-home to the nearest remaining ancestor.
8. **Bazel/Buck/Pants fallback.** If `F` has a root `MODULE.bazel`, `WORKSPACE`, `WORKSPACE.bazel`, `BUCK`, `.buckconfig` or `pants.toml`, **and** `""` owns more than 50% of `F`: every top-level dir that owns ≥ 200 files is added as a scope, except `src, lib, source, include, docs, doc` and excluded names.
9. **Override.** `.eden/scopes` (tracked; one glob per line; `!glob` removes) is applied last. It is the answer for single-module Go repos (kubernetes `pkg/*`), manifest-less products (turborepo `turborepo-tests/*`, next.js `evals`) and top-level app fixtures (react `fixtures/*`).
10. **Persist** `scopes.json` as the sorted list. **Lookup:** strip the file name, then take the longest scope that is a prefix on a `/` boundary; otherwise `""`. Lookup never touches the filesystem.

**9.3 Required unit rows** (in addition to R3 F9's)

| Row | Case | Expected |
|---|---|---|
| a | cargo-style `tests/testsuite/x/in/Cargo.toml` | scope `""`, not a new scope |
| b | deno-style `tests/specs/Cargo.toml` listed in `[workspace].members` | scope `tests/specs` (member beats exclusion) |
| c | `examples/foo/package.json` not a member | scope `examples` (bucket), **not** `""` |
| d | `archived/pyproject.toml` | scope `archived` |
| e | pnpm workspace inside `examples/basic` declaring `apps/*` | declaration ignored; still `examples` |
| f | `packages/next/src/compiled/@babel/runtime/package.json` | scope `packages/next` |
| g | nx-style leaf package containing only `package.json` | no scope (min2) |
| h | 2-file crate (`Cargo.toml` + `src/main.rs`) | is a scope (min2 keeps it; min3 would not) |
| i | arrow-style `cpp/CMakeLists.txt` with `project(Arrow …)` | scope `cpp`; a `CMakeLists.txt` with no `project(` adds nothing |
| j | Bazel root, `enterprise/` holding 1,000 files | scope `enterprise`; the same tree without `MODULE.bazel` gives `""` |
| k | `.claude/worktrees/agent-x/packages/know/src/a.ts` | repo = main repo; scope `packages/know` |
| l | single-package repo with `src/` and `test/` | both `""` |

## 10. Caveats and what this does not settle

- **Ground truth is one person's judgment.** Where it is generous (per-example products, kubernetes components), a manifest rule cannot match it by construction. The honest numbers are the *relative* ones between variants.
- **Remaining misses and how to handle them:**
  - Buckets merge unrelated examples into one scope. That is better than `""` (no repo-wide leak) and far better than 900 scopes, but a fact true in one example is visible in all the others. If that matters, let sleep split a bucket that accumulates conflicting values for one key.
  - The 50% and 200-file thresholds of the Bazel fallback were tuned on one Bazel repo. They are guarded by the Bazel-root condition, so they cannot fire elsewhere.
  - Manifest-less products are unfixable automatically. Use `.eden/scopes`.
- **Read scope in fan-out turns.** A4 §2.2 takes the common ancestor when paths span scopes. In Eden, and in any multi-package turn, that ancestor is usually `""`, which cannot see package facts. That is a read-rule question, not a derivation question. R6 already recommends weighting main-thread and recent paths.
- **Tracked-only discovery lags.** A newly created package is invisible until its manifest is written (rebuild trigger) *and* it has one more file (min2). Run the rebuild on the PostToolUse `Write` of the second file too, or accept one turn of lag.
