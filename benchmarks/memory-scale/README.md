# Memory scale benches

Two benches for the memory product at scale:
- **`locked-2k.ts`**, the locked `whatever` bench. It is saturated and kept as a regression floor.
- **`hard.ts`**, a harder bench that `main` does not saturate, so an improvement is measurable.

## Locked 2k bench (regression floor)

`locked-2k.ts` and `locked-contract.test.ts` are byte-for-byte copies of the locked `whatever` harness. That
harness lived only in the main checkout's git-excluded `.whatever/` directory, so it was not in git.

| File here | Source | sha256 of the source (= this file) |
|---|---|---|
| `locked-2k.ts` | `.whatever/benches/scale.ts` | `606edb61a5211fa8753e1254e39baff2d5b59dcdaa86231dde051d0c39b51b07` |
| `locked-contract.test.ts` | `.whatever/benches/contract.test.ts` | `3eb31afebbcc76b570d4695337be74c40a255e9247a813b71379f10ba56afcc8` |

- The harness config was `.whatever/harness.json` (sha256
  `153fe4a8b2d9057d90329c2dfb3a1935928ff272d4816e0d9e5fa4e6095a3924`). Its primary was
  `bun .whatever/benches/scale.ts` → `metric:` (misses, lower is better). Its guards were `ms:`, `bytes:` and the
  contract test plus five memory test files.
- The loop's baseline commit was `8a6b4705f`, where the bench scored 1 miss. Experiment 1 (`e52050501`) took it
  to 0, and it stayed at 0 for the remaining 320 experiments (`.whatever/results.tsv`, `.whatever/best.json`).
- The import paths needed no change: `benchmarks/memory-scale/` has the same depth as `.whatever/benches/`.

**It is a regression floor.** It must stay at `metric: 0` on `main`. It is saturated, so it cannot show an
improvement. Its blind spots are listed in `docs/memory-ship/A5-EVALUATION.md` §1.

```bash
bun run bench:memory-locked       # metric: 0, ms, bytes, n
bun test benchmarks/memory-scale/locked-contract.test.ts
```

Do not edit these two files. If the product's API changes under them, fix the import only and say so here.

## Hard bench

```bash
bun run bench:memory-hard                     # dev split: tune on this one
bun run bench:memory-hard -- --split test     # locked test split: never tune on it
bun run bench:memory-hard -- --split all      # both; keys get a dev. / test. prefix
bun run bench:memory-hard -- --detail         # dev only: each failing case with its classified bullets
bun run bench:memory-hard -- --no-sleep       # skip the Stop-hook consolidation (faster, not the baseline)
```

It takes 18–23 s on an Apple M3, most of it the Stop-hook consolidation. It is deterministic, uses no network
or model, and depends on the clock only through injected time.

### What it builds

The files are `hard-world.ts` (hand-written data and seeded generators), `hard-oracle.ts` (scoring; it never
imports the product) and `hard.ts` (the runner).

**The world.** One store holds 20,142 rows:
- **3 repos**, `acme-shop`, `acme-infra` and `acme-data`, each with its own `cwd`.
- **14 services, apps, pipelines and tools** in them. Each has its own `db`, `auth` and `ci`, plus about 70% of
  `cache`, `queue`, `deploy`, `errors` and `tests`. Units reuse the same values, and two pairs have near-duplicate
  names (`billing` / `billing-worker`, `search` / `search-indexer`).
- **4 repo-level facts per repo** (package manager, runtime, base branch, formatter). Only the `cwd` scopes them:
  the prompt never names the repo.
- **6 codename anchors** ("Kestrel is the codename for the billing ledger rewrite").
- **20 slots that change value later.** Each split gets 2 of each kind: dropped ("we dropped Redis from admin
  entirely"), updated A→B ("… is now B"), migrated A→B ("we moved X from A to B"), changed twice A→B→C, and
  reverted A→B→A.
- **Distractors:** 6 staging twins ("The admin staging database is …") and 8 negations ("We never adopted X for
  Y").
- **20,000 background episodes.** They share the unit names, folder paths and slot words, but never state a value.
  They are skewed like real traffic: 4,200 rows mention `billing`, and 60 mention `scoring`.

**How it is written.** The timeline has 8 sessions. Each (session, repo) batch is written by a fresh
`openMemory({ dir, cwd })`: a new process's view of the store. After the last session, one full `consolidate()`
runs, as the Stop hook does.

**How it is read.** Each case is one `openMemory().inject()` call, the call the UserPromptSubmit hook makes. It
runs on an instance opened with the repo's `cwd`, and passes the prompt plus, for acks, the assistant's previous
report.

**Deliberate settings** (all in `hard.ts`):
- `EDEN_MEMORY_STORE_CAP=1000000`, so the default 2,000-row trim does not delete the haystack. A5's scale-20k arm
  measures retrieval at 20k rows. At the product default, the store would keep only 2,000 of them.
- Scoring runs with `EDEN_MEMORY=readonly`. `inject` would otherwise write some prompts back, and a case's result
  would then depend on the cases before it.
- `Date.now` is replaced by a counter during a run: 2026-01-05 09:00 UTC, +1 ms per call, +30 s per turn,
  +1 day per session. Record times and ties are identical from run to run. `performance.now`, used for timings,
  is untouched.
- Every `EDEN_*` variable is cleared, and `EDEN_HOME` and `EDEN_MEMORY_DIR` point into a temp dir. The temp dir is
  removed and the caller's variables are restored at the end.

### Cases and their oracles

Every template, paraphrase, alias, negative and report is hand-written. None is model-generated.
`bench.test.ts` checks two properties:
- no paraphrase or alias shares a word with anything the slot's facts say;
- every named cue carries the slot's key word.

| Category | Dev / test | What the cue is | Passes when |
|---|---|---|---|
| `anchor` | 3 / 3 | a rare codename ("what's Kestrel?") | the codename's row, and nothing else, is injected. This is the known-pass floor |
| `named` | 26 / 24 | unit + slot word ("which database does billing use?") | the current value for that unit's slot is injected; nothing off-slot; nothing stale |
| `para` | 26 / 24 | unit + paraphrased slot ("where does billing store its records?") | same as `named` |
| `alias` | 10 / 10 | paraphrased unit and slot, no shared word ("where does the invoicing service store its records?") | same as `named` |
| `path` | 20 / 20 | a file path in the unit's folder + a question ("services/billing/src/db/pool.ts keeps timing out …") | same as `named` |
| `repo` | 6 / 6 | a generic question; only the `cwd` says which repo | that repo's fact, not another repo's |
| `stale` | 20 / 20 | a named or path cue for a slot whose value changed | the statement that set the current value (a drop answers "none"); no superseded value |
| `distract` | 16 / 14 | production vs staging db; sibling units; slots with a negation | the asked slot only: staging is false for a production cue, a sibling's facts are false, the negation is allowed |
| `redundant` | 6 / 6 | states fact X, asks slot Y ("Since the billing CI pipeline runs on Drone, what database is billing on?") | Y is injected and X is not |
| `ack` | 12 / 12 | an A7 §2 ack after an assistant report | no packet (A5 silence b) |
| `nonhuman` | 4 / 4 | a `<task-notification>` submit | no packet (A5 silence a) |
| `chatter` | 8 / 8 | human small talk | no packet |
| `offtopic` | 10 / 10 | a general question with stored words ("how does Postgres MVCC work in general?") | no packet (R1 hard lexical traps) |

**Mapping bullets to meanings.** Each bullet is stripped of its dash, provenance label, case and end punctuation.
It is then read as the first of these that matches:
1. a known statement (exact match, then containment);
2. a background row;
3. a rewritten copula `The <subject> is <value>`, where the subject is one a statement used;
4. otherwise, unknown.

A statement is **stale** when the value it asserts is not its slot's current value, or the value it denies is
the current one. The world oracle is the last value asserted for each slot in the timeline.

`unknown_bullets` counts text the oracle could not read. It is 0 on the baseline. If it rises, the product has
started to rewrite bullets: extend the oracle in a `fixture:` commit.

### Checks and the metric

Each positive case has three checks (four with a stated slot). Each negative case has one.

| Check | Fails when |
|---|---|
| `need` | a needed slot has no bullet with its current value, and the cue does not state it either |
| `precision` | any bullet is *false*: unknown text, a background row, or a statement about a slot the cue neither asks nor states |
| `stale` | any bullet is stale (A5 hard gate: 0) |
| `redundant` | any bullet restates a slot the cue itself states (only on `redundant` cases) |
| `silence` | a negative case gets a packet |

**`metric:` = failed checks on the split. Lower is better, and 0 is perfect.** The `fail_*` lines split it by check
and the `cat.*` lines by category. Both sum to `metric`.

The other lines follow A5 §2:
- `need_miss_rate`: positive cases with a missed need ÷ positive cases.
- `false_rate`: bullets ∉ needs ∪ allowed ÷ bullets. As in A5, this includes stale bullets.
- `stale_rate` and `redundant_rate`: per bullet.
- `ack_packets` (A5 silence b) and `nonhuman_packets` (A5 silence a): both must be 0.
- `wrong_scope_bullets`: false or stale bullets about the asked slot type, but for another unit or repo. This is
  where the wrong subject won.
- `digest`: a hash of every case's failed checks and bullets. Two runs agree if and only if their digests do.

Scale lines:
- `n` and `bytes`: rows and bytes in `memories.jsonl`. `dir_bytes` is the whole store directory.
- `build_ms`: the write time. `sleep_ms`: the one full consolidation.
- `p50_ms` and `p99_ms`: warm in-process `inject`, over 4 passes of both splits' cases (`timing_samples`, ≥ 1,000
  as A5 requires for a p99).
- `cold_ms`: the median of 5 runs of "open the store, then one `inject`". This is what a fresh hook process pays
  before Bun's own startup.

### Dev and locked test (EXECUTION X5)

- The seeds are fixed in `hard-world.ts`: world `20260930`, dev `0xde7`, test `0x7e57`.
- The two splits share the world. They draw from disjoint (unit, slot) pairs, cue templates, aliases, anchors,
  acks, reports, chatter and off-topic sets. `bench.test.ts` asserts that no cue and no need is shared.
- Tune on dev only. `--detail` refuses the test split. Score the test split once per change, and report both.
- Changing a template, a seed or the oracle changes the numbers. Record a new baseline in the same commit, and say
  why.

### Baseline on `main`

Measured on 2026-09-30 on product commit `f29cfcb8a` (`origin/main`; this branch changes no product file). It ran
twice in fresh processes (`HOME=$(mktemp -d) bun run bench:memory-hard -- --split all`), on Bun 1.3.13 on an Apple
M3. Both runs matched exactly, digests included, except for the timing lines. Other test runs shared the machine,
so timings vary from run to run; compare them only within one quiet session.

The harness files hashed as follows (sha256):
- `hard.ts`: `bf6f490a1189fe42a1b42bb8538034d218e0875ffa17d757cc33c243fd72e7ea`
- `hard-world.ts`: `fff47ad08d7d0400954ccaec64cd663584a077910fdf9ae299222dbb2f3e3eaa`
- `hard-oracle.ts`: `f27f11d29b0383650006c0aa547b27bc475f68d3d3e906f98d9751796bc8ef6d`

| | dev | test |
|---|---|---|
| **metric** (failed checks / checks) | **276 / 439** | **244 / 421** |
| cases passing every check | 28 / 167 | 32 / 161 |
| `need` fails | 103 / 133 | 91 / 127 |
| `precision` fails | 123 / 133 | 118 / 127 |
| `stale` fails | 34 / 133 | 24 / 127 |
| `redundant` fails | 6 / 6 | 6 / 6 |
| `silence` fails | 10 / 34 | 5 / 34 |
| need_miss_rate | 0.774 | 0.717 |
| false_rate | 0.953 | 0.942 |
| stale_rate | 0.062 | 0.065 |
| redundant_rate | 0.008 | 0.008 |
| wrong_scope_bullets | 97 | 46 |
| ack_packets (gate 0) | 0 / 12 | 0 / 12 |
| nonhuman_packets (gate 0) | 4 / 4 | 4 / 4 |
| digest | `f85d1c855e883d64` | `33b5c82e4738ba0f` |

| Category | dev failed / checks | test failed / checks |
|---|---|---|
| anchor | 0 / 9 | 0 / 9 |
| named | 46 / 78 | 40 / 72 |
| para | 57 / 78 | 46 / 72 |
| alias | 15 / 30 | 17 / 30 |
| path | 41 / 60 | 39 / 60 |
| repo | 11 / 18 | 13 / 18 |
| stale | 45 / 60 | 44 / 60 |
| distract | 28 / 48 | 20 / 42 |
| redundant | 23 / 24 | 20 / 24 |
| ack | 0 / 12 | 0 / 12 |
| nonhuman | 4 / 4 | 4 / 4 |
| chatter | 2 / 8 | 0 / 8 |
| offtopic | 4 / 10 | 1 / 10 |

| Scale | run 1 | run 2 |
|---|---|---|
| n | 20142 | 20142 |
| bytes | 4946744 | 4946744 |
| dir_bytes | 7585689 | 7585689 |
| build_ms | 4885 | 5033 |
| sleep_ms | 16008 | 11152 |
| p50_ms | 0.165 | 0.104 |
| p99_ms | 0.377 | 0.142 |
| cold_ms | 183.8 | 134.0 |
| timing_samples | 1312 | 1312 |

**What the baseline shows** (dev numbers; `--detail` shows each case):
- The anchors and acks all pass, so the harness can see a hit and the silence floor holds.
- Most cues miss the fact they need: 103 of 133 positive cases.
- Packets are rarely clean. 123 of 133 positive cases get at least one false bullet: a background row, or another
  unit's or repo's fact (97 bullets are about the asked slot of the wrong subject).
- Superseded values are injected in 34 of 133 positive cases.
- Every task notification gets a packet.
- The `cwd` scopes nothing: a repo cue in `acme-data` gets `acme-shop`'s package manager.
- One Stop-hook consolidation takes 11–16 s at 20k rows.

### Not covered

These are the harness v2 and follow-up work:
- **Sessions and processes.** Per-session stores and id collisions (A1 D1/D2) belong to the long-horizon harness v2,
  A5 §3.
- **Host signals other than the prompt, the `cwd` and one previous report.** There is no `open_files`,
  `ctx.log`/`q_path`, `q_turn` or transcript.
- **Tool events, the guard, policies and secrets.**
- **Paraphrase authorship.** One author wrote every paraphrase. A second author's set would test that they
  generalise.

### Tests

`bench.test.ts` runs in CI (well under a second). It checks:
- the world is deterministic, and the splits are disjoint;
- the full world has 20k distinct background rows;
- the lexical properties of paraphrases and named cues hold;
- the oracle scores hand-built packets correctly;
- a small slice runs through the product: the anchors pass (known pass), an unanswerable need fails (known fail),
  two runs give the same digest, and the environment and `Date.now` are restored.

It does not assert the product's score on the bench: the bench is a measurement, not a gate.
