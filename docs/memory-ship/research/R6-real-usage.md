# R6 — Real usage: what one developer's own Claude Code transcripts say about A4

**Dated 2026-09-29.** Inputs: `~/.claude/projects/*/*.jsonl` (40 main transcripts, 9 project dirs) and 327 subagent transcripts (`<session>/subagents/agent-*.jsonl`). Read-only, local. Scripts: `scratchpad/transcripts/{schema,analyze,analyze2,analyze3}.py` (session scratchpad, not committed). Contract under test: `A4-DELIVERY-CONTRACT.md`; metrics vocabulary: `A5-EVALUATION.md`.

Only aggregates are reported. No prompt is quoted verbatim; examples are paraphrased. Two prompts contained pasted credentials; they are counted, not reproduced.

---

## 0. Headline

| # | Finding | Number | A4 decision it hits |
|---|---|---|---|
| 1 | Human prompts are **rare**; the agent does the work | 178 human prompts in 40 sessions (median 3/session); median 12 tool calls and 7.5 min of agent work per prompt, p90 598 tool calls / 2.3 h | epoch ceiling, turn counter |
| 2 | Most `UserPromptSubmit` events are **not humans** | 63% of submits are task-notifications / peer messages; 76% of Eden UPS injections fired on non-human submits | turn counter, silence gate |
| 3 | The installed Eden hook **repeats itself** | 55.8% of injected bullets are exact repeats earlier in the same session (54.8% within the same epoch); 60% near-repeats | refractory rule (G5) |
| 4 | …and **over-spends** | median 4.3k Eden tokens/epoch, 10 of 24 epochs > 6k, max 79k in one epoch | session budget |
| 5 | …and is **not silent on chatter** | 18 of 23 "continue"-type prompts got a packet (silence precision 0.22) | silence gate |
| 6 | Compaction is **rare**: 1 in 40 sessions, at 619k tokens (1M-context model), after 136 submits (22 human) | turns-between-compactions n=1 | epoch ceiling of 60 |
| 7 | Place from main-thread Read/Edit/Write/Grep/Glob in the last 3 turns: **35%** of prompts; with subagent tool calls **70%** | 51/144 vs 101/144 | place-from-tool-paths |
| 8 | 40% of `file_path` tool inputs are **outside the session cwd**; 9% are in git worktrees | 2,491 / 6,290; 590 | place resolution, repo identity |
| 9 | Copula-shaped durable facts are **~0.5%** of human-authored sentences | 1 of ~205 | copula extractor coverage |
| 10 | Restatement exists but is **policy**, not facts: "don't merge / don't open the PR yet / do it on a branch" recurs across ≥4 sessions of one repo | ~8 cross-session policy recurrences per 100 prompts (upper bound) | restatement classes |

---

## 1. Methodology

### 1.1 JSONL schema (as observed, Claude Code 2026-09)

| `type` | Count | Notes |
|---|---|---|
| `attachment` | 85,679 | `attachment.type`: `hook_success` 69,120 (PreToolUse, PostToolUse, PostToolBatch, Stop, SessionStart, SubagentStop — with `command`, `stdout`, `durationMs`); **`hook_additional_context` 358** (UPS 339, SessionStart 19); `hook_system_message` 26; plus `skill_listing`, `nested_memory`, `edited_text_file`, `date_change`, `total_tokens_reminder`, … |
| `assistant` | 47,624 | blocks: `tool_use` 29,541, `thinking` 14,048, `text` 4,044. `message.usage` gives input + cache-read + cache-creation tokens (context size proxy) |
| `user` | 30,800 | 29,537 are `tool_result`. Non-tool user entries carry `origin.kind` ∈ {`human`, `task-notification`, `peer`} and `promptSource` ∈ {`typed`, `queued`, `system`}; `isMeta` for caveats/skill bodies |
| `system` | 837 | `turn_duration` 401, `stop_hook_summary` 356, `away_summary` 49, `local_command` 27, **`compact_boundary` 1** (`compactMetadata.trigger/preTokens/postTokens`) |
| other | ~9k | `queue-operation`, `last-prompt`, `mode`, `permission-mode`, `ai-title`, `file-history-*`, `pr-link`, `cost-state` |

Hook `additionalContext` is persisted as an `attachment` of type `hook_additional_context` whose `content` is the injected string (Eden packets start `Eden Memory:\n- …`). It is written after the triggering user entry. There were no `Eden Know` packets.

### 1.2 Definitions

- **Human prompt**: non-tool-result `user` entry, not `isMeta`, not `isCompactSummary`, `origin.kind ∉ {task-notification, peer}`, not a local-command echo, caveat, or `[Request interrupted…]`. Skill invocations (`<command-message>`) count, using their args as text (6% of prompts). This session's own prompts are included (3 prompts).
- **Turn**: the interval from one human prompt to the next. Tool calls from subagent transcripts are assigned to turns by timestamp.
- **Epoch**: bumps at an Eden `SessionStart` hook run (startup/resume/clear), `compact_boundary`, or `/clear`.
- **Scope proxies**: `scope2` = first two directory segments relative to the session cwd; `manifest` = nearest ancestor directory with `package.json`/`Cargo.toml`/`pyproject.toml`/`go.mod` (A4 §2.1). Paths outside the cwd are dropped (see finding 8).
- **Tokens** ≈ chars / 4.
- **Text heuristics**: regexes for paths, identifiers, chatter, directives, corrections, frustration; the sentence classes were then hand-checked (§7).

### 1.3 Caveats

- **Single user, 40 sessions, 178 prompts.** Eden repo: 4 sessions, 32 prompts. Every rate below has wide error bars. Treat them as direction and order of magnitude, not as calibration.
- This user works **agent-heavy**: auto mode, many background subagents, long turns. A chat-style user would give very different turn counts.
- The Eden hook changed across these weeks. The §4 numbers describe the **versions that were installed**, not the A4 design.
- Heuristic detection under-counts paraphrased restatements and over-counts keyword categories. §6 gives both a strict (lexical) and a loose (category) bound.
- The "used" proxy for injected bullets is **not usable**: rare-token overlap with the following agent actions is 67% against a 54% baseline that uses the actions of a random other session.

---

## 2. Sessions, turns, compaction, resumes

| Metric | All projects | Eden repo |
|---|---|---|
| Main transcripts / with ≥1 human prompt | 40 / 34 | 4 / 4 |
| Human prompts | 178 | 32 |
| Human prompts per session (p25 / p50 / p75 / p90 / max) | 1 / 3 / 7 / 10 / 24 | 3 / 4 / 4 / 24 / 24 |
| **All submits** per session (human + task-notification + peer), p50 / p90 / max | 6 / 30 / 139 | — |
| Share of submits that are not human | **63%** | — |
| Sessions with > 60 submits (A4 epoch ceiling) | 1 of 33 | 1 of 4 |
| Main-thread tool calls per session (p50 / p90) | 33 / 188 | 101 / 480 |
| Subagent tool calls per session (p50 / p75 / p90) | 44 / 1,311 / 2,714 | 1,039 / 1,039 / 3,559 |
| Tool calls per human turn incl. subagents (p50 / p75 / p90) | 12 / 144 / 598 | 44 / 333 / 499 |
| Wall duration, h (p50 / p75 / p90 / max) | 0.9 / 28 / 95 / 155 | 17.6 / 17.6 / 77 / 77 |
| Active duration, h (gaps capped at 30 min) (p50 / p90 / max) | 0.5 / 3.5 / 9.3 | 1.5 / 9.3 / 9.3 |
| Context tokens at prompt (p50 / p90 / max) | 163k / 523k / 613k | 377k / 608k / 613k |
| Context growth per human prompt (p25 / p50 / p75 / p90) | 6k / 15k / 41k / 72k | 7k / 15k / 71k / 73k |
| Compactions (`compact_boundary`) | **1** (auto; 619k → 16k tokens; after 22 human prompts and 136 submits in total) | same one |
| `/clear` / `/resume` commands | 8 / 2 | 0 / 0 |
| Sessions with > 1 SessionStart (resume/clear) | 6 | 1 |
| Epochs per session (our definition) (p50 / max) | 2 / 5 | 2 / 5 |
| User interrupts (`[Request interrupted…]`) | 20 (11 per 100 prompts) | 5 |

**Reading.** Sessions are few-prompt and many-tool. The models in use have 1M-token windows. Compaction happened once, at 619k tokens. "Turns between compactions" has n=1, so it cannot be estimated. What *can* be measured is context growth per human prompt: median 15k, p90 72k. At a 200k window with a ~160k threshold, that means compaction after roughly 4–10 human prompts. At 1M, after roughly 20–40. Either way it is **tokens, not turns**, that predict compaction.

---

## 3. Prompt shape

| Metric | All (n=178) | Eden (n=32) |
|---|---|---|
| Length, chars (p10 / p25 / p50 / p75 / p90 / p99) | 8 / 23 / 65 / 139 / 240 / 785 | – / 8 / 40 / 163 / 478 / 785 |
| Length, words (p50 / p90) | 12 / 42 | 7 / 66 |
| Contains a file path | 11.8% | 12.5% |
| Contains an identifier (backticks, camelCase, snake_case, `foo()`, `--flag`, `x.ts`) | 10.1% | 6.3% |
| Path **or** identifier | **18.0%** | 12.5% |
| Chatter (`continue`, `ok`, `yes`, …) | **12.9%** (every one was "continue") | **34.4%** |
| ≤ 3 words | 24.2% | 37.5% |
| Skill / slash-command invocation | 6.2% | 9.4% |
| Contains a URL | 2.8% | 3.1% |
| > 1,000 chars (pasted logs/code) | 1.1% | 0% |
| Contains a credential-shaped string | 2 prompts (1.1%) | 0 |

**Silence opportunities.** At minimum, the 13% (Eden: 34%) chatter prompts. The larger lever is non-human submits: 63% of all `UserPromptSubmit` events are background-agent task notifications and peer messages (§4.2).

---

## 4. Hook-injected content: what the installed Eden hook actually did

Source: 358 `hook_additional_context` attachments that start with `Eden Memory:` (339 UserPromptSubmit, 19 SessionStart) across 18 sessions. There were no `Eden Know` packets. Other hooks (cmux, parsec, a `whatever` PreToolUse gate) only wrote `hook_success` stdout or `hook_system_message` and injected no memory.

### 4.1 Redundancy and cost

| Metric | All | Eden repo (3 sessions) |
|---|---|---|
| Packets / bullets | 358 / 2,122 | 186 / 1,116 |
| Bullets per packet | 6 in 352 of 358 packets (fixed k) | 6 |
| Chars per packet (p50 / p90 / max) | 2.3k / 6.5k / 6.9k | — |
| **Exact repeat of a bullet earlier in the same session** | **55.8%** (1,185) | **70.3%** (784) |
| Exact repeat within the same epoch | 54.8% (1,162) | 69.2% |
| Near repeat within the same epoch (token Jaccard ≥ 0.8) | 60.2% (1,278) | 72.9% |
| Bullet's opening 60 chars already verbatim in the prior transcript | 17.2% (365) | 14.2% |
| Noise-shaped bullet (markup, tool/terminal output, harness boilerplate, negation-normalisation artifacts like "never no") | **51.6%** (1,096) | 66.3% |
| Distinct bullets that appear in ≥ 2 sessions | 56 of 857 | — |
| Eden tokens per session (p50 / p75 / p90 / max) | 6.1k / 20k / 40k / **92k** | three sessions: 0.6k, 29k, **92k** |
| Eden tokens per epoch (p50 / p75 / p90 / max) | 4.3k / 11k / 40k / **79k** | — |
| Epochs over the 6k budget | **10 of 24** | 3 of 6 |
| "Used" proxy (≥ 2 rare bullet tokens in the next agent actions) | 67%, against a **54%** random-session baseline, so uninformative | — |

### 4.2 What triggered the packets

| Submit that preceded the UPS packet | Packets | Share |
|---|---|---|
| Background task-notification | 183 | 54% |
| Human prompt | 80 | 24% |
| Queued mid-turn (attributed to a tool_result) | 54 | 16% |
| Peer / agent message | 19 | 6% |
| Meta | 3 | 1% |

- Hooked sessions contained 149 human prompts. 81 of them (54%) received a packet.
- **18 of 23 "continue" prompts received a packet**, so silence precision on chatter is 0.22 (A5 gate: 1.0).
- Duplicates concentrate in long background-agent sessions. The worst session had 164 packets for 24 human prompts.

**Takeaway.** The failure A4 targets (G5 "never repeat") is real and large on this machine: more than half of all injected bullets were repeats. The dominant cause is **not** long human conversations. It is the hook firing on every task-notification submit and packing a fixed 6 bullets each time.

---

## 5. Place availability from tool paths (A4 §2.2)

The window is the tool calls in the previous 1 or 3 human turns. "Main" means main-thread `Read/Edit/Write/MultiEdit/NotebookEdit/Grep/Glob`. "+sub" adds the same tools from subagent transcripts. The Eden hook's PostToolUse and PostToolBatch **do fire inside subagents**: 290 subagent transcripts carry them. n = 144 prompts that have a previous turn (Eden: 28).

| Window | Prompts with ≥ 1 in-repo path | Window spans > 1 top-level dir | > 1 `scope2` | > 1 manifest scope | Majority `scope2` share (p50 / mean) | Prev-window majority predicts **this** turn's scope: `scope2` / manifest |
|---|---|---|---|---|---|---|
| prev 1, main | 25 / 144 (17%) | 1 / 25 | 7 / 25 | 0 / 25 | 1.00 / 0.88 | 5/9 / 9/9 |
| prev 3, main | 51 / 144 (35%) | 6 / 51 (12%) | 21 / 51 | 0 / 51 | 1.00 / 0.83 | 5/10 / 10/10 |
| prev 3, main + Bash-command paths | 114 / 144 (79%) | — | — | — | — | — |
| prev 1, +sub | 64 / 144 (44%) | 33 / 64 | 44 / 64 | 15 / 64 | 0.75 / 0.72 | 21/36 (58%) / 31/36 (86%) |
| prev 3, +sub | **101 / 144 (70%)** | 60 / 101 (59%) | 79 / 101 (78%) | 23 / 101 (23%) | 0.64 / 0.66 | 22/48 (46%) / **41/48 (85%)** |
| Eden, prev 3, +sub | 26 / 28 (93%) | 18 / 26 | 18 / 26 | 17 / 26 (65%) | 0.98 / 0.89 | 9/13 / 6/13 (46%) |

Other observations:
- **Prompt-named paths** that resolve inside the repo: 21 / 178 prompts (12%). Priority 1 of A4 §2.2 is rarely available.
- **Paths outside the session cwd**: 2,491 of 6,290 `file_path` tool inputs (40%). 590 (9%) are git worktrees (`…-worktrees/…`, `.claude/worktrees`). One project dir (`~/Downloads`) did all its work in a repo one level down. A cwd-relative scope drops all of these, and a cwd-keyed store **splits one repo into two memories**. The same PR-policy instruction was restated from both cwds (§6).
- **Ties** in the majority scope are rare: 7 of 51 main windows, 0 with subagents.

### 5.1 Mid-turn folder changes (would PostToolBatch delivery fire often?)

A "new-top" batch is a tool batch (one assistant message's tool calls) whose paths hit a top-level folder not seen in the prompt, the previous turn, or earlier in this turn.

| | Main thread | + subagents | Eden + subagents |
|---|---|---|---|
| Turns with path-bearing batches | 27 | 69 | 19 |
| …with ≥ 1 new-top batch | 19 (70%) | 42 (61%) | 11 (58%) |
| New-top batches / all path batches | 22 / 97 (23%) | **80 / 3,072 (2.6%)** | 20 / 539 (3.7%) |
| New-top batches per turn (p50 / p90 / max) | 1 / 1 / 4 | 1 / 3 / 6 | 1 / 2 / 5 |

A scope-change trigger on PostToolBatch would fire **about once per turn** (≤ 3 at p90) and on only 2.6% of batches. That makes it cheap enough to allow. Most turns do wander into a new folder, so it is also useful.

---

## 6. Restatement (G1)

**Directive sentences** match `always|never|don't|stop|make sure|remember|instead|prefer|must|should|again|already|…`. There are 48 of them in 38 prompts (21%). About 12 are pasted test output, leaving ~36 human-authored.

| Bound | Method | Cross-session, same project | Rate per 100 prompts |
|---|---|---|---|
| **Strict** | Directive sentences, content-token Jaccard ≥ 0.6 against earlier sessions | **0** (within-session: 2, a re-sent prompt) | 0 |
| Strict, looser | Jaccard ≥ 0.5, any project | 1 | 0.6 |
| Whole-prompt near-duplicates | Jaccard ≥ 0.6 against any earlier session | 6: one long task brief re-sent in 5 later sessions, one research brief once | 3.4 (retries, not memory misses) |
| **Loose (category)** | Directive-marked sentence in a policy category that already appeared in an earlier session of the same repo | 15 | **8.4** |
| Loose, any request | Same, counting any request sentence in the category | 34 | 19 |
| Explicit frustration markers ("I told you", "as I said", "why did you", "!!", "??", …) | regex | 0 | 0 |
| Explicit "again"-prefixed re-statement | manual | 1 (Eden, research depth) | 0.6 |
| Interrupts (implicit correction) | `[Request interrupted…]` | 20 | 11 |

**Recurring types**, ordered by cross-session recurrences. The categories are paraphrased.

| Type | Mentions | Sessions | Projects | Cross-session recurrences | Scope it belongs to |
|---|---|---|---|---|---|
| **Git/PR workflow policy**: don't merge the PR yourself; push to the PR but don't merge; don't open the PR yet; work on a branch; don't push upstream yet | 28 | 11 | 3 (really 2 repos; one repo reached via two cwds) | **17** | repo `""` pin (merge policy) plus **per-task intent** ("not yet") |
| Tool/vendor choice: use hosted provider A, not local runner B; stack of backend/auth/deploy vendors via their CLIs | 11 | 7 | 4 | 4 | repo (stack), user (no local models) |
| Research depth/breadth: deep research, ≥ 3 benchmarks, don't overfit | 8 | 4 | 2 (Eden-heavy) | 4 | user or repo pin |
| Scope limits: don't touch payment paths; don't start it; don't overcomplicate; only for this run | 8 | 6 | 3 | 3 | mostly **transient** (task intents) |
| Verify thoroughly: check your work again for bugs and security; test end to end before the PR | 13 | 6 | 4 | 2 | **user-global** pin |
| Communication style: explain plainly what you will build; don't hand-wave | 5 | 4 | 3 | 2 | user-global |
| Ambition/UI quality | 9 | 6 | 4 | 2 | user/repo |
| Package manager, paths, commands (the A4 §10 / A5 example class) | **0** | 0 | 0 | 0 | — |

The phrase check agrees. "Don't merge" appears in 4 prompts across 4 sessions of the same repo. "Open/push the PR" appears in 8 prompts across 5 sessions. "Check your work / thoroughly" appears in 10 prompts across 6 sessions and 4 projects. "Deep research" appears in 5 prompts across 4 Eden sessions.

---

## 7. Corrections and sentence classes

### 7.1 Corrections

The regex (`^no,`, `actually`, `wait`, `instead of`, `use X not Y`, `undo`, `revert`, …) produced 5 hits. Two are genuine; the rest are pasted test names. A hand pass over all non-pasted statements found about **6 genuine corrections (3.4 per 100 prompts)**:

| Target | Count | Examples (paraphrased) |
|---|---|---|
| Fact (which entity is current) | 1 | "not that one, the other similarly named one is the newer one" |
| Tool choice ("use A not B") | 2 | use hosted provider A, not local runner B; stop that run, no local models |
| Communication/style | 3 | explain concretely what you're building; you don't need all that, just tell me plainly; the generated media's music is wrong |
| Scope/approach | 2 | undo this work, it's unneeded; make the changes bigger, but only for this run |
| Package manager / path / command | **0** | — |

Separately, 20 interrupts (11 per 100 prompts) are the main real-time correction channel. They carry no text.

### 7.2 What kind of sentence is a user statement? (copula check)

There are 420 sentences across 178 prompts. The heuristic classifier was hand-corrected: 45 terminal/log lines it had marked "statement" were re-labelled "pasted".

| Class | Sentences | Share of all | Share of human-authored (≈ 205) |
|---|---|---|---|
| Pasted log / test output / code / terminal | 215 | 51% | — |
| Request / imperative (incl. "can you…", "let's…") | 151 | 36% | **74%** |
| Question | 29 | 7% | 14% |
| Status / bug report ("X isn't working", "tests failed") | 8 | 2% | 4% |
| Preference / constraint statement | 6 | 1.4% | 3% |
| Goal / intent description | 5 | 1.2% | 2.4% |
| Ack / permission ("yes, allowed") | 5 | 1.2% | 2.4% |
| **Copula-shaped durable fact ("X is Y", "we use Y")** | **1**, and it is a goal, not a repo fact | 0.2% | **0.5%** |

Durable knowledge does appear, but **inside imperatives**:
- 13 requests carry a negative constraint ("…, don't open the PR yet").
- 4 embed a stack or tool choice ("create a project using A for backend, B for auth, C for deploy"; "use A, not B"; "use account X for GitHub").

By prompt, the dominant class is request 49%, statement or pasted 21%, chatter 13%, question 11%, and empty skill invocation 6%.

---

## 8. Timing (idle windows for sleep; session length)

| Metric (minutes) | p10 | p25 | p50 | p75 | p90 | p99 |
|---|---|---|---|---|---|---|
| Gap between human prompts | 0.6 | 5.4 | 29 | 140 | 659 | 4,057 |
| Agent work per turn (prompt → last activity) | 0 | 0.7 | 7.5 | 61 | 136 | 710 |
| **Idle** (last agent activity → next prompt) | 0.1 | 0.5 | **4.0** | 41 | 396 | 4,054 |

| Idle ≥ | 1 min | 2 | 5 | 10 | 30 | 60 | 240 |
|---|---|---|---|---|---|---|---|
| Share of inter-prompt gaps (all) | 67% | 62% | **47%** | 40% | 27% | 20% | 13% |
| Eden | 64% | 61% | 46% | 46% | 39% | 21% | 14% |

Sessions stay open for days: wall p75 is 28 h against 1.5 h active. The agent is often still working, through background subagents, long after the prompt. **Idle has to be measured from the last tool or assistant activity**, not from the last prompt. Measured that way, a ≥ 5-minute idle window occurs in about every second gap.

---

## 9. Implications for A4 decisions

### 9.1 What counts as a "turn" (affects every refractory value and the 60-turn ceiling)
- **Evidence:** 63% of submits are task-notifications or peer messages, and 76% of installed-hook packets fired on them.
- **Change:** `turn++` only when the submit is human: `origin.kind == human`, or the hook payload's prompt does not start with `<task-notification`/`<agent-message`.
- Non-human submits get **silence** by default. They may carry at most `[updated]` or violation dishabituation.
- This is the largest single G5 lever on this machine. Without it, a background-agent session burns 5× the turns and 5× the tokens.

### 9.2 Ledger refractory values
- **Evidence:** 56% exact and 60% near repeats within an epoch in the installed hook.
- **Keep:** "drop copula/procedure/episode if delivered this epoch at the same `ver`". This alone removes over half of today's bullets.
- `cid` must hash **normalised content** (A4's "same fact through two rows habituates once"). About 5 points of the repeats (60.2% near vs 54.8% exact) are near-duplicates with different text.
- **Pin refractory 20 turns:** median session has 3 human prompts (p90 10, max 24). Counted in human turns, 20 means "once per epoch" for ~95% of sessions. That is fine, but it should then simply be documented as once per epoch, plus violation re-injection. If turns included notifications, 20 would be about 7 human prompts, which contradicts the intent.
- **Intent refractory 5 turns:** 5 human turns exceeds the median session (3), so it is effectively once per session. Acceptable. Consider an expiry keyed on the **task finishing** (a PR opened or pushed) rather than a turn count, because "don't open the PR yet" style constraints are transient (§6).

### 9.3 Epoch ceiling of 60 Submits
- **Evidence:** only 1 of 33 sessions exceeded 60 submits of any origin, and none exceeded 60 human prompts (max 24). The one real compaction came at 22 human prompts / 136 submits / 619k tokens.
- Context grows about 15k tokens per human prompt (p90 72k). On a 200k window, compaction lands after about 4–10 human prompts, long before 60. On 1M, it lands at around 20–40 human prompts. The ceiling is therefore **inert in the common case and mis-timed in the rare one**.
- **Change:** make the fallback token-based.
  - Bump the epoch when `transcript_path` shrinks (already in A4).
  - Bump when a `compact_boundary` line appears after the last seen offset: cheap tail scan, no hook dependency.
  - Optionally bump when the last `message.usage` context has dropped by more than 50%.
- Keep "60 **human** turns" only as a last-resort safety net.

### 9.4 Place from tool paths
- **Evidence:** main-thread Read/Edit/Write/Grep/Glob over the last 3 turns gives place for only **35%** of prompts. Adding subagent tool calls gives **70%** (Eden 93%). Adding Bash-command paths gives 79%. Paths named in the prompt give only 12%.
- **Changes:**
  1. PostToolUse/PostToolBatch in **subagents** must write `last_paths` into the parent session's ledger. They fire there today. Verify that the subagent payload carries the parent `session_id` (R0).
  2. Resolve every path to its **own repo/worktree root** (git toplevel), not the cwd. 40% of paths are outside cwd and 9% are in worktrees. Key the store by repo identity (remote URL or first commit), so a repo reached from a parent cwd or a worktree shares one memory. Otherwise the store split *manufactures* restatements. The PR-policy class was restated from both cwds.
  3. Use the **manifest scope** (A4 §2.1), not a path-prefix proxy. The previous-window manifest majority predicts the current turn's manifest scope 85% of the time; `scope2` manages 46%. Multi-scope windows drop from 78% to 23%.
  4. In large monorepos (Eden: 65% of windows span several manifest scopes, and prediction falls to 46%), weight **main-thread and most recent** paths above subagent fan-out. Otherwise fall back to the common ancestor as A4 says. Ties are rare (0–14%).
- **Mid-turn delivery:** a scope-change trigger on PostToolBatch fires about once per turn (p90 3) and on only 2.6% of batches, so it is affordable. Give it its own small share of the epoch budget, and apply the same refractory rules.

### 9.5 Silence rate
- **Evidence:** chatter is 13% of prompts (Eden 34%, all "continue"). Only 18% of prompts carry a path or identifier. The installed hook's silence precision on chatter is **0.22** (gate 1.0).
- **Expected A4 behaviour:**
  - Silence on 100% of non-human submits (63% of all submits).
  - Silence on ≥ 13–34% of human prompts from `isNoopCue`.
  - Silence on a further large share from the FOK gate, because few prompts carry rare cue tokens.
- A realistic target is a packet on ≤ 25% of human prompts, against 54% today.
- "Continue" often follows an interrupt, a resume or a rate limit. Re-briefing belongs to the epoch bump at SessionStart, not to the chatter prompt.

### 9.6 Restatement classes (A4 §7)
- **Evidence:** the A4/A5 example class (package manager, path, command facts) had **0** restatements. Restatements here are **workflow policies and working norms**: git/PR merge policy, verify-thoroughly, research depth, communication style. Strict lexical recurrence is ~0/100 prompts; category recurrence is ~8/100 prompts.
- **Changes:**
  1. Restatement detection must cover **negative imperatives embedded in task prompts**, not only copula values. A5's `restate_rate` detector (value parse or pin Jaccard ≥ 0.8) would read ~0 on this data while the user is in fact repeating themselves.
  2. Add a **`policy`** class to A4 §7. A negative imperative about a workflow action (merge, push, open PR, delete, deploy) that appears in ≥ 2 sessions of one repo is promoted to a user-authored pin at `""`. A single mention stays an **intent** with task-scoped expiry. Many are "not *yet*", and pinning them would go stale (G2).
  3. Norms that recur across ≥ 2 **projects** (verify thoroughly, explain plainly) belong in a **user-global** scope above the repo root. A4 has no such scope today.
- The `scope_miss` / `not_retrieved` / `retrieved_ignored` split cannot be measured from this data, because the installed hook never packed a user-policy bullet that could have been ignored.

### 9.7 Copula extractor coverage
- **Evidence:** copula-shaped durable facts are **0.5%** of human-authored sentences (1 of ~205, and that one is a goal). Durable facts arrive as:
  - (a) tool choices embedded in imperatives: "using A for backend, B for auth"; "use A not B"; "use account X for GH" (4);
  - (b) negative constraints (13);
  - (c) a which-entity correction (1).
- A copula-only extractor would capture roughly **none** of this user's durable knowledge.
- **Changes:**
  - Add patterns for `using|use|with A for B` → `(B, provider, A)`.
  - Add `use A (not|instead of|rather than) B` → set A and invalidate B.
  - Treat `don't|never <verb> <object>` as pin or intent candidates (§9.6).
  - Keep A4 §3's authority rule: 52% of today's injected bullets are assistant or tool text echoes, markup and harness boilerplate. Negation normalisation leaks ("never no", "one 1") into rendered bullets. Render the original surface text.
  - Repo facts (package manager, stack) are better mined from **tool evidence** (lockfiles, manifests) than from chat. This user almost never states them.

### 9.8 Session token budget (6k per epoch)
- **Evidence:** today the median is 4.3k per epoch, but p90 is 40k, the max is 79k, and 10 of 24 epochs exceed 6k. Packets are a fixed 6 bullets, about 570 tokens each.
- Applying only three A4 rules multiplicatively leaves about 8% of today's volume:
  - (i) silence on non-human submits;
  - (ii) silence on chatter;
  - (iii) same-epoch refractory.
- Under that estimate the median epoch drops to about 0.35k, p90 to about 3.2k and the max to about 6.3k.
- **6k is therefore right-sized as a guard.** It would bind only in the heaviest background-agent session. 6k is also only 1–4% of context at prompt (median 163k), so a tighter number buys little. Keep 6k, and make k (bullets per packet) variable: stop at the first empty stage rather than filling 6.

### 9.9 Sleep windows
- **Evidence:** idle ≥ 5 min (measured from the last agent activity) occurs in 47% of inter-prompt gaps, and ≥ 30 min in 27%. Sessions live for days (6 of 34 resumed or cleared).
- An idle trigger of 5 min after Stop plus a quiet transcript fires on about every second prompt, which is enough for per-session consolidation.
- Heavy sleep (alias maturation, promotion) can wait for ≥ 30 min, or SessionStart of the next session. Never trigger on the time since the last prompt: agent turns run a median 7.5 min and a p90 of 2.3 h.

---

## 10. Reproduction

In the session scratchpad `transcripts/`, run:
1. `schema.py` — schema census;
2. `analyze.py` — parse, turns, place, injections → `sessions.json`, `private_*.json`;
3. `analyze2.py` — distributions → `results.json`;
4. `analyze3.py` — sentence classes and restatement categories → `results3.json`.

`private_*.json` holds raw prompt text and must not leave the machine. Section 7's hand labels were applied over `private_labels.json` (93 items).
