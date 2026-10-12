# A4 — The delivery contract (v2): never restate, never repeat, never stale

**Dated 2026-09-29, v2.** The normative design. It specifies what `DECISIONS.md` decides (D-numbers below). The index is `ROADMAP.md`.

v1 was rewritten after R0–R6:
- verified hook facts
- a cue experiment
- a cue-architecture study
- a hostile review against this machine's real transcripts
- a scope study on 19 repos
- a real-usage analysis

The biggest changes from v1:
- memory is per repo, not per session
- the ledger is per context window, subagents included
- non-human submits are silent
- **policies**, not copula facts, are the main thing users restate; they are delivered by compiled triggers and guarded at the action
- the cue is the situation (prompt, previous turns, paths), not the prompt alone
- scope derivation was replaced with the rule validated on real repos

---

## 0. The promise, as invariants

| # | Promise | Failure | Metric (A5) | Target |
|---|---|---|---|---|
| G1 | The user never has to restate what they told the agent | miss | `need_miss_rate` (fixtures); `restate_rate` (dogfood; policy + slot restatements across sessions) | A policy restated in 2 sessions is never needed a 3rd time |
| G2 | Nothing stale is injected | stale | `stale_rate` against a world oracle | **0** |
| G3 | Nothing irrelevant is injected | false | `false_rate` against annotated `needs ∪ allowed`; silence on real logged negatives | FIR ≤ 5% on hard negatives; **0** on non-human submits (except `Updated:` items) and `ack` turns; `continuation` turns inject only on STRONG `q_prev` evidence |
| G4 | Automatic, direct, small | waste | tokens per epoch; packet rate | packet on ≤ 25% of human prompts; ≤ 6k tokens per epoch |
| G5 | Nothing repeated unnecessarily | redundant | `redundant_rate` against a simulated context window | < 5% |

G2 outranks G1: a stale fact misleads, while a miss only costs a restatement.

Each error type has its **own control**. That is the lesson from biology (A3 §4):

| Error type | Control |
|---|---|
| interference | **separation** (scope, window) |
| staleness | **supersession** (keyed slots, citations) |
| redundancy | **habituation** (ledger) |
| irrelevance | **gating** (typed evidence, calibrated τ) |
| misses | **triggers + learning from restatement** |

---

## 1. Identity and layout (D1, D2, D11)

| Axis | Key | Holds |
|---|---|---|
| **Repo** | `hash(realpath(git --git-common-dir))`; non-git: `hash(realpath(cwd))` | All long-term memory |
| **User-global** | fixed | Policies promoted across ≥ 2 repos or stated globally (D11) |
| **Scope** | R5 rule (§2) | Where a slot fact is true |
| **Window** | `session_id`, or `session_id--agent_id` in a subagent | Ledger, place signal, cue context, shadow set, encode high-water mark |

```
<root>/dirmap.json                 # realpath(dir) → {repo, top}; written under flock; stat-checked on miss
<root>/_user/policies.jsonl
<root>/repos/<repo>/
  live.jsonl  history.jsonl        # slot facts (keyed), superseded values (bitemporal-lite)
  policies.jsonl  intents.jsonl    # compiled triggers + text
  gotchas.jsonl  procedures.jsonl
  episodes/seg-*.jsonl             # append-only diary; never rewritten (except purge)
  scopes.json  shadowfacts.json  tau.json  aliases.jsonl  last_read.json
  hook.log.d/<yyyy-mm-dd>.jsonl  miss.jsonl  pending.jsonl  .lock
  declines.jsonl                   # the guard's declined asks, by rule (A6 §2.5's revocation count; ids only)
  activity  sleep.pending          # mtime of the repo's last hook; the idle sleeper's pid (D34, `eden sleep --idle`)
<root>/windows/<win>/
  delivery.log  delivery.json      # ledger (§4)
  ctx.log                          # append-only {k: paths|exit|sig|crons}; folded on read (last 3 human turns), compacted at Stop
  qprev.json                       # rare tokens of last_assistant_message, written by sync stop-fast
  shadow.log                       # instruction files loaded in this window (InstructionsLoaded; AGENTS.md/MEMORY.md are read from disk)
  spawn.log  spawn.lock            # the session's PreToolUse(Agent) launches (task paths, classes) and their claims
  scope.json                       # a subagent's scope, taken at its first SubagentStart (a resume reuses it)
  guard.log  guard.lock            # guard dedup
  hwm.json  hwm.lock               # encode high-water mark, typed-prompt parent map (rewind); advanced only under flock(hwm.lock, LOCK_NB)
```

**Every row carries:**
- `id` — ULID
- `seq` — per-repo monotonic, assigned under `flock(.lock)` with a 50 ms timeout; on timeout the row goes to `pending.jsonl` and sleep assigns `seq`
- `t` — wall time, persisted
- `src` — `user | tool | paste | agent | sleep | legacy`
- `scope`
- `kind`
- `src_uuid` — the transcript line it came from, when there is one. The repo writer drops a row whose `(src_uuid, kind, key)` already exists, so two encoders racing on one delta cannot double-write

---

## 2. Scope (D3–D5)

**Derivation** is `research/R5-scope-on-real-repos.md` §9, verbatim:
- tracked plus untracked-not-ignored files (`git ls-files -co --exclude-standard`)
- manifest set: 20+ types
- workspace members beat exclusions
- VENDOR / TEST / EXAMPLE exclusions; EXAMPLE trees become one bucket scope
- min-2-file scopes
- Bazel top-level fallback
- `.eden/scopes` override

It is rebuilt at sleep and after a Write/Edit of a manifest or workspace file. Lookup is a longest prefix match and never touches the filesystem.

**Place signal** (per window, folded from `ctx.log`):
- Collect paths with these weights (DECISIONS D4):

  | Source | Weight |
  |---|---|
  | path named in the prompt | 3 |
  | main-thread tool path, most recent batch | 2 |
  | main-thread tool path, last 3 human turns | 1 |
  | main-thread Bash path (`cd X &&`, path arguments) | 1 |
  | subagent tool path | 0.5, only as a tie-breaker when main-thread paths carry < 30% (D2) |

- Map each path to `(repo, scope)` through its own worktree root.
- Paths belonging to another repo are ignored.
- The **read set** is every scope holding ≥ 30% of the weight, **at most 2** (D4).
- If none reaches 30%, fall back to the common ancestor.
- If there are no paths, `""`.

**Visibility.**

| Kind | Visible at |
|---|---|
| slot fact | own scope + descendants without an own row (cascade with override, D5) |
| policy, intent | own scope + descendants (policies are mostly `""` or user-global) |
| gotcha, procedure, episode | exact scope; ancestor cues see them only if the cue names the scope path |
| anything | **never** siblings |

When the read set has 2 scopes and both hold a value for one slot, render one bullet: `auth provider — apps/web: Clerk · packages/cli: none`.

---

## 3. Kinds and encode (D6–D13)

### 3.0 Authority and input hygiene (D12, D13)

Only **user-typed** text creates slot facts, policies and intents:
- the Submit `prompt`
- transcript user lines that are not meta, not compact summaries, not tool results, and not command/reminder/notification wrappers
- queued prompts

Before extraction, strip pasted spans (see D12):
- spans between `<pasted_content id=…>` markers, exact when the host marks pastes
- fenced code
- `>` quotes
- runs of ≥ 3 lines without sentence punctuation
- spans ≥ 200 chars that also occur in a recent tool result

Everything else is an **episode**, with its true `src`.

Every writer calls one `sanitizeForStore` gate: gitleaks rules plus the keyword rule, with no entropy-only redaction.

### 3.1 The six kinds

| Kind | Created from | Key / cue | Supersession | Delivered by |
|---|---|---|---|---|
| **slot** | user statement matching the slot table (D7); repo evidence mined at sleep (D8, `src=tool`, cited) | `(scope, slot)`; subject aliases; value class | same `(scope, slot)` with a different value → `history` (`invalid_at = seq`); `use A not B` invalidates B; retraction (`no longer`, `dropped`, `not … anymore`, `forget that`) invalidates with **no successor**; a user statement beats a tool citation; a failed citation invalidates | keyed lookup (slot detector on the cue); lexical |
| **policy** | unqualified user imperative on an action class (D9), keyed `(class, polarity, object)`; a pin when `never/always` is explicit or the same key recurs in ≥ 2 sessions | action classes (compiled triggers, D18) + text | explicit revocation ("you can merge now", "that rule is gone") → history; the opposite polarity on the same key from the user → supersede | action-class trigger on the cue; **PreToolUse guard** (D19); SessionStart ≤ 3 |
| **intent** | any mention with a temporal qualifier ("yet / for now / until / before X / after Y / this time / remind me"), however often it recurs | `(class, polarity, object)` + trigger `{tokens, paths, event}` + expiry (its action completing, e.g. `gh pr create` ran, or 7 days) | done → removed; expiry → removed | trigger on cue or tool event; guard `ask` on any matching command until it expires (D19) |
| **gotcha** | failure→success on the same command with a file change between (D10) | `error_sig` | a newer fix for the same `error_sig` replaces the older one | PostToolUseFailure / PostToolBatch on a matching error |
| **procedure** | how-to cues + verified command runs (existing how-to store, scoped) | cue tokens, command head | newer verified run | lexical on procedure cues; PostToolBatch when the same command head ran in this batch (the context arrives after the command, so it helps the next attempt) |
| **episode** | everything else, including assistant, tool and paste text | tokens, `enc_cues` | never superseded; `stale_for` when a slot it mentions changes (D31) | lexical, only with MEDIUM+ evidence; ≤ 2 per packet |

### 3.2 Prediction-error write (slot kind)

| Incoming vs visible live value | Action |
|---|---|
| none | insert at the slot's `default_scope` (`root` → `""`; `working` → the top scope of the read set) |
| equal | no new row; `reps++`; emit `restate` or `confirm` (§7) |
| different, same scope | supersede; `corrected=1`; `stale_for` on episodes in that scope and its non-overriding descendants |
| different, inherited from an ancestor | insert at the child (override) |

### 3.3 Encode on the hook path (delta)

- `hwm.json` holds the byte offset of the last **complete** transcript line encoded, plus the uuid of the last typed prompt.
- The transcript may lag (R0 F8). The current prompt therefore comes from the Submit payload, and the final assistant text from `last_assistant_message` at Stop.
- PostToolUse no longer parses the transcript. **PostToolBatch** records paths, exit codes and error signatures for the whole batch in one write, which avoids concurrent PostToolUse races (R0 F11).
- Rows get the **message** timestamp.

**Rewind** (27% of sessions) is detected by the **delta encoder**, not by a tail walk. At Submit the new prompt's line is usually not yet in the lagging transcript, and a 32 KB tail reaches the previous typed prompt only about half the time.
- The encoder already parses every complete line after `hwm.off`. It keeps a rolling `uuid → parentUuid` map of the last 5,000 lines.
- For each typed-prompt line it records `(uuid, parentPrompt)`, where `parentPrompt` is the nearest typed-prompt ancestor.
- A typed prompt whose `parentPrompt` is not the previously newest typed prompt is a **branch point**. Every typed prompt between them is abandoned:
  - rows whose `src_uuid` is on the abandoned branch move to history (`rewind`);
  - ledger entries whose `att` is on it are dropped.
- The encoder runs at Submit (on the lines available), at PostToolBatch and at Stop, so the first hook after the line is flushed catches the rewind.
- There is **no** "inconclusive → drop 3 turns" fallback. An unresolved ancestor keeps the entry: one missed re-injection is cheaper than a repeat on every turn.

---

## 4. The ledger (D25): habituation per window

```jsonc
// windows/<win>/delivery.json   (snapshot; delivery.log is the append-only truth)
{ "v": 2, "epoch": 2,
  "delivered": { "a1b2c3d4/s:apps/web|auth.provider": {"ver":"9f2c","epoch":2,"off":812345,"att":"<prompt_id>","ht":5,"n":1},
                 "_user/P:integrate|neg|*":           {"ver":"11aa","epoch":2,"off":402001,"att":"<prompt_id>","ht":3,"n":1} },
  "tokens_epoch": 740 }
```

**Turn counter.** `hturn` is not stored in the snapshot. At a **human** Submit, append `{"k":"turn","prompt_id":…,"off":…}` to `delivery.log`. `hturn` = the count of distinct `prompt_id`s among `turn` records (fold), so two racing Submits cannot double-count. Each delivery records `ht` (the `hturn` at delivery), and every "last 3 turns" rule compares `ht`.

**`att`** is the Submit payload's `prompt_id` at delivery. The encoder maps `prompt_id → uuid` when it meets the typed-prompt line; until then the entry counts as on-branch.

**`cid` scheme:** `cid = <repo8>/<kind-letter>:<key>`, where `repo8` is the first 8 hex chars of the repo key (`_user` for user-global). Two repos in one window therefore never collide.
- slot: `s:<scope>|<slot>`
- policy **and** intent: `P:<rule_key>`, where `rule_key = hash(class, polarity, object)` (D9). An intent and the pin it becomes share a cid, and a repo pin and its user-global copy map to the user-global cid.
- gotcha: `G:<error_sig hash>`
- procedure: `R:<id>`
- episode: `E:<hash(normalized text)>`

Row `id`s are ULIDs and never carry a prefix.

`ver` is a hash of the rendered value. Near-identical text reached through two rows gets one `cid`.

**Refractory rule** (applied after ranking):
- Drop a candidate if `delivered[cid]` exists, has the same `ver` and the same epoch, **and** the item is still in the live window. "Still in the window" means:
  - its `att` is on the current branch (rewind check), and
  - `size_now − off` is below the re-eligibility distance.
- Distances: **400 KB** for policies, pins and intents (a fresh cue is also required); **1.2 MB** for slot facts, gotchas, procedures and episodes. A child window measures distance on its own `subagents/agent-<agent_id>.jsonl`, because its `transcript_path` is the main transcript. Both distances are unmeasured proxies, tested by the A5 `re-eligibility` arm and refit from dogfood `message.usage` data.

**Re-arm (dishabituate):**
- **`ver` changed:** render `Updated: … (was …)`.
- **`SessionStart(clear)`:** bump the epoch.
- **`PostCompact`:** re-arm only the cids whose value tokens are **absent from `compact_summary`** (R0 F14). Value tokens are the slot value for slots, and for policies and intents the object plus the class verb stem of the rule text (e.g. `merge`, `pr`).
- **Violation:** a guard match re-delivers its policy as `additionalContext` (seen by Claude after the call) and, where §5.4 allows, as an `ask` (seen by the user before the call).
- **`resume`:** keep the ledger; the replayed packets are still in context (R0 F5).
- **`fork`** (session or fork subagent): copy the parent ledger.

**Budget:** `tokens_epoch` is counted and reported. After 6k tokens, only `Updated:` items and guard deliveries are allowed; R6 shows this rarely binds.

**Concurrency and overflow:**
- Append to `delivery.log` (O_APPEND, one line < 4 KB). Fold at Stop and SubagentStop under `flock`: rotate the log by rename, then write `delivery.json` by rename. Readers fold snapshot + logs as a union, keeping max(`off`).
- Above 256 entries, evict older epochs first, then the least recent episodes.

**Built in P1.1** (`src/memory-ledger.ts`; D25's note has the mechanics). Where it reads this section narrowly:
- The snapshot keeps `turns` (the count of distinct `prompt_id`s folded) and the last 16 `prompt_id`s: a fold of `turn` records, never a counter a Submit increments, so two racing Submits still count once.
- The ledger holds ids and hashes only (X11). A `deliver` record has no value, so `Updated: … (was …)` takes the old value from `validity.jsonl`, and says only "Updated: …" when none was logged.
- Until P3.3's keyed slots, "`ver` changed" also covers a row whose text retracts or switches away from a value the window was given (D7: "we switched auth from Auth0 to Clerk" after "Our auth provider is Auth0"), since a switch has no slot key of its own. The switch must name only subject words of that slot ("auth" of "auth provider"), and its delivery records the slot at the new value, so the change is given once.
- `Updated:` items come on the cue that retrieves the new value. A non-human submit carries none, and SessionStart's are P2.5's: without keyed slots there is no lookup from a delivered cid to its current value.
- `tokens_epoch` adds one `packet` record per packet (A5's count: a quarter of its characters).

**Built in P1.2** (`src/memory-ledger.ts`, `src/memory-value-tokens.ts`, `src/memory-fork.ts`; D25's note has the mechanics). Where it reads "Re-arm" narrowly:
- SessionStart(compact) starts the epoch, which re-arms everything, as before. PostCompact, which Claude Code runs right after it (R0 F32), then holds what the summary still names: the deliveries of the epoch the compaction closed whose value tokens all appear in `compact_summary`. A held delivery counts its distance from the summary's offset and is on every branch. A host without PostCompact re-arms everything.
- Value tokens are kept hashed (X11). A rule's class verb stem is matched by any verb of its A7 §5 class in any inflection ("merging" for "merge"), and its object words in the singular, so "PRs" and "PR" are one; a class's default object is not widened ("pull requests" does not name "pr"). A rule's object is what follows its class verb, or the clause's other words when the verb ends it ("Run the tests before you commit"), never a word that only links clauses ("before", "without"); a rule whose clause names only its class ("Never deploy", "Before you deploy, ask me") has no value tokens, since any summary mentioning a deploy would hold it. A rule with no class verb keeps its object words. Episodes, gotchas, procedures and those rules have no value tokens, so a compaction always re-arms them.
- `clear` starts an epoch. Claude Code gives `/clear` a new session (a new, empty window), so this matters only for a host that keeps the id.
- `fork` brings nothing at SessionStart, like `resume`. No payload names the parent, and Claude Code (2.1.294) writes the fork's transcript only after its first turn, keeping the parent's line `uuid`s. So the copy happens at the fork's first `stop-sleep`: the parent is the window, among those of the transcripts beside the fork's (at most 32), whose turn map holds the newest of the fork's lines, and the deliveries made at its prompts after that line's turn are not copied. Only the parent's current epoch is copied, so if the parent compacted after the fork point, what it delivered before that compaction comes once more in the fork. The parent's `tokens_epoch` is copied whole, an upper bound: a snapshot keeps it as one sum, so the packets after the fork point cannot be told apart. The fork's first turn runs on an empty ledger. A fork subagent's copy waits for SubagentStart (P2.5).
- The internal compaction agent's SubagentStop (`agent_type: ""`) writes nothing: its last message is the summary, which the main transcript also carries.

---

## 5. Delivery points (D23)

All points share the window ledger, the validity filter, the novelty filters and the packet renderer.

### 5.1 UserPromptSubmit (human submits only; hot path, 150 ms budget, fail-open)

```
0 guard     consent; non-human submit (D24) → {} (except Updated: items); budget timer
1 context   repo (dirmap.json), window, read set (§2); encode available delta (rewind detection, §3.3);
            append turn record; load ctx.log, qprev.json, delivery, tau, shadow
2 mode      turn mode: ack | continuation | question | imperative | debug | how-to        (A7 §2)
            ack → {} unless an open error or intent trigger fires
3 cue       q = prompt ⊕ prev user turn ⊕ path tokens ⊕ q_prev (assistant; weight↑ on continuation),
            per-part mass limits; Eden's own delivered tokens stripped from q_prev    (A7 §3)
4 gather    a. slot detector on q → keyed lookup of the read set (cascade)
            b. action classes in q → policies/intents (≤ 2 per class, by recency)
            c. scoped postings for q parts, |C| ≤ 200, newest-64 on fat terms
            d. open error signature → gotchas
5 validity  superseded / invalid / expired intent / failed citation / stale_for (unless the cue asks history) /
            sibling scope → drop
6 gate      admit: keyed slot hit | trigger hit | identifier-shaped token match (STRONG)
                   | BM25F top ≥ τ_repo, then rows ≥ 0.7·top (MEDIUM path)
            episodes need MEDIUM from ≥ 2 cue parts or 1 STRONG                    (A7 §4)
7 novelty   ledger refractory (§4) · residual (D26) · shadow set (D27)
8 shape     one value per slot (merge same-subject slots); ≤ 2 policies, ≤ 1 procedure,
            ≤ 2 episodes; soft 4 / hard 6 bullets / 900 B; stop at first empty stage
9 emit      declarative wording (D14); append to delivery.log; hook.log line (ids + stage drops)
```

### 5.2 SessionStart

- **startup:** ≤ 3 policy pins for the likely scope (last session's read set), plus `Updated:` items (values that changed since this repo's last session).
  - **Built in P2.4** (pins only, D9): the rules kept for all projects `(all projects)` and a proposal shown once (D11), then the repo's pins, a rule row's pinned clauses only (a policy said once is not briefed, an intent never is), then the legacy gists without their rule clauses. The ≤ 3 cap, the scope and `Updated:` items are P2.5's.
  - **Built in P2.5** (`packages/cli/src/memory-hook.ts` `briefing`): a startup or a clear briefs at most 3, in order: the rules proposed for revocation (A6 §2.5), the D11 proposal and the rules kept for all projects, then the repo's newest pins; the window's shadow set first takes out what its files state, with the project's CLAUDE.md files read from disk, since Claude Code 2.1.294 runs SessionStart(startup) before the session's InstructionsLoaded. No gists: since P0.5 a later session retrieves the same row at its Submit (P0.5's end-to-end got the port fact twice). A row the rules kept for all projects leave with no rule of its own briefs what else it says as a fact, not as a rule: a keyed row is no candidate of the lexical path, so this is where its fact still reaches Claude. Pins have no scope before P3.1's catalog, so "the likely scope" ranks nothing. `Updated:` items wait for P3.3: they need a lookup from a delivered cid to its current value, which keyed slots give, and before P3.4's mining nothing changes a value between sessions.
- **clear / compact:** re-arm per §4.
  - **Built in P2.5:** a compaction briefs the 3 latest valid gists without their rule clauses, P0.2's carrier, and no pin. The rows a compaction drops come back on their next cue; until that cue's words reach a row's ("how should we cache sessions?" misses "We use Redis for caching", A5 `negation`), the gists stay (a P4.2 follow-up). A clear is a new window in Claude Code, and briefs as a startup does.
- **resume:** nothing new.

### 5.3 SubagentStart

- The SubagentStart payload has no task prompt (R0 F27). The task paths are captured by a `PreToolUse` hook matched on `Agent` (context-free, < 20 ms), which appends `{tool_use_id, agent_type, prompt_paths, t}` to `windows/<parent>/spawn.log`.
- At SubagentStart, take the newest unconsumed `spawn.log` entry with the same `agent_type` within 5 s and mark it consumed under `flock`. If none matches, use the parent's read set. A resumed subagent reuses the child window's stored scope.
- A fork subagent inherits the parent's context, packets included, so it gets no bullet already in the parent ledger.
- ≤ 3 bullets: relevant slot facts, policies whose classes fit the agent type or task (e.g. a reviewer gets the review/merge policies), and gotchas for the scope.
- Claude Code dedupes these per subagent (R0 F12); Eden records them in the child window's ledger.

**Built in P2.5** (`src/memory-spawn.ts`, `packages/cli/src/memory-spawn-hook.ts`, `memory-hook.ts` `subagentStart`; flag `deliver.subagent`, `shadow` by default). Where it reads this section narrowly:
- **The record** holds the task's classes beside its paths (`{k: "spawn", id, type, paths, classes, t}`), so "policies whose classes fit the task" need no task text (X11). Paths are the places of the repo the task names: paths with a folder and file names that exist under the repo's top, or whose folder does (a file to create); a URL or a path outside the repo is none. A nested subagent's launch goes to the session's window too, as SubagentStart's payload does not say which window launched it. With the flag `off` nothing is recorded.
- **The claim** is A4's rule. Claude Code 2.1.294 (P2.5's end-to-end) runs each Agent call's PreToolUse and then its SubagentStart, one call after the other in a parallel batch too, so the newest record of the type is the subagent's own; the subagent's meta file, which names the call's `tool_use_id`, is written only after SubagentStart returns (born 28 and 30 ms after the two hooks' wide events), so it cannot match them. A task that names no place of the repo takes the parent's recent paths, as no record does. Until P3.2's read set, "the parent's read set" is the paths of its last 3 human turns' tool batches (D4's main-thread paths).
- **The packet:** the policies and intents of the task's classes and the type's (its name read as words, the agentive ending as the verb, "code-reviewer" firing `review`; `memory-classes.json`'s `agents` map adds `integrate` to `review`), then the rows the lexical path finds for the scope's paths, through validity, the gate (A7 §4: the cue is the scope's paths, so an untyped row is admitted only on an identifier it shares with them), the child's shadow set and ledger; ≤ 3 bullets. Gotchas are P4.5's.
- **A fork** (`agent_type: "fork"`; Claude Code's fork mode, on by default in interactive sessions, `CLAUDE_CODE_FORK_SUBAGENT=1` under `-p`) copies its parent's current-epoch ledger at its first start, at `off` 0 of its own transcript, and reads the parent's whole conversation since the last compaction as its D26 residual: its context is the parent's.
- **The child's shadow set** is its parent's, by type (D27, R0 F35): a fork's whole set; a typed subagent's, the parent's eagerly loaded files, the CLAUDE.md files on disk and AGENTS.md, not auto memory; Explore and Plan none.
- **Distance:** a child window's deliveries, the guard's included, are made at the size of its own transcript (`<session>/subagents/agent-<agent_id>.jsonl`, D25).
- `eden setup` installs SubagentStart, not the `PreToolUse(Agent)` record (its PreToolUse is the compile hook), so its subagents take the parent's recent paths.

### 5.4 PreToolUse policy guard (D19)

- Registered statically in the plugin's `hooks.json`: one handler per `(class, pattern)` of the A7 §5 map, with the class passed as an argument. `if` is best-effort, so the guard re-checks `tool_input.command` against its class. Parallel handlers deduplicate through `guard.log` under `flock`: the most severe class for a `tool_use_id` emits, the rest exit `{}`.
- On a match against a live policy or intent:
  - **Always:** `additionalContext` with the declarative rule. It reaches Claude next to the tool result.
  - **Irreversible** class (integrate, push-upstream, deploy, delete, destructive-db, history-rewrite) **or any live intent** → also `permissionDecision: "ask"`, reason `Eden: rule you set (<age>): <text>`. The reason is shown to the user only. `ask` is only returned when `permission_mode ∈ {default, acceptEdits, plan, auto}`; in `dontAsk` and `bypassPermissions` the guard downgrades to context only and logs `guard_bypassed` (D19).
- Never `deny`. Guard firings are logged with `tool_use_id`. Approval or decline is read later from the transcript (A6 §2.5). `EDEN_POLICY_GUARD=off` disables it.

**Built in P2.3** (D19's note has the registration and flags). Where it reads this section narrowly:
- The guard reads A4 §1's `policies.jsonl` and `intents.jsonl`: an index the store writes beside itself at each persist, from the typed rule rows not superseded (newest 500 each), so the lookup never loads the store. What a later invalidation or 7 days took from a row is read at the guard, as at every delivery point.
- The reason and context show each rule's own clause of what the user typed, "Rule you set (<age>): …"; a prohibition on the agent alone ("… yourself") of a class's default object is said as who does it ("pull requests are merged by you, not by the agent", D14).
- What the guard tells is a delivery in the window's ledger of its mode, outside the refractory rule and the budget (§4: a violation re-delivers).
- Labels (§5.5) come from the next PostToolBatch's `tool_calls`, and at `stop-sleep` from the transcript's last 256 KB for an ask no PostToolBatch saw: `declined` for Claude Code's rejection message, `denied` for a refusal nobody answered (`claude -p` returns the ask's reason as the error; "Permission to use … denied"), `approved` otherwise. The 3-declines revocation proposal (A6 §2.5) is not built.
- An intent ends (validity `end` records) when the user approved the guard's ask about it and the call then ran (a call nobody was asked about, in `bypassPermissions` or with `guard.ask` off, leaves it until it is released or 7 days pass), and on a release with no class word whose verb is the intent's own or its class's ("Open it now."). A rule of any kind ends when the user's sentence is only "that rule is gone" (or "drop that rule") in the human turn right after the guard asked about it in that window: only the ask's reason reaches the user, and "delete that rule from the eslint config" is about another rule.

### 5.5 PostToolBatch

- Append to `ctx.log` (paths, `Exit code N` parsed from the serialized results, error signatures). Run the delta encoder.
- On the **first touch of a new scope this epoch**, deliver ≤ 2 STRONG items: slot facts for that scope, and gotchas or procedures anchored to the touched paths.
- Gotchas are delivered **only** at PostToolUseFailure (§5.6). PostToolBatch delivers a gotcha only for a failure PostToolUseFailure did not see (for example an MCP tool error reported as success text).
- Label pending guard asks from this batch's `tool_calls`: `approved` if the call has a successful result, `declined` if its result is the permission-rejection message.
- Never more than one delivery per batch.

### 5.6 PostToolUseFailure

Gotcha lookup by `error_sig`, delivered next to the error.

### 5.7 Stop (async, prints nothing)

Two handlers, because async output races the next prompt and Stop does not fire on interrupts (R0; R6: 11 interrupts per 100 prompts):
- **Sync `stop-fast`** (< 15 ms, prints `{}`): write `qprev.json` (rare tokens of `last_assistant_message`, minus the last delivery's tokens) by atomic rename. If Submit finds `qprev.json` older than the newest assistant line in the transcript (an interrupt or a lost race), it rebuilds `q_prev` from the last complete assistant text blocks in the tail (≤ 64 KB).
- **Async `stop-sleep`** (prints nothing): use labels (§8), fold `delivery.log` and `ctx.log`, light sleep (delta encode, gotcha detection, intent completion), and spawn the detached idle sleeper (§6).

### 5.7b SubagentStop (async)

The same as `stop-sleep` for the child window, reading `agent_transcript_path`. Under `SubagentHandback` (v2.1.271+), `last_assistant_message` is not the report; use labels read the handback's `tool_input.message` from PostToolUse.

**Decided in P2.5:** the child's own transcript is not encoded. What the parent learns from it is the Agent call's result, which the parent's delta encodes; rows made from the child's own reads and reasoning would come back to the parent as bullets its Agent result already holds (P0.6's guard runs: `redundant_rate` +4.42 pp). SubagentStop encodes the child's last message and folds its ledger.

### 5.8 Packet wording (D14)

```
Eden memory (apps/web), recalled from earlier sessions:
- Auth provider in apps/web: Clerk (you said, 3 weeks ago)
- Rule you set: pull requests are merged by you, not by the agent
- Updated: test runner is now vitest (was jest)
- Earlier fix for "ERR_REQUIRE_ESM" here: vitest config set to ESM (.mts), 2026-08-12
```

### 5.9 Placement

- **Hook:** at the tail, which is cache-safe.
- **Wrap / OpenAI-shaped inject:** attach to the last **human** user message and keep it there for every tool-loop step of the turn (D29). Built in P0.7: every later request of the conversation carries it on that message too, as the hook's packet stays in the transcript (`src/memory-wrap.ts`).

---

## 6. Sleep (D34)

| Tier | When | Does |
|---|---|---|
| light | async `stop-sleep` (≤ 1 s) | delta encode, gotchas, intent completion, ledger fold, `hook.log` rotate |
| idle | a detached `eden sleep --idle --after 300`, spawned by `stop-sleep`; exits early if the repo saw activity in the last 5 min (no hook fires during idle) | slot extraction from user episodes; `stale_for`; scope catalog rebuild if manifests changed; citation checks |
| heavy | the same detached process at ≥ 30 min idle, or launched detached from SessionStart, which returns immediately (SessionStart delays Claude's first response) | repo-fact mining (D8), τ_repo refit on the silence replay (D17), alias maturation (D21), policy promotion (D9, D11), restatement classification (§7), SQLite `optimize` at P6 |

**Built in P2.4:** the heavy tier is not built (P3.4's follow-up), so policy promotion (D9) runs in the full sleep the idle sleeper runs (`consolidate`), and the D11 proposal right after it, over every repo's rule index under the root (`eden sleep`, `sleepStore`).

LLM use at sleep is opt-in per repo, local model first, and receives only scrubbed rows.

---

## 7. Restatement (D30): the G1 signal

**Events:**
- `restate` — the user re-asserts a visible live slot value, or re-states a live policy, when:
  - the previous assistant message was not a question, **and**
  - the item was not delivered or residual in this branch's last 3 turns, **and**
  - the turn is not the session's first human prompt, unless it follows an agent action that contradicted the value.
- `confirm` — any other re-assertion. It reinforces only.
- `policy_recur` — a user-typed, **unqualified** imperative with the same `(class, polarity, object)` as a policy or intent from an earlier session, whether or not a pin exists yet.

**Classification** (heavy sleep, joined with `hook.log`):

| Class | Test | Action |
|---|---|---|
| `not_retrieved` | the candidate never entered C for the cue | propose aliases or class words from the **cue that preceded** the restatement; D21 acceptance |
| `gated_out` | it was in C but failed the gate | τ / gate feature evidence; logged for refit |
| `suppressed` | dropped by the ledger or residual filter | ledger-distance evidence; re-examine the 400 KB / 1.2 MB distances |
| `not_encoded` | no row existed | an extractor miss → a fixture row |
| `recurring_policy` | `policy_recur` without a pin | promote to a pin (D9); when the pin exists in ≥ 2 repos, **propose** user-global for confirmation (D11) |

**Built in P2.4:** `policy_recur` goes in the human Submit's wide event (the identities of the prompt's unqualified policies a live row of another session states). Promotion reads the rows, not the event: D9's "unqualified in ≥ 2 sessions" decides, so an intent in one session and the same policy in one other is a `policy_recur` but no pin (DECISIONS wins).

---

## 8. Use labels (logging only in v1)

At Stop and SubagentStop (for child windows), for each delivery this turn, compare its identifier-shaped tokens with `last_assistant_message` and the turn's tool inputs:
- `used` — ≥ 1 identifier in a tool input, or ≥ 2 in the reply
- `ignored` — otherwise
- `contradicted` — the agent asserts another value for the slot, or the delivered command exits non-zero

These labels feed the backlog triggers (DECISIONS §7) and dogfood reports only. They do **not** enter τ refit or ranking in v1, because R6 found a naive "used" proxy barely beats a random baseline (67% vs 54%).

---

## 9. Locks (final)

| Lock | Status |
|---|---|
| L1 memory per repo | **Adopted** (D1): git-common-dir key, windows per D2 |
| L2 cascade with override | **Adopted for slot facts only** (D5) |
| L3 scope by manifest | **Adopted** with the R5 §9 rule (D3) |
| L4 pins habituate | **Adopted**: 400 KB distance + cue; a guard match re-delivers (to Claude after the call, to the user before it via `ask`) (D25, D19) |
| L5 never delete except forget / purge | **Adopted** with full purge coverage (D13) |
| L6 no embeddings on Submit | **Kept, on measured grounds** (D15), with an explicit re-open rule |
| L7 ranking | **BM25F + bounded kind prior**; activation deferred to earn-in (D17, D32) |
| **L8** only slot facts supersede by key | **Adopted** (D6). Policies supersede only by explicit revocation or opposite polarity; episodes never |
| unchanged | fail-open; silence default; no LLM on any hook's hot path; ≤ 6 bullets / 900 B; no `memory_search` loop; sleep may use models |

New in v2: **Eden may affect control flow only through the PreToolUse `ask` guard** (D19). It never denies and never blocks prompts; in `dontAsk` and `bypassPermissions` it downgrades to context only.

---

## 10. Worked example (grounded in R6's real patterns)

1. **Session 1** (repo A), the user types: "fix the flaky auth test, push to the PR but **don't merge it yourself**".
   - This is a single unqualified mention, so it is a policy **candidate** keyed `(integrate, neg, *)`.
   - The agent later runs `gh pr merge`. `integrate` is irreversible, so the guard asks: *"Eden: rule you set (today): pull requests are merged by you, not by the agent."* The user declines. **Nothing had to be repeated.**
2. **Session 3** (repo A): "open the PR but don't merge".
   - This is `policy_recur`: the same `(integrate, neg, *)` key in a second session, so it is promoted to a pin at `""`.
   - Session 5, "don't open the PR **yet**": qualified, so it stays an intent (it asks on `gh pr create` until the PR is opened or 7 days pass) and is never promoted.
   - From then on it is delivered at most once per 400 KB of context, on integrate or complete cues, and always at the guard.
3. **Repo B, a week later:** "remember, never merge PRs yourself".
   - The pin now exists in 2 repos, so the next SessionStart shows *"Proposed for all projects: pull requests are merged by you (say 'yes, everywhere' to keep)"*. Once confirmed, repo C never needs to be told.
4. **Session 4** (repo A): the agent edits `packages/cli/src/db.ts`.
   - This is the first touch of `packages/cli` this epoch, so PostToolBatch delivers `Database in packages/cli: sqlite (from pnpm-lock/…, cited)`.
   - The user had never typed it; it was mined from the manifests (D8).
5. **Same session:** `pnpm test` fails with `ERR_REQUIRE_ESM`.
   - PostToolUseFailure delivers the gotcha from last month. The agent applies the known fix.
6. **User says "continue"** (13% of real prompts).
   - Turn mode is `ack`: the previous assistant message was a report, not a proposal. Nothing new is gated in, and the ledger shows everything relevant is already in context, so there is **no packet**. Today's hook injects 6 bullets here.
7. **A background task notification arrives** as a submit. Silent.
8. **Auto-compaction.**
   - `compact_summary` still mentions sqlite, so that fact stays habituated.
   - The summary dropped the merge rule, so the rule is re-armed and returns on the next integrate cue.
