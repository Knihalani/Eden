# R9 — Execution methodology: how to build, measure, roll out and land Eden memory

> **Code citations.** `file:line` references in this document point at commit `11c3101c3`, when it was written. Later commits, including R-5's reformat (#94, #97, #99), moved those lines. To read one: `git show 11c3101c3:<path>`.

**Dated 2026-09-29.** An input to `ROADMAP.md` (how the slices are executed, not what they build). It is evidence and recommendation, not a decision: `DECISIONS.md` keeps precedence. Inputs read: `ROADMAP.md`, `DECISIONS.md`, `A5-EVALUATION.md`, `A6-TRUST-AND-SAFETY.md` §4, `research/R0`, `R1` Addendum A, `R3` E7, `R6` §1.3 and §6; the repo's CI (`.github/workflows/test.yml`, `scripts/test.sh`), `src/memory-consent.ts`, both whatever harnesses (`.whatever/`, `.whatever-v1/`) and `git log` of the current branch.

**Verification marks** used in §2 and §4:
- **[V]** the primary source was fetched in this session and the quoted claim was read in it.
- **[S]** only a search-engine summary or a secondary write-up was read; the claim is probably right but was not read in the primary.
- **[U]** unverified: from memory or inference. Treat as a hypothesis.
- **[R]** measured in this repo during this session (the command is in §3).

---

## 0. Headline

1. **Stop the current whatever run before Phase 0 starts, and do not merge its branch wholesale.** [R] Its primary metric (`misses`) hit its floor of 0 on experiment 1 of 321. The other 290 "keep" commits were accepted on a net-line-delete simplicity rule. They shrank `src/index.ts` from 1,444 to 379 lines by **joining lines** (48 lines now exceed 200 characters; the longest is 1,001). That is Goodhart's law on the simplicity proxy. It also rewrites the exact functions ROADMAP P0.2–P0.6 must rewrite (`convBlob`, `extractDurable`, the hook). Cherry-pick only the keeps that moved a metric.
2. **Land every A5 arm red first, in its own commit, with the failure reason asserted.** An arm that fails for the wrong reason, or passes vacuously, is a broken fixture, not a red arm.
3. **Pre-register each slice's target in the PR branch before writing code**: the metric, the baseline, the delta, the harness hash and the tolerance table. A5's ship rule already assumes this. The harness hash makes it checkable.
4. **Keep four data tiers apart**: dev fixtures (tune freely), locked test fixtures (scored at PR time), a private real-negative holdout (aggregate numbers only; the implementing agent never reads its rows), and dogfood (finds regressions, never votes).
5. **Put error bars on every sampled metric, and size the sets to the gate.** 3 false injects in 80 negatives (R1's 4%) has a 95% Wilson interval of 1.3–10.5%. Even 15 in 300 gives 3.1–8.1%. Certifying FIR ≤ 5% needs about 460 negatives at an observed 3% (330 one-sided). A hard gate of 0 on 30 secret shapes only bounds the leak rate at about 10% (rule of three). R6's whole transcript corpus has **178** human prompts, and Claude Code deletes transcripts after 30 days by default. So the ≥ 300 real-negative set **cannot be built from today's transcripts**. It has to be collected, opt-in, starting now.
6. **Give each delivery point a three-state flag, `off | shadow | on`, read from a file on every event.** Environment variables are frozen when Claude Code starts; a file flip takes effect on the next hook process. `EDEN_MEMORY` stays the master switch. Unknown values fall to the safe state: `off` for new features. Today's `memoryConsent` maps an unknown value to `on`, and new flags must not copy that.
7. **Shadow mode computes the packet on the real path, logs ids, and emits nothing.** It keeps a **shadow ledger**, so refractory behaviour is simulated honestly. It is measured like ghost ads: when a restatement happens, was the item in a shadow packet in the preceding turns?
8. **Enable in order of rising blast radius.** Replay, then shadow everywhere, then Submit (P0.2 only removes packets), then SessionStart and SubagentStart, then PostToolBatch, then the guard as context only, and last the guard's `ask`, the only control-flow effect. Each step has entry criteria, a dwell time and rollback triggers.
9. **Use the optimization loop only on bounded parameters against a versioned, frozen harness** that includes every A5 hard gate as a guard. Hide a holdout from it. Stop it when the primary saturates. Keep it out of files that open slices touch. Run it in its own worktree.
10. **One slice, one branch, one PR, one worktree.** Stack only strictly dependent slices (at most 3 deep; GitHub stacked PRs have been in public preview since 2026-07-30). Agents never merge and never open a PR before the definition of done (§1.4) is met. Enforce this with Claude Code permission rules as well as by habit.
11. **Treat the real-negative set as a secrets problem first.** Drop any prompt with a secret-rule hit (dropping is safer than redacting), seed a canary secret to prove the pipeline removes it, keep the set outside git with a hash, and have the user review all of it. The pasted token found in the transcripts should be **revoked**, whatever Eden does.
12. **Migrate with expand, migrate, contract.** Take a backup, dry-run, give each migrated row a deterministic id (idempotent), stage the result and swap it in by same-filesystem `rename`, and keep the legacy tree read-only for 30 days. Rollback removes `src=legacy` rows by id prefix. Deleting the old tree is a separate, user-confirmed command.

---

## 1. Recommendations for this project

### 1.1 Eval-driven development (tie-in: A5 ship rule)

**R1.1 Red arms first, with the reason asserted.**
- P0.0 lands each A5 §4 arm as a test that is expected to fail. Keep a manifest (`benchmarks/memory-long-horizon/arms.json`) of `{arm, state: red|green, reason}`. `reason` is a string or predicate the failure must match. Examples: `cross-session` fails because the store is keyed by `session_id`; `nonhuman` fails because 20 task-notification submits produce packets.
- CI checks both directions:
  - a red arm must fail **for its reason**, so a harness bug cannot turn it green or red by accident;
  - a green arm must pass.
- A slice PR flips its arms from red to green in the same diff that changes the manifest, so review sees the flip.
- This is Anthropic's "build evals to define planned capabilities before agents can fulfill them" [V] and the Claude Code advice to "write a failing test that reproduces the issue, then fix it" [V]. Committing the failing tests as a checkpoint is in Anthropic's earlier best-practices post [S]. Checking the reason answers Anthropic's warning to verify that graders are not rejecting valid solutions and that "failures should seem fair" [V].

**R1.2 Pre-registration, one file per slice.**
- Write `docs/memory-ship/prereg/<slice>.md` (≤ 15 lines) **before** implementation, as the first commit on the slice branch. It holds:
  - the target metric, its baseline and the delta;
  - the fixtures and arms;
  - A5's tolerance table;
  - `harness_sha` (the git tree hash of `benchmarks/memory-long-horizon/` and the fixture dirs);
  - for sampled metrics, the analysis (Wilson CI, paired test).
- The PR description repeats it with the measured numbers. If the harness hash changes mid-slice, the prereg is amended in a visible commit that says why.
- This is the preregistration argument: separate prediction from postdiction [S: Nosek et al.]. It is also the only way A5's "pre-registered target moves by its stated delta" can be audited.

**R1.3 Four data tiers.**

| Tier | Contents | Who sees rows | Used for |
|---|---|---|---|
| Dev | R1 dev split; new scripted sessions; unit tables (R5 §9.3, slot phrasings) | everyone | tuning τ, lexicons, weights |
| Test (locked) | R1 test split (253 positives / 80 negatives); A5 arms; the long-horizon schedule seeds | everyone, but not tuned on | PR-time scoring, **once per slice** |
| Private holdout | the real-negative set (§1.5) + held-back real sessions | **user only**; agents get aggregate FIR and the ids of false fires | P4.3 gate; τ refit acceptance |
| Dogfood | live `hook.log`, `miss.jsonl`, weekly labels | user | finds regressions; every `harmful` label becomes a fixture |

- R1 already split dev and test with a union-find over co-gold ids and scored test once per method. Keep that discipline as the standard for every new fixture.
- Log each holdout look to `~/.eden/eval/holdout-access.log`. Refresh the holdout (new draws from dogfood) after about 20 looks or at each phase boundary, whichever comes first.
- Reusing a holdout adaptively leaks information and invalidates its estimates. The reusable-holdout work bounds this, but only by rationing and noising access [S: Dwork et al.].
- A fixture that is redrawn afresh can still score lower when the new draw is harder or shifted [S: Recht et al.]. So the holdout must come from **real** prompts, not from a regenerated synthetic set.

**R1.4 Goodhart controls.**
- **Every target has a paired counter-metric, and it is a guard in the same run.** A5 mostly does this. Make the pairing explicit in each prereg:

| Target | Counter-metric |
|---|---|
| recall (need_miss) | FIR, silence |
| `packet_rate` down | `need_miss_rate` |
| `redundant_rate` down | `need_miss_rate` (re-eligibility) |
| `guard_recall` | `guard_precision`, `guard_bypassed` |
| p99 down | gold recall |

- **Oracle independence.**
  - Oracle files (`oracle.jsonl`, annotated cues, the simulated window) live in a directory that `src/` must not import. Add a test that greps imports.
  - A slice PR that edits both implementation and fixtures or oracles must put the fixture edit in a separate commit titled `fixture:` with its reason. The reviewer reads that commit first.
  - This is the concrete form of "the agent shouldn't be able to easily cheat the eval" [V: Anthropic]. The documented failure modes are real: models editing tests or scorers, or reading the grader's answer [S: METR], and an evolutionary loop exploiting an evaluator memory bug, where the claimed speedups collapsed on re-evaluation [S: Sakana].
- **Qualitative veto.** A single hand-labelled `harmful` packet in dogfood blocks promotion of that delivery point until it is a fixture and green. OpenAI's sycophancy postmortem names exactly this failure: offline evals and A/B tests "looked good" while expert testers said the model "felt slightly off", and the metrics won. Their fix was to make behavioural issues launch-blocking [V via S. Willison's quotation of the OpenAI post; the OpenAI page returned 403].
- **Saturation.** When an arm is green on every slice, move it to "regression" status: it must stay at 100%, and it stops counting as progress. Anthropic distinguishes capability evals (start low) from regression evals (near 100%) and warns that saturated evals give no improvement signal [V]. The whatever run in §0 is what saturation looks like when nobody stops the loop.

**R1.5 Statistics by kind of metric.**

| Kind | Examples | Practice |
|---|---|---|
| **Deterministic** fixture assertions | most arms: `cross-session`, `numbered-list`, `repeat`, `negation` | Pass/fail, no CI. Run each arm **twice in fresh processes**. Any disagreement is a bug (hidden time, order or pid dependence), not noise. A5's "fixtures are deterministic" is then a checked property, not an assumption |
| **Concurrency** arms | `spawn-writers`, concurrent PostToolUse | Nondeterministic by design. Run ≥ 20 repetitions. Require 0 failures, and report the rule-of-three bound (0/20 → ≤ 15% per-run failure; 0/100 → ≤ 3%) |
| **Rates on a finite set** | FIR on real negatives; policy recall; `guard_precision` | Wilson 95% interval [U: Brown, Cai & DasGupta, standard]. Compare arms by **per-cue paired differences** (McNemar for binary outcomes), not by the difference of two rates. Use **clustered** standard errors when cues come in groups: several cues per memory, several prompts per session [V: Miller, recs. 2 and 4] |
| **Zero-event hard gates** | `secret_bytes = 0`, `poison_hits = 0`, `stale_rate = 0` | 0 of n bounds the true rate at about 3/n [S: Hanley & Lippman-Hand]. Grow `secrets` from 30 shapes to ≥ 300 cases (shapes × 4 channels × positions: start, middle, inside a paste, split across lines), so that "0" means ≤ 1% |
| **Latency** | `p99_hook_ms` | p99 needs ≥ ~1,000 samples per delivery point to be stable. Use the 1,000-turn soak. Report the median of 3 runs, and set the +10 ms tolerance **only after an A/A run** (baseline vs itself) shows the run-to-run spread is below it |
| **Dogfood trends** | `restate_rate`, `packet_rate` | Fixed-horizon monthly aggregation at n ≥ 80 (A5) is correct. If anyone makes decisions from the weekly report, use always-valid (sequential) intervals. Repeated peeking at fixed-horizon p-values inflates false positives [S: Johari et al.]. A5 already says dogfood does not vote, so the simplest fix is to keep it that way |

**Sizing** (Wilson, 95%) [R: computed]:
- 3/80 → [1.3%, 10.5%]; 15/300 → [3.1%, 8.1%]; 0/300 → [0, 1.3%].
- To show FIR < 5% at the upper bound:

| Observed FIR | Negatives needed, two-sided | One-sided |
|---|---|---|
| 2% | ~210 | ~150 |
| 3% | ~460 | ~330 |
| 4% | ~1,830 | — |

**Recommendation for the P4.3 gate:**
- Keep "FIR ≤ 5% on ≥ 300 real negatives" as a **point-estimate** gate and print the interval.
- Do not call it certified until the upper bound is ≤ 5%.
- Grow the set toward 500 through dogfood collection.
- Run Evan Miller's power analysis [V, rec. 5] before choosing the delta for any sampled metric. A pre-registered delta smaller than the measurement's noise cannot be detected.

**R1.6 A5 ship rule: three amendments.**
1. The tolerances (`false_rate` +0.5 pp, `redundant_rate` +1 pp, p99 +10 ms) apply to **deterministic** fixtures as written. For **sampled** metrics, a regression counts only if the paired test rejects at 95%, **or** the point estimate crosses the hard gate.
2. Before the first slice PR, run the harness **A/A** (baseline against baseline, fresh processes) and record the noise floor of each metric in `A5`. No tolerance may be tighter than its noise floor.
3. Anthropic's recommendations to read transcripts and have a second reviewer [V] become part of the definition of done (§1.4). The PR includes 5 hand-read packets from the replay, with the reviewer's one-line verdict on each.

### 1.2 Safe rollout of behaviour that changes the agent's context and control flow

**R2.1 Flags: one per delivery point, three states, read from a file on every event.**

| Flag | Delivery point / behaviour | States | Default while building | Default when published |
|---|---|---|---|---|
| `EDEN_MEMORY` (exists) | master switch | on / readonly / off | on | on |
| `deliver.submit` | UserPromptSubmit packet | off / shadow / on | shadow → on after P0.2 | on |
| `deliver.session_start` | ≤ 3 pins | off / shadow / on | shadow | off until stage 3 |
| `deliver.subagent` | SubagentStart packet | off / shadow / on | shadow | off until stage 3 |
| `deliver.batch` | PostToolBatch first-touch | off / shadow / on | shadow | off until stage 4 |
| `deliver.failure` | PostToolUseFailure gotchas | off / shadow / on | shadow | off until stage 4 |
| `guard.context` | PreToolUse `additionalContext` | off / shadow / on | shadow | off until stage 5 |
| `guard.ask` (= `EDEN_POLICY_GUARD`) | PreToolUse `permissionDecision: "ask"` | off / shadow / on | off → shadow | off until stage 6 |
| `log.text` | text-bearing dogfood log (§1.5) | off / on | off | off |

**Mechanics:**
- **Where the flags live.** In `~/.eden/flags.json`, with an optional per-repo override `<repo store>/flags.json`. Each hook process reads them afresh, because each event is a new process (R0).
  - Precedence: env var (`EDEN_DELIVER_SUBMIT=shadow`, …) > repo file > user file > compiled default.
  - Env vars suit tests and CI. They are **not** a runtime kill switch: a hook inherits the environment Claude Code started with, so changing the env means restarting the session [U: inferred from process inheritance; confirm with a live check].
  - The file is the runtime switch, and a flip applies to the next event.
  - For the plugin, Claude Code exposes plugin options to hooks as `$CLAUDE_PLUGIN_OPTION_<KEY>` [V: hooks.md, saved copy in `research/sources/`]. That is a second, user-facing way to set flags.
- **Parsing.**
  - An unparsable file or unknown value resolves to `off`, and to `shadow` only for `deliver.submit`.
  - This reverses today's `memoryConsent`, which maps unknown values to `on` [R: `src/memory-consent.ts:14`]. Fail-open for the **agent** means "never block or break the turn". It does not mean "turn the feature on".
- **Testing both states.** A CI matrix runs every delivery arm with its flag `off` and asserts **identity**: no stdout, exit 0, no ledger write. Fowler/Hodgson: test "with the toggle flipped On and flipped Off", including "the fall-back configuration" [V].
- **Flags as inventory.**
  - Each flag gets a removal date in `flags.json`'s schema doc.
  - A test fails once a release flag outlives it: Hodgson's "time bomb" [V].
  - `guard.ask` and the master switch are long-lived ops toggles (kill switches) and are exempt.
- **Precedent.** Facebook's Gatekeeper ships code "in a disabled mode" and then enables it incrementally (1% → 10% → 100% of employees first), and "the new code can be disabled instantaneously" [V: Tang et al., via the Morning Paper summary; the PDF URL is in §4]. Eden's single-user version is: the code merges dark, the flag moves off → shadow → on per delivery point, and the file flip is the instant disable.

**R2.2 Shadow mode: definition.**

The pipeline runs to its last step on real events. There, one `emit(point, packet, mode)` function decides what happens:
- `on`: return `additionalContext` and append to `delivery.log`.
- `shadow`: return **nothing** (exit 0, empty stdout). Append the would-be delivery to **`delivery.shadow.log`**, a shadow ledger with the same format, folded the same way. Write one wide event to `hook.log`: flag states, point, `win`, `hturn`, the cids and `ver`s that would have been sent, stage drops, top score and τ, bytes, and elapsed ms.
- `off`: return nothing, and compute nothing past the flag check.

Rules:
- **The shadow ledger is required.** Without it, shadow mode would "deliver" the same item every turn (nothing was really delivered, so nothing is refractory). Its packet rate would be wildly pessimistic. With it, shadow numbers estimate what `on` would do.
- The real ledger is **never** written in shadow mode. When a point flips to `on`, the shadow ledger is discarded so that items are eligible once.
- Shadow runs **inside the real latency budget** (150 ms at Submit). Its p99 and `abort_rate` are production measurements of the real code on this machine, which is half of what the canary is for.
- **Scientist pattern for replacements.** When a new path replaces an old one (P0.2's new Submit packet against the installed hook's packet), run both in the same process, return the old, and log `match | mismatch` with both cid lists. GitHub's Scientist runs the control and the candidate, compares results, and records timing and the candidate's exceptions, while only the control's result is used [S: GitHub's library README and Engineering blog summary]. Stripe used Scientist to validate read paths during its online migrations [V].

**R2.3 Measuring in shadow mode: counterfactual logging.**

The ad-measurement literature has the right pattern. **Ghost ads** log, in the control group, the ad that *would* have been shown, so exposed users in treatment can be compared with would-have-been-exposed users in control [S: Johnson, Lewis & Nubbemeyer]. Bottou et al. show that logged counterfactual information lets you estimate what a change would have done without deploying it [S: JMLR 2013].

In Eden, a shadow packet is the ghost ad, and these are the measurements:

| Shadow measure | Definition | Why |
|---|---|---|
| `would_preempt` | for each dogfood `restate` or `policy_recur` event (D30), did a shadow packet in this window within the last 3 human turns contain the restated cid? | The only direct estimate of G1 before turning a point on. A high rate is the case for promotion |
| shadow `packet_rate`, bullets per packet | from `delivery.shadow.log` over human prompts | A5 packet gate (≤ 25%) under real traffic |
| shadow `redundant_rate` | shadow bullets whose content is already in the real transcript window (the hook has `transcript_path`) | the ledger/residual/shadow-set check, on real sessions rather than the harness |
| `would_ask` | guard `ask`s that would have fired, with the command and the class | hand-label 100% of them during stage 5; `guard_precision` ≥ 0.9 before stage 6 |
| `would_ask` → outcome | after a `would_ask` on `gh pr merge` or `git push`, did the user interrupt, revert or complain within the turn? | real guard recall evidence |
| p99, `abort_rate`, errors | per point, from wide events | fail-open budget (R2.5) |

- **Caveat: no randomization.** Shadow mode compares what happened (nothing injected) with what would have been injected. It does not measure the effect of injection on the agent's behaviour; only `on` does.
- An on/off A/B **within one user** is possible: alternate by session, with the session id's hash deciding. At one user and about 40 sessions a month (R6), though, it has almost no power. Treat post-launch dogfood as a before/after comparison, and read it with the time-variance caveat in the SRE workbook: "time represents a major source of metric variance" in before/after canaries [V].

**R2.4 Staged enablement by delivery point** (the canary is the developer's own sessions).

| Stage | Turn on | Why this order | Entry | Dwell | Roll back on |
|---|---|---|---|---|---|
| 0 | harness replay of R6 sessions + A5 arms | no user exposure | the slice's arms green | — | — |
| 1 | **shadow on every point**, Eden repo only | measures real latency and aborts, and shadow metrics | Phase 0 floor arms green | ≥ 7 days **and** ≥ 50 human prompts | any hook error visible to the user; p99 over budget |
| 2 | `deliver.submit=on` (P0.2 + P1.x) | P0.2 **removes** packets (54% → ≤ 30% of prompts); the lowest-risk change; fixes the largest measured harm | shadow `packet_rate` ≤ 30%, shadow `redundant_rate` < 5% | 7 days | any `harmful` label; `secret_bytes`/`poison_hits` > 0 |
| 3 | `session_start`, `subagent` | no control flow, but about 89% of windows are subagents: high blast radius | stage 2 clean; the subagent arm green; ≥ 20 labelled shadow subagent packets with 0 harmful | 7 days | as above |
| 4 | `batch`, `failure` | mid-turn injection can distract a working agent; STRONG only, ≤ 2 bullets | ≥ 20 labelled shadow batch packets, 0 harmful | 7 days | as above; an agent visibly derailed by a packet (label `distracting`) |
| 5 | `guard.context` | text arrives next to the tool result, after the call (R0 F25); no control flow | `would_ask` precision ≥ 0.9 on ≥ 20 labelled events | 7 days | a false context on an irreversible command |
| 6 | `guard.ask`, **irreversible classes only** at first (integrate, push-upstream, deploy, delete, destructive-db, history-rewrite) | the only control-flow effect (D19) | stage 5 clean; `guard-modes` arm green on the installed Claude Code version (≥ v2.1.211 for auto mode) | 14 days | any false `ask` the user labels wrong; any deny caused by Eden |
| 7 | other repos (flag file per repo) | new repo shapes | stages 2–6 clean in the Eden repo | — | per-repo flag off |

- The dwell sizes follow R6's rate of about 4.5 human prompts per session and roughly 40 sessions in the retained window. 7 days is about the least that yields ~50 human prompts on one repo. The numbers are for a single user and are **[U]** until the first week of stage 1 shows the real rate.
- This order mirrors the SRE workbook's canary advice:
  - a "partial and time-limited deployment of a change … and its evaluation";
  - few metrics, "perhaps no more than a dozen";
  - metrics that are "attributable" to the change;
  - smaller artifacts that are cheaper to roll back [V].
- A5's per-point p99 budgets and hard gates are the canary metrics. Nothing else is needed.
- **One point per stage, never two at once.** Attributability [V] is impossible if Submit and SubagentStart change together.

**R2.5 Kill switches and the fail-open budget.**

Kill switches, from narrowest to broadest:
1. A per-point flag to `off` in `flags.json`: next event.
2. `EDEN_MEMORY=off`: needs a new session.
3. Claude Code's `disableAllHooks` or disabling the plugin. Managed hooks cannot be disabled from outside managed settings [V: hooks.md, saved copy].

`eden doctor` prints all three with their current state.

Fail-open contract:
- **Always exit 0.** Claude Code treats exit code 2 on UserPromptSubmit as blocking, and it **erases the prompt**. Other non-zero codes are "non-blocking errors" whose stderr is **shown to the user** [V: hooks docs]. Every hook entry point therefore wraps everything, logs the exception to `hook.log`, prints nothing and exits 0.
- A test spawns each entry with a thrown error injected and asserts exit 0 with empty stdout and stderr.
- Claude Code discards a UserPromptSubmit hook's output after its 30 s timeout [V]. Eden's internal 150 ms budget (A5) sits well inside that. Aborts count as misses.

Budget:
- `abort_rate` ≤ 0.5% (A5).
- User-visible errors: **0**.
- Unhandled exceptions: ≤ 0.1% of invocations per point, per day.

Circuit breaker:
- If a point exceeds its budget over its last 200 invocations, the hook writes `~/.eden/flags.auto.json` and forces that point to `shadow` for 24 h. `eden doctor` and SessionStart's `Updated:` line then say so once.
- This is Gatekeeper's instant disable, automated for one user. Humans (the user) re-enable.

**R2.6 Observability.**
- **One wide event per hook invocation**, with a small fixed schema and high-cardinality fields: `point`, `mode`, all flag states, `repo`, `win`, `hturn`, `prompt_id`, human or non-human, turn mode (`ack`, `continuation`, …), cids, stage drops, `ms`, `aborted`, `err`.
- Honeycomb's practice is to put the flag values on every event and watch the flagged cohort during progressive delivery (they ran a change at 20% of datasets, then 90%) [V].
- Their same post is also a warning. An apparent regression by flag state came from a hidden correlated factor (write size), which is Simpson's paradox [V].
- For Eden, always slice by **delivery point and submit kind** before comparing. Non-human submits were 63% of all submits (R6), so pooled rates mislead.

**R2.7 What LLM product teams report.**
- **Anthropic** (September 2025 postmortem):
  - Evals missed real degradations, "in part because Claude often recovers well from isolated mistakes".
  - Canary groups were insufficient.
  - Privacy controls limited debugging.
  - The fixes were continuous evals on production systems, more discriminating evals, and privacy-preserving debugging tools [V].
  - For Eden: run the A5 arms **nightly against the installed plugin build** (not only the repo). Make `hook.log` rich enough in ids and stage drops that a bad packet can be debugged **without** reading prompt text.
- **OpenAI** (GPT-4o sycophancy): behavioural issues became launch-blocking, and an opt-in alpha phase was added [V via quotation; S for the alpha phase]. This maps to R1.4's `harmful` veto, and to stage 1 being opt-in shadow.
- **GitHub Copilot** [V]:
  - more than 4,000 offline tests, mostly in CI;
  - about 100 containerized repos that pass their CI, deliberately broken for evaluation;
  - "live internal evaluations, similar to canary testing" on employees;
  - tests run against production models every day.
  - Copilot's research found that the **acceptance rate** of shown suggestions, rather than more specific persistence metrics, drives developers' perception of productivity [V: Ziegler et al. abstract]. A secondary report says optimizing acceptance alone produced many tiny completions [S]. Eden's analogue is that `packet_rate` or recall alone rewards chatty packets. Keep the counter-metrics.

### 1.3 Working with autonomous optimization loops ("whatever", AlphaEvolve-style, AutoML)

**What the current loop is doing** [R, §3]:
- The active harness is `.whatever/harness.json` (not `.whatever-v1`, whose epsilon is 1%).
  - Branch: `whatever/sep28-scale`. Epsilon: 0.02.
  - Scope: `src`, `packages/cli/src/memory-hook.ts`, `packages/wrap/src`.
  - Primary: `misses` from `.whatever/benches/scale.ts`.
  - Guards: `inject-ms`, `jsonl-bytes`, `tests`.
- `results.tsv` holds 321 experiments: 1 baseline, 291 keep, 30 discard.
  - Experiment 1 took `misses` from 1 to 0, its floor.
  - Every row after that has `misses = 0`.
  - `state.json` reads: "Primary 0 — KEEP via --simpler net-delete only."
- Since the run's baseline commit `8a6b4705f` (2026-09-28 22:05), `src/index.ts` changed as follows:

| | Baseline `8a6b4705f` | HEAD |
|---|---|---|
| Lines | 1,444 | 379 |
| Bytes | 61,171 | 35,155 |
| Commits touching the file | — | 238 |
| Lines over 200 characters | — | 48 (7 on `main`) |
| Longest line | — | 1,001 characters |

- Typical "pack" diff (commit `3357ce433`): a six-line `else if … for …` block becomes one line. The logic is the same; the line count drops by 5.
- The branch is 1,251 commits ahead of `main` (merge base 2026-09-06). The **main checkout** at `~/Downloads/Eden` is on this branch.

**Reading:**
- This is Goodhart's law, and specifically what Manheim & Garrabrant call regressional/extremal Goodhart [S]. "Lines deleted" was a proxy for "simpler". Once the real target (misses) was saturated, all the optimization pressure went into the proxy, and the proxy came apart from the goal: the code got **harder** to read.
- Karpathy's autoresearch states the same simplicity criterion but leaves it as the agent's judgement: "All else being equal, simpler is better. A small improvement that adds ugly complexity is not worth it" [V]. "whatever" made it a mechanical line count, and the loop found the cheapest way to satisfy it.
- It also **fights the roadmap**. P0.2–P0.6 rewrite `convBlob`, `extractDurable` and the hook's encode path in exactly this file. Each pack commit is a future merge conflict and a harder review.

**R3.1 Now:**
1. Stop the `sep28-scale` run and move the main checkout back to `main` or to a slice branch.
2. Do **not** merge `whatever/sep28-scale`. From its `results.tsv`, cherry-pick onto a normal branch the keeps whose **primary or guard value changed**. Row 1 is one ("skip WH-question inject store; misses 1→0"). Keeps like row 2 ("delete constructor warmup lookups") are also worth a look, because deleting code is a real simplification. Review them as a normal PR.
3. Drop the pure pack commits. If some packing is wanted, a formatter decides line shape, not the loop. The repo has no formatter config today [R]; adding one (and a max line length) is a separate hygiene PR.

**R3.2 When to use a keep/discard loop.**
- Use it when all four hold:
  - the change is a **bounded parameter** or local code-path tweak;
  - the harness is **fixed and trusted**;
  - the metric is **not saturated**;
  - every hard gate is a guard.
- AlphaEvolve's own paper states the precondition: it "handles problems for which it is possible to devise an automated evaluator" [V]. Its evaluation cascade (cheap tests first, full evaluation only for promising candidates) is a good pattern for Eden's arms: deterministic arms, then the 2k bench, then the long-horizon soak [V].
- Good Eden targets once harness v2 exists:
  - BM25F field weights and `k1`/`b` (D17);
  - the 0.7·top keep ratio;
  - cue part mass limits (D16);
  - `τ_repo` fitting procedure constants;
  - refractory distances (400 KB / 1.2 MB, D25), once dogfood gives `message.usage` data;
  - packet soft limit;
  - p99 micro-optimizations under a behaviour-equivalence guard (identical packets on the replay).

**R3.3 When not to.**
Never run the loop on:
- **Schema or storage format** changes (ids, `seq`, store layout, migration).
- **Delivery-point semantics** (what fires, where).
- **Trust gate** (authority, secrets).
- **Scope rules** (D3).
- Anything that needs a human **judgement label**: helpful or harmful, wording.
- Anything whose metric has already hit its floor.

These are design decisions under DECISIONS.md. A loop that optimizes one number cannot weigh them, and a mistake in them is costly to undo (a migration, a user-visible behaviour change).

**R3.4 Controls, when the loop does run.**
1. **Freeze windows.**
   - While a roadmap slice is open, the loop's `scope` excludes every file the open slices touch.
   - Simplest rule: the loop may run only on a branch cut from `main` **after** the relevant phase merged, with `scope` limited to the parameter module, e.g. a new `src/memory-params.ts` holding the constants listed in R3.2.
   - Moving tunables into one module is itself a small Phase 4 enabling PR.
2. **Harness versioning.**
   - `harness.sha256` already exists [R]. Record it in **every** `results.tsv` row.
   - A harness change ends the run; a new run starts with a new baseline. Numbers are never compared across harness versions.
   - The agent may not edit the harness or benches: autoresearch's `prepare.py` is read-only and "the ground truth metric" [V]. Check the hash every iteration and abort on mismatch.
3. **Epsilon from noise.**
   - Before a run, execute the baseline 5 times. Set epsilon ≥ 2× the observed spread of the primary.
   - A fixed 1% or 2% on a small count metric (misses out of a few dozen cues) is either unreachable or pure noise.
4. **Saturation stop.** When the primary reaches its floor or ceiling, **the run ends**. There is no "simplicity-only" phase.
   - If simplicity is ever a target, measure it after formatting, as AST node count or gzip size of the formatted file.
   - Lines is not a valid measure.
5. **Guards = A5 hard gates + readability.**
   - The guard list includes every hard gate: `secret_bytes`, `poison_hits`, `stale_rate`, non-human silence.
   - Add a formatter check (max line length) and "no new `any`" as guards.
6. **A holdout the loop never sees.**
   - `.whatever-v1/benches/brain-holdout.ts` exists [R]. Keep that pattern: score the holdout **only at the end of a run**, once, and report the gap between tuned and holdout.
   - A large gap means the run overfit; discard it wholesale.
   - Cawley & Talbot show that selection against a finite validation criterion over-fits the criterion and biases the reported performance [S]. Many experiments against one bench is exactly that.
7. **Reward-hacking review.**
   - Models under optimization pressure modify tests or scorers, or read the answer from the grader [S: METR; S: Sakana CUDA Engineer].
   - Any keep that touches a file the bench imports, or that special-cases a bench string, is discarded on sight.
   - DeepMind's "specification gaming" catalogue is the reference list of such behaviours [S].
8. **Output is a candidate, not a merge.**
   - A finished run is squashed into ≤ 5 commits by kind (parameter changes; deletions; each behavioural change on its own) with the results table.
   - It goes through the same PR gate and definition of done as any slice (§1.4). The user merges.
9. **Isolation.** Run the loop in its own worktree under `.claude/worktrees/whatever-<run>`, never in the checkout that humans or slice agents use.

### 1.4 Branch and PR discipline for a multi-slice program built partly by AI agents

The user's norms from R6 §6. The git/PR norms alone were mentioned 28 times in 11 sessions; "verify thoroughly" 13 times in 6 sessions across 4 projects:
- work on a branch;
- don't merge the PR yourself;
- don't open the PR until it's ready;
- verify thoroughly, end to end;
- research deeply, with primary sources.

These are **constraints**, not preferences.

**R4.1 Unit of work: one slice, one branch, one PR, one worktree.**
- Branch name `mem/<slice>-<slug>` (e.g. `mem/P0.2-stop-bleeding`), cut from `main`.
- A slice is Google's "one self-contained change". Small changes are reviewed faster and more thoroughly, are less likely to introduce bugs, and waste less work if the direction is rejected [S: Google eng-practices].
- The ROADMAP sizes (S ≤ 1 day, M ≤ 3 days) fit this. An **L** (P0.0 harness, P6.1 SQLite) should be split into 2–4 PRs:
  - P0.0: (a) event and transcript simulator; (b) oracles and simulated window; (c) the arms, red; (d) the real-negative loader.

**R4.2 Stacked PRs vs trunk-with-flags.**
- DORA's evidence favours trunk-based development: ≤ 3 active branches and merging to trunk at least daily [S].
- The user's rule that agents never merge means that trunk speed is set by the user's review time. The workable blend:
  - **Merge dark.** Every new delivery point defaults to `off` or `shadow` (§1.2). A slice can merge once its arms are green, before its stage is enabled. That keeps branches short without exposing behaviour.
  - **Stack only true dependencies.** P0.3 (ids, `seq`) → P0.5 (repo store) → P1.1 (ledger) are dependent. P0.1 (packaging) and P0.4 (trust gate) are not.
    - Stack depth ≤ 3.
    - GitHub stacked PRs (public preview since 2026-07-30) show per-layer diffs and let layers merge one at a time or together [S: changelog].
    - Meta's Phabricator "stacked diffs" is the origin of this workflow [S].
  - **Rebase, don't merge `main` into slices.** Linear history keeps the red → green commit pair readable.
- Parallel lanes after P0.0 lands (P0.0 gates everything):

| Lane | Slices |
|---|---|
| A | P0.1 → P0.2 |
| B | P0.3 → P0.5 → P0.6 |
| C | P0.4 |
| D | P0.7 |

  - Phase 1 waits for B.
  - Phase 2 can start P2.1/P2.2 (extractor, lexicon: pure functions) in parallel with Phase 1.
  - With ≤ 3 active branches per DORA, run at most 3 lanes at once.

**R4.3 Worktrees for parallel agents.**
- One agent, one worktree: `claude --worktree <slice>` or `.claude/worktrees/<slice>` [S: Claude Code docs, "Run parallel sessions with worktrees"].
- Never run two agents, or an agent and the whatever loop, in one checkout.
- Housekeeping [R]: `git worktree list` shows 10 worktrees, 8 of them `prunable` (in `/private/tmp`). Run `git worktree prune`. Name worktrees after their slice.
- Per-worktree state:
  - Eden's own store is keyed by `git-common-dir` (D1), so dogfood memory is shared across worktrees by design.
  - Test runs must set `EDEN_MEMORY_DIR` / `EDEN_HOME` to a temp dir, as the existing tests do [R: `src/memory-*.test.ts`]. Parallel agents must not write the user's live store.

**R4.4 Human gates** (and nothing else needs the human):

| Gate | What the user does | Cost |
|---|---|---|
| G-prereg | reads the ≤ 15-line prereg (R1.2) and says go | 2 min |
| G-PR | reviews and merges the PR | per slice |
| G-stage | flips a delivery point's flag to the next stage (R2.4), given the shadow evidence | per stage |
| G-holdout | looks at false fires on the private set (agents only see aggregates) | per P4.3 / τ change |
| G-migrate | runs `eden memory migrate --apply` and later `--contract` (§1.6) | twice |

Enforce the norms mechanically, not only by memory. In `.claude/settings.json` (project), add permission rules:
- `deny` for `Bash(gh pr merge*)` and `Bash(git push* main*)`;
- `ask` for `Bash(gh pr create*)`, so "PR only when ready" is a prompt, not a hope;
- `deny` for `Bash(git push --force*)` on shared branches.

On GitHub, protect `main`: require a PR, and require the `test` workflow's status check [S: GitHub docs, protected branches]. This is also the best dogfood for P2.3: the guard should reproduce these rules from the user's own restatements.

**R4.5 Definition of done** (per slice; the PR is opened only when every box is ticked):
1. **Prereg** committed first (R1.2). The harness hash is unchanged, or the amendment is explained.
2. **Red → green**: the red arm commit(s) precede the implementation in history, and the manifest flip is in the PR.
3. **Local CI green**: `bun run typecheck`, `bun run test` (`scripts/test.sh`), `bash scripts/build-cli.sh` [R: the CI workflow's three steps].
4. **A5 table** in the PR description:
   - target before and after, with CI where sampled;
   - every guard metric with its delta against the tolerance;
   - the locked 2k whatever bench still at 0 misses (ROADMAP Phase 0 exit).
5. **Both flag states** tested (identity when `off`).
6. **End to end**: build the plugin, install it into a real Claude Code session on this machine, run the slice's scenario by hand, and attach the `hook.log` wide events (ids only) and a transcript excerpt of the packet or ask.
   - This is Claude Code's "give Claude a way to verify its work" and "show evidence rather than asserting success" [V].
   - The CLI bundle build alone does not prove the hook runs under Claude Code.
7. **Fresh-context review**: `/code-review` or a reviewer subagent that sees only the diff and the prereg [V: "Add an adversarial review step"], and `/security-review` for P0.4, P0.5, P2.3 and any migration. Findings that affect correctness are fixed; style findings are optional (the same doc warns that chasing every finding leads to over-engineering [V]).
8. **Five hand-read packets** from the replay (R1.6 #3).
9. **Docs**: DECISIONS or A4 updated if behaviour differs from them. ROADMAP's slice row gets the PR link.
10. Only then: `gh pr create`, which triggers the `ask` from R4.4. **The user merges.**

### 1.5 Data governance for dogfood logging and the real-negative set

**Facts that shape this:**
- R6's corpus is 40 main transcripts and **178 human prompts** in total, of which 32 are in the Eden repo [R6 §1.3]. Two prompts contained pasted credentials [R6 header]. One is a `cfat_…` token that today's extractor would have stored as a `src=user` object [R3 E7].
- Claude Code deletes session files after `cleanupPeriodDays`, **30 days by default** [V: hooks.md and sub-agents.md, saved copies in `research/sources/`]. The raw material for real negatives disappears unless it is collected.
- Consequence: A5's "≥ 300 real-negative prompts" **cannot** be met from existing transcripts: 178 prompts minus positives, pastes and secret hits. It needs opt-in collection going forward, plus R1's hard negatives in the meantime. Expect about 4–8 weeks of normal use to reach 300 [U: based on R6's rate].

**R5.1 Logging tiers:**

| Log | Contents | Default | Retention | Location |
|---|---|---|---|---|
| `hook.log` (wide events) | ids, cids, counts, stage drops, scores, ms, flag states, **hashes** of prompt text; **no text** | on | 90 days, then only daily aggregates | `~/.eden/…/hook.log.d/`, mode 0600, dir 0700 |
| `delivery.shadow.log` | cid, ver, win, offset | on in shadow | until the point flips to `on` | repo store |
| `dogfood/prompts.jsonl` | **human** prompt text after `sanitizeForStore`, pastes stripped | **opt-in** (`log.text=on`) | **30 days** (matches Claude Code's own default) | `~/.eden/dogfood/`, 0600 |
| `eval/real-negatives.vN.jsonl` | curated, reviewed, secret-free negatives (R5.3) | produced by an explicit command | until superseded; versioned by sha256 | `~/.eden/eval/`, **never in git** |
| `miss.jsonl` | restate/confirm events with cids; text only if `log.text=on` | on | 90 days | repo store |

Principles, with their sources:
- Minimize what is logged; don't keep it longer than needed (GDPR Art. 5(1)(c), (e): "limited to what is necessary", "no longer than is necessary") [S: summaries of the Article text; EUR-Lex link in §4]. This is a single-user local tool, so GDPR is a design reference, not a compliance claim.
- OWASP lists "access tokens", "authentication passwords", "database connection strings", "encryption keys and other primary secrets" and "session identification values" as data not to record in logs directly; they should be "removed, masked, sanitized, hashed, or encrypted". Logs should be access-restricted, with retention both minimum and maximum [V].
- Everything is **local**. No log is sent over the network, and none is written inside a repo. A test asserts that no Eden writer resolves a path under any `git rev-parse --show-toplevel`. `.gitignore` already has `.eden-local/`, which is a backstop, not the control.
- `sanitizeForStore` (A6's one gate) runs **before** any write to any tier, including `hook.log` fields that could carry text (error messages carry paths and sometimes command lines).

**R5.2 The token that was found.**
- **Revoke or rotate it now**, independent of Eden. GitHub's remediation guidance puts revocation first. Rewriting history is secondary, because rotation removes the credential's power while scrubbing only removes copies [S: GitHub Docs, "Remediating a leaked secret"].
- The copies still in `~/.claude/projects/*.jsonl` expire with the 30-day sweep. D13's `purge` rightly **lists** but never edits Claude's transcripts; the user decides.
- Add the token's prefix family (`cfat_`) to the vendored rule set and to the `secrets` arm, as R3 E12 noted it is missing.

**R5.3 Building the real-negative set without leaking secrets.** The command `eden eval build-negatives`, run by the user:
1. **Select** human prompts only (R6 §1.2 definition: not meta, not compact summary, not task-notification or peer, not a local-command echo), from `dogfood/prompts.jsonl` and, once, from the current `~/.claude/projects` transcripts.
2. **Strip** `<pasted_content>` spans, fenced code, `>` quotes and runs of ≥ 3 lines without punctuation. These are D12's rules, so negatives look like what the cue actually sees.
3. **Drop, don't redact**, any prompt with a hit from:
   - the gitleaks rules;
   - the D13 keyword rule;
   - A6's entropy-plus-keyword rule;
   - a URL with credentials (`://user:pass@`);
   - a JWT shape;
   - an email address.
   A redacted prompt is a distorted negative and can still carry a partial secret. There are enough prompts to afford dropping.
4. **Normalize** identifying paths: `/Users/<name>/` → `/Users/USER/`, hostnames to `HOST`. Keep repo-relative paths, because they are cue signal.
5. **Canary test.** Before each build, inject 5 synthetic secrets of different shapes (including a `cfat_`-style one and a password in prose) into a copy of the input. The build must drop all 5. If any survives, the build aborts. This is the `secrets` arm applied to the pipeline itself.
6. **Label.**
   - The user marks each candidate `negative` (no memory should appear), `positive` (it did need one: move it to annotated cues) or `drop` (ambiguous).
   - A logged prompt is not automatically a negative. The whole reason for memory is that some prompts need it.
   - At 300–500 prompts this is a 30–60 minute pass. It is also the privacy review.
7. **Freeze.** Write `real-negatives.vN.jsonl` plus `.sha256`. The harness reads it from `EDEN_EVAL_NEGATIVES=<path>`.
   - CI has no such file: the arm prints `skipped: private set absent` and passes. The P4.3 gate is therefore **local**, and the PR must include its output (§1.4 DoD #4).
8. **Access.** Implementing agents get only the aggregate FIR with its CI and the **ids** of false fires. The user inspects the text. This keeps the set a holdout (§1.1) and keeps text out of agent transcripts, which are themselves logged.

### 1.6 Migrating on-disk user data (per-session stores → per-repo)

**Facts:**
- The source today is `~/.eden/memory/` (940 KB on this machine; A6 §4 found no provider-shaped tokens) [R: the directory holds `memories.jsonl`, `semantic.jsonl`, `traces.jsonl` and per-session dirs such as `m33/`, `s-m74-*`].
- A6 §4 fixes the policy:
  - it runs after P0.4;
  - each session is mapped to a repo via the first line of its Claude transcript;
  - rows pass `sanitizeForStore`;
  - they arrive as `src=legacy` episodes only;
  - unmappable sessions are not migrated.
- Mapping via the transcript has a deadline: the 30-day sweep deletes transcripts. Sessions older than that are unmappable. **Record the mapping now**: write a `session → cwd` snapshot to `~/.eden/migrate/session-map.json` in P0.1's `eden doctor`, even though the migration itself ships in P0.5.

**R6.1 The procedure: expand, migrate, contract.**
Fowler's parallel change: "expand, migrate, and contract", with the old form supported until clients have moved [V]. Stripe's online migrations follow the same shape: dual-write, move reads, move writes, remove old data, with a comparison tool at each step [V].

1. **Expand** (P0.5 code): readers know both layouts. New writes go to per-repo stores. Old stores are only read by the migrator.
2. **`eden memory migrate --dry-run`** (the default) prints, and writes nothing:
   - session → repo mapping;
   - rows in / out per session;
   - sanitizer drops (counts, no text);
   - unmappable sessions;
   - target sizes.
3. **`--apply`**:
   1. **Backup**: `tar` the whole `~/.eden/memory/` to `~/.eden/backups/memory-<ts>.tar.gz` with a `.sha256`, mode 0600.
      - The backup holds **unsanitized** rows, so it gets a TTL (30 days) and is inside `purge`'s scope.
      - `purge` either rewrites it or deletes it, and says which.
   2. **Lock**: take the per-repo `flock` used by `seq` (P0.3). Hooks that cannot take it within their budget fail open: the write goes to `pending.jsonl` (P0.3), and no event is lost.
   3. **Stage**: write the new rows to `<repo store>/.migrate-staging/` on the **same filesystem**.
   4. **Swap**: publish by `rename(2)`. POSIX guarantees that the target name "shall remain visible … and refer either to the file referred to by *new* or *old*". Across filesystems it fails with `EXDEV` [V: POSIX `rename`]. That is why staging must sit next to the target.
   5. **Idempotency**: each migrated row gets a deterministic id, `legacy:` + hash(source path, byte offset, row content). Re-running skips existing ids. `~/.eden/migrate/ledger.json` records `{version, started, finished, source_sha, rows_in, rows_out}`. A second `--apply` with the same `source_sha` does nothing and says so.
   6. **Mark** the old tree read-only and rename it to `memory.legacy-v1/`. It is not deleted.
4. **Verify** (automatically, after apply):
   - `rows_out = rows_in − sanitizer drops − unmappable − duplicates`;
   - a Scientist-style read comparison: for 50 sampled cues, retrieval from old stores (restricted to that repo's sessions) against the new store. The new result must be a superset, less sanitizer drops.
   - A mismatch rolls back automatically.
5. **`--rollback`**:
   - deletes every row with the `legacy:` id prefix from repo stores;
   - renames `memory.legacy-v1/` back;
   - clears the migrate ledger.
   - It **never** touches rows written after the migration. The prefix makes that separation exact.
6. **Contract** (`--contract`, user-confirmed, ≥ 30 days later, G-migrate): delete `memory.legacy-v1/` and the backup.

**R6.2 Format versioning.**
- Each store gets `format.json` (`{ "format": 2, "writer": "<eden version>" }`).
- A reader that sees an unknown **major** format does not read or inject from that store (fail-open: no packet). It logs once and `eden doctor` reports it.
- Downgrading Eden then cannot misparse a newer store [U: general practice; not cited].

**R6.3 The `migrate` arm** (add to A5 §4). Fixture trees of old stores containing:
- a normal session;
- two sessions from two worktrees of one repo, which must land in **one** store (D1);
- a session with no transcript (unmappable);
- a corrupt last line;
- a row holding each of 5 secret shapes;
- a 2 KB pasted log.

Assertions:
- a second `--apply` is a byte-for-byte no-op;
- `--rollback` restores the original tree byte-for-byte (compare `tar` listings and hashes);
- a **crash injection** (kill the process between each numbered step) always leaves either the old state or the new state, never a mix, and the next `--apply` completes;
- `secret_bytes = 0` in the new stores;
- legacy rows never become slot facts, policies or pins (A6).

---

## 2. Evidence

Each row is a claim used above, where it comes from, and how well it was checked. Reference numbers point to §4.

### 2.1 Eval-driven development and statistics

| Claim | Source | Mark |
|---|---|---|
| Build evals for planned capabilities before the agent can do them; start with 20–50 tasks from real failures; capability vs regression evals; saturation hides progress; read transcripts; test "where a behavior should occur and where it shouldn't"; make graders resistant to cheating (example: agents using git history from previous trials); combine automated evals, production monitoring, A/B and human review ("Swiss cheese") | Anthropic, *Demystifying evals for AI agents* (2026-01) [1] | V |
| Evals are experiments. Five recommendations: CLT standard errors; clustered SEs for grouped questions; reduce variance by resampling; inference on **question-level paired differences** when comparing models; power analysis | Miller, *Adding Error Bars to Evals* (arXiv 2411.00640) [2] | V (PDF text read) |
| 0 events in n bounds the rate at ≈ 3/n (95%); accurate for n > 30 | Hanley & Lippman-Hand, JAMA 1983 [3] | S (citation and rule confirmed; paper not read) |
| Wilson interval preferred over Wald for small-n proportions | Brown, Cai & DasGupta, *Statistical Science* 2001 [4] | U (standard reference, not fetched) |
| Continuous monitoring of fixed-horizon p-values inflates error; always-valid p-values/CIs fix it | Johari, Pekelis & Walsh, arXiv 1512.04922 / *Operations Research* 2022 [5] | S |
| Adaptive reuse of a holdout invalidates it; Thresholdout lets a holdout be reused a bounded number of times | Dwork et al., *Science* 349 (2015) [6] | S |
| New test sets drawn "closely following" the original process lose 3–15% (CIFAR-10) and 11–14% (ImageNet); the authors attribute this to test-set difficulty/distribution, **not** adaptive overfitting | Recht et al., ICML 2019 [7] | S |
| Four Goodhart mechanisms: regressional, extremal, causal, adversarial | Manheim & Garrabrant, arXiv 1803.04585 [8] | S |
| Preregistration separates prediction from postdiction | Nosek et al., PNAS 2018 [9] | S |
| Offline evals and A/B looked good while experts said the model "felt" off; behaviour issues are now launch-blocking | OpenAI, *Expanding on what we missed with sycophancy* (2025-05) [10], quoted by Willison [11] | V (quotations via [11]; [10] returned 403) |

### 2.2 Rollout, shadow and observability

| Claim | Source | Mark |
|---|---|---|
| Canarying = "a partial and time-limited deployment of a change … and its evaluation"; concurrent control beats before/after; ≤ a dozen metrics; attributable metrics; small artifacts roll back cheaply; flags apply to any change | Google SRE Workbook ch. 16 [12] | V |
| Gatekeeper: code released "in a disabled mode", enabled incrementally (1% → 10% → 100% of employees), "disabled instantaneously"; config changes pass automated canaries; config is a major outage source | Tang et al., SOSP 2015 [13] (via the Morning Paper summary [14]) | V (summary), S (paper) |
| Ramp traffic in phases that balance speed, quality, risk | Xu, Duan & Huang, *SQR*, KDD 2018 [15] | V (abstract) |
| Guardrail metrics, including sample-ratio mismatch as a trust guardrail; OEC | Kohavi, Tang & Xu, *Trustworthy Online Controlled Experiments* (CUP 2020) [16] | S |
| Toggle categories (release, experiment, ops/kill switch, permission); test both states; toggles carry cost; expiry "time bombs" | Hodgson, *Feature Toggles* (martinfowler.com) [17] | V |
| Flag values as fields on every event; 20% → 90% rollout watched by cohort; Simpson's-paradox trap | Honeycomb, *How Honeycomb uses Honeycomb, part 5* [18] | V |
| "Testing in production is a superpower …"; instrumentation is what makes it safe | Majors, *I test in prod* (Increment) [19] | V (the quote); the article does not cover flags or canaries |
| Ghost ads: log what would have been served in the control group | Johnson, Lewis & Nubbemeyer, JMR 2017 [20] | S |
| Counterfactual estimation from logged data in a live learning system (Bing ads) | Bottou et al., JMLR 14 (2013) [21] | S |
| Scientist: run control and candidate, compare, record timing and exceptions, use only the control's result | GitHub Engineering, *Scientist: measure twice, cut over once* [22] | S |
| Evals missed degradations; canaries insufficient; privacy limited debugging; fix = continuous evals on production systems and better tools | Anthropic, *A postmortem of three recent issues* (2025-09-17) [23] | V |
| > 4,000 offline tests mostly in CI; ~100 containerized repos; employee canary; daily tests on production models; LLM-judge with a reference model | GitHub, *How we evaluate AI models … for Copilot* (2025-01) [24] | V |
| Acceptance rate of shown suggestions drives perceived productivity | Ziegler et al., MAPS 2022 (arXiv 2205.06537) [25] | V (abstract) |
| Hook semantics: exit 2 on UserPromptSubmit blocks and erases the prompt; other non-zero exits are non-blocking errors shown to the user; 30 s UserPromptSubmit timeout discards output; `disableAllHooks`; plugin options as `$CLAUDE_PLUGIN_OPTION_<KEY>`; `cleanupPeriodDays` 30-day default | Claude Code hooks reference [26] (saved copy `research/sources/claude-code-hooks.2026-09-29.md`), R0 | V |

### 2.3 Optimization loops

| Claim | Source | Mark |
|---|---|---|
| Keep/discard loop: the agent edits only `train.py`; `prepare.py` (evaluation) is read-only and the ground truth; simplicity criterion; results.tsv; "NEVER STOP" | Karpathy, `autoresearch/program.md` [27] | V |
| An automated evaluator *h* is required; "the main limitation … handles problems for which it is possible to devise an automated evaluator"; evaluation cascade | Novikov et al., *AlphaEvolve* (arXiv 2506.13131) [28] | V |
| Frontier models reward-hack by modifying tests or scorers or reading the grader's answer; on one RE-Bench task o3 hacked in every trajectory | METR (2025-06-05) [29] | S |
| An evolutionary LLM kernel optimizer exploited an evaluator memory bug; claims walked back | Sakana AI statement (2025-02) and coverage [30] | S |
| Specification gaming definition and catalogue | Krakovna et al., DeepMind blog (2020) [31] | S |
| Optimizing a model-selection criterion on finite data over-fits it and biases reported performance | Cawley & Talbot, JMLR 11 (2010) [32] | S |

### 2.4 Branches, PRs, agents

| Claim | Source | Mark |
|---|---|---|
| Small CLs: faster and more thorough review, fewer bugs, less wasted work; "one self-contained change" | Google eng-practices, *Small CLs* [33] | S |
| ≤ 3 active branches and merging to trunk at least daily correlate with higher delivery performance | DORA, *Trunk-based development* [34] | S |
| Stacked PRs in public preview (2026-07-30): per-layer diffs; merge one, some or all | GitHub Changelog [35] | S |
| Stacked diffs originated with Phabricator at Meta | Pragmatic Engineer [36] | S |
| Worktrees for parallel sessions; `claude --worktree` | Claude Code docs [37] | S |
| Give Claude a verifiable check; show evidence, not assertions; test-first; Writer/Reviewer; fresh-context adversarial review, but don't chase every finding | Claude Code, *Best practices* [38] | V |
| Protected branches: required reviews and status checks | GitHub Docs [39] | S |

### 2.5 Data governance and migration

| Claim | Source | Mark |
|---|---|---|
| Don't log access tokens, passwords, connection strings, keys or session ids: remove, mask, hash or encrypt; restrict and monitor log access; retention minimum and maximum | OWASP Logging Cheat Sheet [40] | V |
| Data minimisation; storage limitation | GDPR Art. 5(1)(c), (e) [41] | S |
| Revoke or rotate a leaked secret first; history rewriting is secondary | GitHub Docs, *Remediating a leaked secret* [42] | S |
| Expand / migrate / contract | Fowler, *ParallelChange* [43] | V |
| Dual-write, move reads, move writes, remove old; Scientist comparisons; offline batch processing | Stripe, *Online migrations at scale* [44] | V |
| `rename` is atomic for the target name; `EXDEV` across filesystems | POSIX.1-2024 `rename` [45] | V |

---

## 3. Repo facts measured in this session [R]

| Fact | Command (from the repo root) |
|---|---|
| The active loop is `.whatever/`: branch `whatever/sep28-scale`, epsilon 0.02, primary `misses`, guards `inject-ms`, `jsonl-bytes`, `tests` | `head -c 1500 .whatever/harness.json` |
| 321 experiments: 291 keep, 30 discard; `misses` = 0 from experiment 1 on; state: "Primary 0 — KEEP via --simpler net-delete only" | `cut -f3 .whatever/results.tsv \| sort \| uniq -c`; `cat .whatever/state.json` |
| `.whatever-v1/harness.json`: epsilon 0.01, primary `brain-miss`, a `brain-holdout.ts` bench exists; `harness.sha256` present in both | `cat .whatever-v1/harness.json; ls .whatever-v1/benches` |
| `src/index.ts`: 1,444 lines / 61,171 B at `8a6b4705f` → 379 / 35,155 at HEAD; 238 commits since baseline; 48 lines > 200 chars (7 on `main`); max 1,001 | `git show 8a6b4705f:src/index.ts \| wc -lc`; `awk 'length>200' src/index.ts \| wc -l`; `git log --oneline 8a6b4705f..HEAD -- src/index.ts \| wc -l` |
| 1,251 commits ahead of `main`; merge base 2026-09-06; the main checkout is on this branch | `git log --oneline main..HEAD \| wc -l`; `git worktree list` |
| 10 worktrees, 8 `prunable` | `git worktree list` |
| CI = typecheck + `scripts/test.sh` (discovered tests) + CLI bundle build | `.github/workflows/test.yml` |
| `EDEN_MEMORY`: unknown value → `on` (fail-open) | `src/memory-consent.ts` |
| No formatter config (no biome/prettier) | `ls biome.json* .prettierrc*` |
| Existing tests isolate `EDEN_MEMORY_DIR` / `EDEN_HOME` | `grep -rn EDEN_MEMORY_DIR src/*.test.ts` |
| Wilson intervals and sample sizes in §1.1 | inline `python3` (Wilson formula, z = 1.96 and 1.645) |

---

## 4. References

1. Anthropic Engineering. *Demystifying evals for AI agents.* 2026-01. https://www.anthropic.com/engineering/demystifying-evals-for-ai-agents
2. E. Miller. *Adding Error Bars to Evals: A Statistical Approach to Language Model Evaluations.* arXiv:2411.00640, 2024. https://arxiv.org/abs/2411.00640
3. J. A. Hanley, A. Lippman-Hand. *If Nothing Goes Wrong, Is Everything All Right? Interpreting Zero Numerators.* JAMA 249(13):1743–1745, 1983. https://jamanetwork.com/journals/jama/fullarticle/385438
4. L. D. Brown, T. T. Cai, A. DasGupta. *Interval Estimation for a Binomial Proportion.* Statistical Science 16(2):101–133, 2001. [U: not fetched]
5. R. Johari, L. Pekelis, D. Walsh. *Always Valid Inference: Bringing Sequential Analysis to A/B Testing.* arXiv:1512.04922; Operations Research 70(3), 2022. https://arxiv.org/abs/1512.04922
6. C. Dwork, V. Feldman, M. Hardt, T. Pitassi, O. Reingold, A. Roth. *The reusable holdout: Preserving validity in adaptive data analysis.* Science 349(6248):636–638, 2015. https://www.science.org/doi/10.1126/science.aaa9375
7. B. Recht, R. Roelofs, L. Schmidt, V. Shankar. *Do ImageNet Classifiers Generalize to ImageNet?* ICML 2019. https://arxiv.org/abs/1902.10811
8. D. Manheim, S. Garrabrant. *Categorizing Variants of Goodhart's Law.* arXiv:1803.04585, 2018. https://arxiv.org/abs/1803.04585
9. B. A. Nosek, C. R. Ebersole, A. C. DeHaven, D. T. Mellor. *The preregistration revolution.* PNAS 115(11):2600–2606, 2018. https://doi.org/10.1073/pnas.1708274114
10. OpenAI. *Expanding on what we missed with sycophancy.* 2025-05. https://openai.com/index/expanding-on-sycophancy/ (403 to the fetcher)
11. S. Willison. *What we missed with sycophancy* (quotations of [10]). 2025-05-02. https://simonwillison.net/2025/May/2/what-we-missed-with-sycophancy/
12. Google. *The Site Reliability Workbook*, ch. 16 "Canarying Releases." https://sre.google/workbook/canarying-releases/
13. C. Tang et al. *Holistic Configuration Management at Facebook.* SOSP 2015. https://sigops.org/s/conferences/sosp/2015/current/2015-Monterey/printable/008-tang.pdf
14. A. Colyer. *Holistic configuration management at Facebook* (The Morning Paper). 2015-10-16. https://blog.acolyer.org/2015/10/16/holistic-configuration-management-at-facebook/
15. Y. Xu, W. Duan, S. Huang. *SQR: Balancing Speed, Quality and Risk in Online Experiments.* KDD 2018. https://arxiv.org/abs/1801.08532
16. R. Kohavi, D. Tang, Y. Xu. *Trustworthy Online Controlled Experiments.* Cambridge University Press, 2020. https://www.cambridge.org/core/books/trustworthy-online-controlled-experiments/
17. P. Hodgson. *Feature Toggles (aka Feature Flags).* martinfowler.com. https://martinfowler.com/articles/feature-toggles.html
18. Honeycomb. *How Honeycomb Uses Honeycomb, Part 5: The Correlations Are Not What They Seem.* https://www.honeycomb.io/blog/how-honeycomb-uses-honeycomb-part-5-the-correlations-are-not-what-they-seem
19. C. Majors. *I test in prod.* Increment. https://increment.com/testing/i-test-in-production/
20. G. A. Johnson, R. A. Lewis, E. I. Nubbemeyer. *Ghost Ads: Improving the Economics of Measuring Online Ad Effectiveness.* Journal of Marketing Research, 2017. https://journals.sagepub.com/doi/10.1509/jmr.15.0297
21. L. Bottou et al. *Counterfactual Reasoning and Learning Systems: The Example of Computational Advertising.* JMLR 14:3207–3260, 2013. https://www.jmlr.org/papers/v14/bottou13a.html
22. GitHub Engineering. *Scientist: Measure Twice, Cut Over Once.* 2016; library: https://github.com/github/scientist
23. Anthropic Engineering. *A postmortem of three recent issues.* 2025-09-17. https://www.anthropic.com/engineering/a-postmortem-of-three-recent-issues
24. C. Adams, K. Finley. *How we evaluate AI models and LLMs for GitHub Copilot.* GitHub Blog, 2025-01-17. https://github.blog/ai-and-ml/generative-ai/how-we-evaluate-models-for-github-copilot/
25. A. Ziegler et al. *Productivity Assessment of Neural Code Completion.* MAPS 2022. https://arxiv.org/abs/2205.06537
26. Anthropic. *Hooks reference* (Claude Code docs). https://code.claude.com/docs/en/hooks ; local copy `research/sources/claude-code-hooks.2026-09-29.md`; settings reference https://code.claude.com/docs/en/settings
27. A. Karpathy. *autoresearch*, `program.md`. https://github.com/karpathy/autoresearch/blob/master/program.md
28. A. Novikov et al. *AlphaEvolve: A coding agent for scientific and algorithmic discovery.* arXiv:2506.13131, 2025. https://arxiv.org/abs/2506.13131
29. METR. *Recent Frontier Models Are Reward Hacking.* 2025-06-05. https://metr.org/blog/2025-06-05-recent-reward-hacking/
30. Sakana AI statement on the AI CUDA Engineer (2025-02), https://x.com/SakanaAILabs/status/1892992938013270019 ; coverage: https://www.techmeme.com/250221/p22
31. V. Krakovna et al. *Specification gaming: the flip side of AI ingenuity.* DeepMind blog, 2020-04-21. https://deepmind.com/blog/article/Specification-gaming-the-flip-side-of-AI-ingenuity
32. G. C. Cawley, N. L. C. Talbot. *On Over-fitting in Model Selection and Subsequent Selection Bias in Performance Evaluation.* JMLR 11:2079–2107, 2010. https://www.jmlr.org/papers/v11/cawley10a.html
33. Google. *Small CLs* (Engineering Practices). https://google.github.io/eng-practices/review/developer/small-cls.html
34. DORA. *Capabilities: Trunk-based development.* https://dora.dev/capabilities/trunk-based-development/
35. GitHub Changelog. *Stacked pull requests are now in public preview.* 2026-07-30. https://github.blog/changelog/2026-07-30-stacked-pull-requests-are-now-in-public-preview/
36. G. Orosz. *Stacked Diffs (and why you should know about them).* The Pragmatic Engineer. https://newsletter.pragmaticengineer.com/p/stacked-diffs
37. Anthropic. *Run parallel sessions with worktrees* (Claude Code docs). https://code.claude.com/docs/en/worktrees
38. Anthropic. *Best practices for Claude Code.* https://code.claude.com/docs/en/best-practices
39. GitHub Docs. *About protected branches.* https://docs.github.com/en/repositories/configuring-branches-and-merges-in-your-repository/managing-protected-branches/about-protected-branches
40. OWASP. *Logging Cheat Sheet.* https://cheatsheetseries.owasp.org/cheatsheets/Logging_Cheat_Sheet.html
41. Regulation (EU) 2016/679 (GDPR), Art. 5. https://eur-lex.europa.eu/eli/reg/2016/679/oj/eng
42. GitHub Docs. *Remediating a leaked secret in your repository.* https://docs.github.com/en/code-security/tutorials/remediate-leaked-secrets/remediating-a-leaked-secret
43. M. Fowler (D. Sato). *ParallelChange.* https://martinfowler.com/bliki/ParallelChange.html
44. Stripe. *Online migrations at scale.* https://stripe.com/blog/online-migrations
45. The Open Group. *POSIX.1-2024: rename.* https://pubs.opengroup.org/onlinepubs/9799919799/functions/rename.html

---

## 5. Open items and unverified points

- **[U] Env vs file flags.** That a changed env var does not reach hooks until Claude Code restarts is inferred from process inheritance. Check it live once: set a var through `settings.json` `env` mid-session and see whether the next hook sees it. If it does, env becomes a second runtime switch, but the file stays primary.
- **[U] Dwell times and collection rate.** 7-day dwells and "4–8 weeks to 300 negatives" extrapolate R6's single-user rate. Replace them with the measured rate after stage 1's first week.
- **[U] Format-version refusal** (R6.2) is general practice, not cited.
- **[S] items** (§2) were checked only through search summaries or secondaries. None is load-bearing on its own: each recommendation has at least one [V] or [R] source, except the statistical rules (Wilson, rule of three), which are standard.
- **Within-user A/B** (alternating by session hash) is feasible but has almost no power at ~40 sessions a month. It is not recommended as a ship vote.
- **The whatever branch's behavioural keeps** (for example experiment 1) were not reviewed individually here. That triage is the first task after stopping the run (R3.1).
