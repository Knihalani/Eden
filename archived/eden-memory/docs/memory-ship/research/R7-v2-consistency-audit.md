# R7 — Consistency and accuracy audit of the v2 design set

**Dated 2026-09-29.** Audited: `DECISIONS.md`, `A4-DELIVERY-CONTRACT.md` (v2), `A7-CUES.md`, `A5-EVALUATION.md` (v2), `A6-TRUST-AND-SAFETY.md` (v2), `ROADMAP.md` (v2), against R0–R6, A1–A3, the raw hooks page (`scratchpad/hooks.md`, grepped; line numbers below are `hooks.md:N`), the raw permission-modes and sub-agents pages (fetched raw this run into the same scratchpad: `permission-modes.md`, `sub-agents.md`), and the code (`plugins/eden-memory/`, `packages/cli/src/memory-hook.ts`, `src/`).

The v2 docs were **not** edited. Every finding gives the location, the evidence, and paste-ready fix text.

Severity:
- **S0**: cannot be built as written, or the design breaks one of its own invariants (G1–G5, "never deny").
- **S1**: wrong behaviour in a common case, an internal contradiction a builder must resolve, or a gate the evidence does not support.
- **S2**: a misquote, a stale reference or a naming drift.

---

## 0. Summary

| # | Sev | Finding | Where |
|---|---|---|---|
| 1 | S0 | SubagentStart's payload has **no task prompt**, so "scope from paths in the task prompt" cannot be computed | D23, A4 §5.3, A5 `subagent`, P2.5 |
| 2 | S0 | PreToolUse `additionalContext` arrives **after** the tool runs, and the `ask` reason is shown to the **user only**. In `dontAsk` mode an `ask` becomes a **deny**, and in `bypassPermissions` it is almost certainly skipped. The guard, the "violation re-delivers" rule and the procedure lane rest on the wrong timing | D19, A4 §3.1, §4, §5.4, §9 L4, A6 §2.5, P2.3, P4.6 |
| 3 | S0 | Promotion keys on **class + polarity only**. Two "don't open the PR **yet**" turn into a permanent pin, and "don't delete X" plus "don't delete Y" turn into a user-global `ask` on every `rm -rf` | D9, D11, A4 §3.1, §7 `policy_recur`, P2.4 |
| 4 | S0 | Intent `ask` scope contradicts itself, `push-upstream` is not a defined class, and `git push` is context-only (after the fact) | D19 vs A4 §3.1/§5.4 vs A5 `intent-expiry`; A7 §5 |
| 5 | S0 | The guard cannot be registered as specified. Plugin `hooks.json` is static, `if` holds one rule per handler and is best-effort, and the handler is not told which pattern matched | A7 §5 (`pretool_if`, user-defined classes), D18, D19 |
| 6 | S0 | `q_prev`, `hturn` and the ledger fold depend on an **async** Stop. That races the next Submit, and Stop never fires on an interrupt (11/100 prompts, often right before "continue") or in subagents | A4 §4, §5.1, §5.7, D16, D25, D34 |
| 7 | S0 | The rewind check at Submit cannot work. The current prompt is not in the lagging transcript yet, a 32 KB tail holds less than one median turn (30 KB), and `att` is unknown when a delivery is made | A4 §3.3, §4, D25, A5 `rewind`, P0.6/P1.2 |
| 8 | S1 | "continue" is both chatter (silence required) and a continuation (retrieve from `q_prev`) | A4 G3, §10.6; A5 `silence`(b), `continue`, `continuation`; A7 §2; P0.2 |
| 9 | S1 | The D7 slot patterns re-open A1 D10 ("auth is broken" → `auth.provider=broken`), drop the bare `use V` pattern, and drop `default_scope` (R3 F10) | D7, A4 §3.1–3.2, A6 §2.6, P3.3 |
| 10 | S1 | Non-human detection: the payload has no `origin` field. The "76% non-human" figure includes 16% queued **human** prompts, and cron/loop prompts carry no wrapper | D24, A7 §2, DECISIONS §0, ROADMAP, A5 §5 |
| 11 | S1 | Subagent windows: `transcript_path` is the **main** transcript, fork subagents inherit the parent's packets, and subagent paths moving the parent's place contradict the A5 arm | D2, D4, D25, A4 §2, §4, A5 `subagent` |
| 12 | S1 | `ctx.json` / `hwm.json` are read-modify-write files with many concurrent writers | A4 §1, §3.3, §5.5, §5.7 |
| 13 | S1 | The shadow set is per repo, but instruction loading is per window | A4 §1 layout, D27 |
| 14 | S1 | The `cid` scheme has no repo, changes on intent→pin promotion, and double-prefixes `P:` | A4 §4, A7 §5, A4 §10 |
| 15 | S1 | `ignored` labels feed τ refit negatives, yet A4 says labels "never gate delivery"; R6 says the label is uninformative | A4 §8, A7 §4, D17 |
| 16 | S1 | The P4.3 gate (recall ≥ 0.55 at FIR ≤ 5%) was never reached by any lexical method in R1 | ROADMAP P4.3, A4 G3 |
| 17 | S1 | Addendum A's costs are dropped: 19% of other positives gain a policy bullet, 1.6 bullets per cue, and the lexicon author saw 12/60 cues | D18, A7 §1 layer 3, ROADMAP, DECISIONS §0 |
| 18 | S1 | Sleep scheduling: heavy sleep at SessionStart blocks Claude's first response, nothing triggers "idle", and async hooks are killed under `-p` | D34, A4 §6 |
| 19 | S1 | D20 misdescribes the plugin's `hookd` path (HTTP, 8 s timeout, *after* in-process) | D20, P6.2 |
| 20 | S1 | FileChanged watches only literal cwd filenames; cited files need `watchPaths` | D31, P3.4 |
| 21 | S1 | Decline tracking has no signal (PermissionDenied does not fire on a manual deny) | A6 §2.5, P2.3 |
| 22 | S1 | A5 requires 0 packets on non-human submits, while D24 allows `Updated:` there | A5 §2 `silence`(a), A4 G3, D24 |
| 23 | S1 | Place weights differ across D4, A4 §2 and P3.2 | D4, A4 §2, P3.2 |
| 24 | S1 | Intents have no re-eligibility distance; a policy's "value tokens" for PostCompact are undefined | D25, A4 §4 |
| 25 | S1 | A gotcha is delivered twice for one failure (PostToolUseFailure **and** PostToolBatch) | D22, A4 §5.5–5.6 |
| 26 | S1 | Dropped from R3 and not replaced: the session-opener `restate` clause, the pin-habituation arm, the `cwd-map` cache, lazy `att`, and SubagentStop labels | D30, A5 §4, A4 §1, §8 |
| 27 | S1 | ROADMAP dependency inversions: P3.2 is gated on `cascade`, which P3.5 builds; P1.3 residual needs the P3.3 slot table | ROADMAP |
| 28 | S1 | D19 and ROADMAP cite R0 for hook facts R0 does not contain | D19, ROADMAP open items, R0 |
| 29 | S1 | Paste stripping ignores the host's own `<pasted_content>` markers | D12, A6 §2.1 |
| 30 | S2 | Misquotes, stale section references, naming drift, unrecorded overrules (§4) | various |

---

## 1. Hook facts: verification table

| Claim used in v2 | Raw doc | Verdict |
|---|---|---|
| PreToolUse `if` uses permission-rule syntax; the process spawns only on a match | `hooks.md:427`: "Only evaluated on tool events… Uses the same syntax as permission rules". `:432`: "holds **exactly one** permission rule. There is no `&&`, `\|\|`, or list syntax". `:448`: "When Claude Code can't determine which commands the Bash input runs, it runs your hook regardless… the `if` filter is **best-effort**". `:446`: patterns that name more than the command "run the hook anyway on `$()`, backticks, or `$VAR`" | **Partly true.** One handler per pattern. Spawns also happen on unrelated commands, so the guard must re-classify the command itself |
| `if` works on plugin `hooks.json` entries | `:414` (handler fields apply to all sources), `:427` (common fields, "apply to all hook types"), `:640-641` (plugin hooks "merge with your user and project hooks", same format), `:373` (plugin MCP names "in a handler's `if` field") | **Supported by the docs**, with no plugin exception. Still needs one live check (§2 #5) |
| `permissionDecision: "ask"` works from a plugin | `:1805`: the prompt shows "`[plugin:<name>]` for a plugin's hook" | **True** |
| `ask` in auto mode | `:1807`: "A hook's `"ask"` also forces a permission prompt in auto mode: the classifier can still deny the tool call, but it can't approve the call silently. **Before v2.1.211**, the classifier could approve a Bash command running outside the sandbox without showing the prompt" | **True from v2.1.211.** The minimum version must be stated |
| `ask` in `bypassPermissions` | `permission-modes.md:549`: bypass "disables permission prompts and safety checks". Its "actions no mode auto-approves" list (`:36-43`) names explicit ask **rules**, not hook `ask`s | **Not documented. Almost certainly skipped** (the call runs without a prompt) |
| `ask` in `dontAsk` | `permission-modes.md:533`: "auto-denies every tool call that would otherwise prompt you" | **An Eden `ask` becomes a deny.** This breaks "never deny" (D19, A6 §2.5) |
| `ask` under `-p` | `permission-modes.md:58`: in `-p` the "calls that would still prompt are denied". `hooks.md:1825`: prompts need a permission host | **Denied** without a permission host |
| The `ask` reason reaches Claude | `:1797`: `permissionDecisionReason` "For `"ask"`, shown to the user **but not Claude**" | **The design assumes otherwise** (L4 "violations re-deliver through the guard") |
| When PreToolUse `additionalContext` reaches Claude | `:1799`: "added to Claude's context **alongside the tool result**". `:1003`: "PreToolUse… next to the tool result" | **After the tool ran.** D19 says so, but A4 §3.1 (procedures), §5.4 ("otherwise context") and L4 still use it as if it came before |
| Multiple PreToolUse decisions | `:1803`: precedence `deny > defer > ask > allow`. `:1007`: every `additionalContext` is delivered | Two matching handlers deliver two contexts |
| PostToolBatch: once per batch, `additionalContext` before the next model call | `:2144`, `:2186`. `tool_response` is the **serialized** model-visible result, with no structured exit code (`:2172-2176`) | **True.** "Exit codes" must be parsed from `Exit code N` text, and success is only "no failure text" |
| PostToolBatch fires in subagents | `:267` names "tool events such as PreToolUse and PostToolUse". PostToolBatch is not named. R6 §5 saw it in 290 subagent transcripts | **Empirically true, not documented.** Keep it as a harness assertion |
| SubagentStart dedupes | `:2376`: "When the hook runs again **for the same subagent**… injects… only when the subagent's context doesn't already hold the copy" | True, but only per subagent re-run (resume, teammate message), never across subagents |
| SubagentStart input carries the task | `:2349`: input is common fields + `agent_id` + `agent_type` | **False: there is no task prompt** (finding 1) |
| PostCompact `compact_summary` | `:3085` | True |
| InstructionsLoaded `load_reason` ∈ {session_start, nested_traversal, path_glob_match, include, compact} | `:1302` | True. It "runs asynchronously" (`:1288`). No event for AGENTS.md read directly (`:1290`) |
| Stop `last_assistant_message`; not on interrupt | `:2526-2538` | True. Also not "guaranteed" in the transcript at Stop (`:2538`) |
| Async hooks: output on the next turn; no timeout; killed at `-p` teardown | `:3684-3692` | True; the `-p` kill is unused in v2 (finding 18) |
| SessionStart sources incl. `fork` | `:1112-1120`. Fork covers `--fork-session`, `/fork`, `/branch`; before v2.1.214 it reported `resume`. The **first response waits** for SessionStart hooks (`:1124-1128`) | True. Waiting matters for D34 |
| 10k cap | `:923-927` | True |
| UserPromptSubmit timeout | `:1329-1331`: 30 s default; on timeout the output is discarded | True |
| Non-human submits trigger UserPromptSubmit | Docs: "Runs when the user submits a prompt" (`:1325`); task notifications are never mentioned. R6 §4.2: 183 packets after task-notification submits, 19 after peer messages | **Empirically yes, undocumented** |
| A payload field distinguishes non-human submits | Input is common fields + `prompt` (`:1337-1349`). `prompt_id` (`:737`) identifies the prompt, not its origin | **None.** Only the prompt text (wrapper prefix), or a match against `session_crons[].prompt` from the last Stop (`:2560`) |
| `transcript_path` inside a subagent | `:2385`: for SubagentStop "`transcript_path` is the **main session's** transcript, while `agent_transcript_path` is the subagent's own" | Distances measured on `transcript_path` are wrong for child windows (finding 11) |
| Pasted text in the prompt | `:1337`: arrives expanded, between `<pasted_content id="…">` lines when paste marking is on | Unused by D12 (finding 29) |

---

## 2. S0 findings

### 1. SubagentStart has no task prompt

- **Where:** D23 ("SubagentStart: ≤ 3 bullets for the task's scope"); A4 §5.3 ("Scope comes from paths in the task prompt"); A5 `subagent` arm; ROADMAP P2.5 ("subagent packets by task scope / agent type").
- **Evidence:** `hooks.md:2349`. SubagentStart input is `session_id, transcript_path, cwd, agent_id, agent_type`. The task prompt exists only in `PreToolUse`/`PostToolUse` on the `Agent` tool (`tool_input.prompt`). That call has a `tool_use_id`, not the `agent_id`. The transcript lags (R0 F8).
- **Fix: replace A4 §5.3 bullet 1 with:**
  > Scope comes from the task prompt, captured by a `PreToolUse` hook matched on `Agent` (no `if`, context-free, < 20 ms), which appends `{tool_use_id, agent_type, prompt_paths, t}` to `windows/<parent>/spawn.log`. At SubagentStart, take the newest unconsumed `spawn.log` entry with the same `agent_type` within 5 s, and mark it consumed under `flock(spawn.log)`. If none matches (parallel launches of one type, or the Agent SDK), use the parent's read set. SubagentStart for a resumed subagent or a teammate message reuses the child window's stored scope.
- **Fix, D23 bullet 3:** "SubagentStart: ≤ 3 bullets for the task's scope (task paths captured at `PreToolUse(Agent)`, A4 §5.3; else the parent's read set)."
- **Fix, A5 §3 item 1:** add `PreToolUse(Agent)` to the harness event list, and assert that two parallel `Explore` launches with different task paths get their own scopes, or both fall back to the parent's.

### 2. The guard's timing, visibility and permission-mode behaviour

- **Where:** D19; A4 §3.1 procedure row ("PreToolUse `if` on the command head (context only)"); A4 §4 "Violation: a PreToolUse guard match re-delivers its policy"; A4 §5.4 "Otherwise → `additionalContext` only"; A4 §9 L4 "violations re-deliver through the guard"; A6 §2.5 "It only asks, never denies"; ROADMAP P2.3, P4.6, open items.
- **Evidence:** `hooks.md:1797`, `:1799`, `:1807`; `permission-modes.md:533`, `:549`, `:58` (table in §1).
  - Context-only guard output lands **after** `git commit` or `pnpm add` has run.
  - An `ask` never tells Claude the rule; a declined `ask` tells Claude only that the call was rejected.
  - In `dontAsk` (and in `-p` without a host), Eden's `ask` is a **deny**.
  - In `bypassPermissions` it is almost certainly skipped.
  - The subagent frontmatter `permissionMode` can differ per subagent (`sub-agents.md:230`, `:579`).
- **Fix: replace D19's bullet list with:**
  > • Every guard response for a live policy or intent returns `additionalContext` with the declarative rule (D14). It arrives **next to the tool result** (`hooks.md:1799`), which tells Claude the rule for the retry or the next step, but not before this call. <br>• **Pre-action control** exists only through `permissionDecision: "ask"`. Its `permissionDecisionReason` is shown to the **user only** (`hooks.md:1797`), so the same text also goes in `additionalContext`. <br>• `ask` is returned only when `permission_mode ∈ {default, acceptEdits, plan, auto}` and the class is irreversible, or the item is an intent (§5.4). In `dontAsk`, an `ask` would be converted to a deny (`permission-modes.md:533`), so the guard returns context only. In `bypassPermissions`, `ask` is not honoured (`permission-modes.md:549`), so the guard returns context only and logs `guard_bypassed`. Requires Claude Code ≥ v2.1.211 in auto mode (`hooks.md:1807`). <br>• It never returns `deny`.
- **Fix, A4 §3.1 procedure row, "Delivered by" cell:** "lexical on procedure cues; PostToolBatch when the same command head ran in this batch (context arrives after the command, so it helps the next attempt)". Delete "PreToolUse `if` on the command head (context only)". Apply the same change to ROADMAP P4.6 ("PreToolUse context on the command head" → "PostToolBatch context after the command head ran").
- **Fix, A4 §4 "Violation" bullet:** "**Violation:** a guard match re-delivers its policy as `additionalContext` (seen by Claude after the call) and, where §5.4 allows, as an `ask` (seen by the user before the call)."
- **Fix, A4 §9 L4 Status:** "**Adopted**: 400 KB distance + cue; a guard match re-delivers (after the call to Claude; before the call to the user, via `ask`) (D25, D19)".
- **Fix, A6 §2.5 bullet 1:** append "In `dontAsk` and `bypassPermissions`, the guard downgrades to context-only, so Eden never causes a denial."
- **Fix, ROADMAP open-items bullet 3:** "The guard's `ask` UX: verified from the docs. Auto mode forces a prompt from v2.1.211 (`hooks.md:1807`). `dontAsk` would turn `ask` into deny, so the guard downgrades. In `bypassPermissions` it is skipped. `-p` without a permission host denies. Still to live-check: whether `additionalContext` reaches Claude when the user **declines** an `ask`."
- **Add an A5 arm `guard-modes`:** for each `permission_mode` ∈ {default, auto, dontAsk, bypassPermissions}, assert the guard's JSON (`ask` vs context-only). Assert that no mode produces a deny from Eden.

### 3. Promotion by class and polarity promotes transient and unrelated rules

- **Where:** D9 ("the same class and polarity appearing in ≥ 2 sessions → a policy pin"; "the same pin appearing in ≥ 2 repos → user-global"); D11 ("one user-typed policy class and polarity recurs in ≥ 2 repos"); A4 §7 `policy_recur` ("same class and polarity as a policy **or intent**"); ROADMAP P2.4.
- **Evidence:**
  - R6 §6 row 1: the git/PR category mixes durable rules ("don't merge it yourself") with transient ones ("don't open the PR **yet**", "don't push upstream **yet**").
  - R6 §9.6.2: "A single mention stays an intent… Many are 'not yet', and pinning them would go stale (G2)."
  - A class is coarse. `delete` covers "don't remove the old API" and "don't delete the fixtures".
  - Under D9 as written:
    - two sessions with "don't open the PR yet" produce a permanent `review` pin that asks on every `gh pr create`;
    - two repos with different `delete` objects produce a user-global ask on every `rm -rf`.
  - A6 §2.5's "worst case is one extra prompt" becomes one prompt on every matching command in every repo.
- **Fix, D9: replace the three bullets with:**
  > • A mention with a temporal qualifier (`yet`, `for now`, `until …`, `before …`, `after …`, `this time`, `in this PR`) is **always an intent**, however often it recurs. It expires when its action completes, or after 7 days. <br>• An unqualified mention is a **policy candidate** keyed by `(class, polarity, object)`. `object` is the normalized direct object (for example `pr`, `main`, `migrations`, `.env`), or `*` when the imperative has none ("don't merge yourself"). <br>• A candidate becomes a **pin** when `never/always` is explicit, or when the same `(class, polarity, object)` appears unqualified in ≥ 2 sessions. <br>• A pin is proposed as **user-global** when the same `(class, polarity, object)` pin exists in ≥ 2 repos. It is shown once at SessionStart as `Proposed for all projects: … (say "yes, everywhere" to keep)`, and it is live globally only after that confirmation or an explicit global phrase (D11).
- **Fix, D11:** replace "**or** by auto-promotion when one user-typed policy class and polarity recurs in ≥ 2 repos" with "or by a user-confirmed proposal when the same `(class, polarity, object)` pin exists in ≥ 2 repos (D9)". Add the Overrules cell "R3 F18 and the R3 cut list (auto-classification); reason: R6 §6 shows cross-project norms, and confirmation removes the leak".
- **Fix, A4 §7 `policy_recur`:** "a user-typed, **unqualified** imperative with the same `(class, polarity, object)` as a policy or intent from an earlier session".
- **Fix, A4 §10 step 2:** unchanged ("open the PR but don't merge" is unqualified, with object `*`). Add a step 2b: "Session 5: 'don't open the PR yet'. This is qualified, so it stays an intent and is never promoted."
- **Add rows to the A5 `policy-recur` arm:** "'don't open the PR yet' in 3 sessions → 0 pins"; "'don't delete the fixtures' (repo A) + 'don't remove the old API' (repo B) → no user-global".

### 4. Intent `ask` scope, the `push-upstream` class, and `git push`

- **Where:** D19 ("Intents (a "not yet") also produce `ask`, until they expire"); A4 §3.1 intent row ("guard (`ask`) for irreversible classes"); A4 §5.4 (only irreversible → ask; intents not mentioned); A5 `intent-expiry` ("an ask on `gh pr create`", where `gh pr create` is class `review` in A7 §5, which is not irreversible); D19/A4 §5.4 list `push-upstream` as irreversible, but it is in neither D18's class list nor A7 §5's lexicon or `if` map; A7 §5 maps `git push*` to `commit` (context only).
- **Evidence:** R6 §6: "don't push upstream yet" is one of the recurring policies. With `git push` in `commit`, the guard only adds context after the push.
- **Fix, D18 class list:** insert `push-upstream` after `commit`.
- **Fix, A7 §5 lexicon, add a row:** `| push-upstream | push, push to origin/remote, upload the branch |`. Remove `push` from the `commit` row.
- **Fix, A7 §5 `if` map:** `commit` → `git commit*`. Add a row `| push-upstream | git push*, gh pr merge --auto* |`. `git push --force*` stays under history-rewrite (both handlers fire; see finding 5 for dedup).
- **Fix, A4 §5.4 bullets:**
  > - **Irreversible** class (integrate, push-upstream, deploy, delete, destructive-db, history-rewrite) **or any live intent** → `ask` (subject to the permission-mode rule in D19), reason `Eden: rule you set (<age>): <text>`; the same text also goes in `additionalContext`.
  > - Otherwise (a pin on a reversible class) → `additionalContext` only.
- **Fix, A4 §3.1 intent row, "Delivered by":** "trigger on cue or tool event; guard `ask` on any matching command until it expires (D19)".

### 5. The guard cannot be registered or dispatched as specified

- **Where:** A7 §5 JSON (`"pretool_if": [...]` per policy); D18 ("plus user-defined" classes); D19; A7 §5 "Registered in the plugin's `hooks.json`"; A7 §8 ("startup plus one small file read").
- **Evidence:**
  - Plugin `hooks.json` is a static file in the plugin install (`plugins/eden-memory/hooks/hooks.json`; `hooks.md:640`), so policies created at runtime cannot add `if` entries.
  - `if` holds exactly one rule (`hooks.md:432`), so the §5 map needs ≈ 25 handler objects.
  - Handlers run in parallel (`hooks.md:414`). `git push --force` matches both `Bash(git push*)` and `Bash(git push --force*)`, and `git commit --amend` matches both `commit` and `history-rewrite`: two processes, two contexts.
  - The payload does not say which pattern matched, and `if` is best-effort (`hooks.md:446-448`).
  - The patterns miss common spellings: `rm -fr`, `rm -r -f`, `git push -f`, `git push origin +main`, and MCP merge tools (`mcp__*github*__merge_pull_request`).
  - Also, the guard must find the repo store. D1's git call costs 20–40 ms (R5 §7) unless a persisted `dir → repo` cache exists, and A4 §1's layout has none (finding 26).
- **Fix: replace A7 §5 "Registered in the plugin's `hooks.json`…" with:**
  > **Registration (static).** `hooks.json` ships one PreToolUse handler per `(class, pattern)` in this map, in exec form with the class as an argument (`"args": ["${CLAUDE_PLUGIN_ROOT}/scripts/guard.ts", "--class", "integrate"]`), so each process knows its class without re-parsing. The map is a static superset. Per-policy `pretool_if` and user-defined classes **refine inside the guard**: they narrow, never widen, what a registered pattern catches. A user-defined class whose commands fall outside the shipped patterns is delivered only by the prompt-side trigger and at PostToolBatch. The guard **re-checks** `tool_input.command` against its class's patterns, because `if` is best-effort (`hooks.md:448`). **Dedup across parallel handlers:** each process takes `flock(windows/<win>/guard.lock)` and appends `{tool_use_id, class}` to `guard.log`. The most severe class for a `tool_use_id` emits (history-rewrite > delete > destructive-db > deploy > push-upstream > integrate > others); the rest exit `{}`. **Lookup:** `dirmap.json` (finding 26) gives the repo in < 1 ms. Then read `policies.jsonl`, `intents.jsonl` and `_user/policies.jsonl` filtered by class; each is < 64 KB (cap at 500 live rows per repo).
- **Fix, A7 §5 `if` map, extra patterns:** history-rewrite `git push -f*`, `git push *+*`; delete `rm -fr*`, `rm -r*`; integrate adds a matcher `mcp__.*__merge.*` (tool-name matcher, no `if`).
- **Fix, A7 §8 guard line:** "The PreToolUse guard runs on `if`-matched commands **and** on commands Claude Code cannot parse (`$()`, `$VAR`): startup, a `dirmap.json` read, and ≤ 3 small file reads."

### 6. Async Stop carries state the next Submit needs

- **Where:** A4 §5.7 (Stop, async: persist `q_prev`, fold `delivery.log`, light sleep); D25 ("snapshots at Stop"); D34 (light = async Stop); A4 §4 schema (`hturn` in `delivery.json`); A4 §5.1 step 1 (`hturn++`); D16/A7 §3 (`q_prev` "persisted at Stop").
- **Evidence:**
  - An async hook does not block (`hooks.md:3684`), so the user's next prompt can reach Submit before Stop's process has written `q_prev`. R6 §8: idle p10 is 0.1 min, and "continue"/"yes" replies are the fastest.
  - Stop "Does not run if the stoppage occurred due to a user interrupt" (`hooks.md:2526`). Interrupts are 11 per 100 prompts (R6 §2), and R6 §9.5 says "continue" often follows an interrupt, which is exactly the continuation case C1 targets.
  - Subagents have no Stop. SubagentStop is not registered in v2.
  - `hturn` lives in the snapshot, which only Stop writes, so no rule says where Submit persists `hturn++`. Two Submits (a queued prompt) can both read the same `hturn`.
- **Fix: add to A4 §5.7 as the first bullet, and split the hook:**
  > **Two Stop handlers.** (1) **Sync** `stop-fast` (< 15 ms, prints `{}`): write `q_prev` tokens (rare tokens of `last_assistant_message` minus the last delivery's tokens) to `windows/<win>/qprev.json` with an atomic rename. (2) **Async** `stop-sleep`: fold, use labels, light sleep. If Submit finds `qprev.json` older than the newest transcript assistant line (an interrupt, or a lost race), it rebuilds `q_prev` from the last **complete** assistant `text` blocks in the transcript tail (≤ 64 KB).
- **Fix, A4 §4 schema and §5.1 step 1:** "`hturn` is not stored in the snapshot. At a **human** Submit, append `{"k":"turn","prompt_id":…,"off":…}` to `delivery.log`. `hturn` = the count of distinct `prompt_id`s among `turn` records (fold). Every `delivered` entry records `ht` (the `hturn` at delivery). The 'last 3 turns' rules (D30, §3.3) compare `ht`."
- **Fix, D25 "Storage":** "…snapshots at Stop **and SubagentStop** under `flock`, written by rename (`delivery.json.tmp` → `delivery.json`). The log is rotated by rename (`delivery.log` → `delivery.log.<n>`) before folding, never truncated in place, so an append that races the fold is not lost."
- **Fix, A4 §5 list:** add "§5.7b SubagentStop (async): the same as Stop for the child window, reading `agent_transcript_path`". Also note that under `SubagentHandback` (auto mode, v2.1.271+), `last_assistant_message` is not the report (`hooks.md:2393`); read `tool_input.message` from PostToolUse on `SubagentHandback` for use labels.

### 7. The rewind check at Submit cannot see the rewind

- **Where:** A4 §3.3 "Rewind … at Submit, walk `parentUuid` inside the last ≤ 32 KB … If the new prompt's ancestry does not reach `hwm.last_uuid`"; A4 §4 (`att`: "`<uuid>`"; `leaf`); D25 "Rewind"; ROADMAP P0.6, P1.2; A5 `rewind`.
- **Evidence:**
  - At Submit the new prompt's line is usually **not yet** in the transcript (R0 F8; `hooks.md:737`).
  - R3 E5: bytes appended per turn are p50 30 KB, p90 250 KB. A 32 KB tail reaches the previous typed prompt only about half the time. The rest are "inconclusive", which drops the last 3 turns' ledger entries and forces re-injection (a G5 failure on roughly every second turn).
  - `att` is "the uuid of the typed-prompt line it was delivered with", but no payload carries that uuid. `prompt_id` is an OTel id (`hooks.md:737`), not the transcript `uuid`.
  - `leaf` (A4 §4) and `hwm.last_uuid` (A4 §3.3) duplicate one value.
- **Fix: replace the A4 §3.3 "Rewind" paragraph with:**
  > **Rewind** (27% of sessions) is detected by the **delta encoder**, not by a tail walk. The encoder already parses every complete line after `hwm.off`. For each typed-prompt line it records `(uuid, parentPrompt)` in `hwm.json`. `parentPrompt` is the nearest typed-prompt ancestor, found by following `parentUuid` through the lines it has parsed; it keeps a rolling `uuid → parentUuid` map of the last 5,000 lines. A typed prompt whose `parentPrompt` ≠ the previously newest typed prompt is a **branch point**. Every typed prompt between `parentPrompt` and the old newest one is abandoned: rows with `src_uuid` on them move to history (`rewind`), and ledger entries whose `att` is on them are dropped. The encoder runs at Submit (on the lines available), at PostToolBatch and at Stop, so a rewind is caught by the first hook after the line is flushed. There is **no** "inconclusive → drop 3 turns" fallback. If the map cannot resolve an ancestor, the entry is kept (one missed re-injection is cheaper than a repeat on every turn).
- **Fix, A4 §4 `att`:** "`att` = the Submit payload's `prompt_id` at delivery. The encoder maps `prompt_id → uuid` when it meets the typed-prompt line (via the line's prompt id field, or else by the first typed-prompt line after the delivery's `off`). Until then the entry counts as on-branch." Delete `leaf` from the snapshot; `hwm.json` is the only holder.
- **Fix, ROADMAP P0.6 build cell:** replace "rewind check (A4 §3.3)" with "branch-point detection in the delta encoder (A4 §3.3)".

---

## 3. S1 findings

### 8. "continue": chatter or continuation?

- **Where:**
  - A4 G3 ("**0** on non-human submits and chatter"); A5 `silence`(b) ("chatter/ack (must be 0)"); A5 `continue` ("no packet unless a new STRONG item appears"); P0.2 ("Silence on … `ack`/chatter turns").
  - A7 §2 puts `continue, go ahead, yes, do it, proceed` in **continuation** ("cue weight moves to `q_prev`"), not in `ack`. A5 `continuation` ("yes do it" → the vitest-config memory packs). A4 §10.6 ("Turn mode is `ack/continuation`").
- **Evidence:** R6 §3: all 12.9% of chatter prompts were "continue". The same prompts cannot be required silent and also be the C1 recall case.
- **Fix, A7 §2:** move `continue`, `keep going`, `next`, `go on` into `ack` when the previous assistant message is **not** a proposal (it does not end in `?` and has no `shall I|want me to|should I|next I'll|I can`). Keep `yes`, `do it`, `go ahead`, `proceed`, and "≤ 4 content tokens after a proposal" as `continuation`. Add the sentence: "`continuation` injects only on STRONG evidence from `q_prev` (an identifier-shaped token or a keyed slot hit); MEDIUM from `q_prev` alone never admits."
- **Fix, A4 G3 target:** "FIR ≤ 5% on hard negatives; **0** on non-human submits and `ack` turns; `continuation` turns inject only on STRONG `q_prev` evidence".
- **Fix, A5 `silence`(b):** "`ack` turns (A7 §2) must be 0; `continuation` turns are scored by `false_rate`".
- **Fix, A4 §10 step 6:** "Turn mode is `ack` (the previous message was a report, not a proposal)…".

### 9. The slot table is looser than R3 F1, and writes at the wrong scope

- **Where:** D7; A4 §3.1 slot row; A4 §3.2; A6 §2.6 ("User types 'always use pnpm' → slot fact"); P3.3.
- **Evidence:**
  - D7: "An unknown value is accepted only when the subject alias is explicit and the value is a single identifier token." `the auth is broken`, `the database is slow` and `the formatter is annoying` then set `auth.provider=broken`, and so on. That re-opens A1 D10 (status/identity collision).
  - R3 F1 required the value to be in `value_class` or be a proper noun/identifier.
  - D7 has no bare `use V` pattern, so `we use pnpm` / `always use pnpm` (A6 §2.6, R3 E8) match nothing.
  - R3 F10's `default_scope` was dropped. A user in `apps/web` saying "we use pnpm" writes `pkg.manager` at `apps/web`, and `packages/cli` never sees it (a G1 miss), since the cascade flows down, not across.
- **Fix, D7: append:**
  > Each slot row in `slots.json` has `subject_aliases`, `value_class` and `default_scope ∈ {root, working}`. `root`: `pkg.manager`, `commit.style`, `branch.base`, `gh.account`, `ci.system`, `deploy.target`. `working`: the rest. A value outside `value_class` is accepted only if it is a single capitalized or identifier-shaped token **not** in the status lexicon (`broken, down, failing, flaky, slow, fixed, working, done, weird, annoying, wrong, fine, ok, good, bad, new, old`). Add pattern `(we |i )?(always )?use V( here)?` when V is in exactly one slot's `value_class`. A `root` slot is written at `""` unless the utterance names a path or scope, or the working scope already has its own row.
- **Fix, A4 §3.2, first row:** "none | insert at the slot's `default_scope` (`root` → `""`, `working` → the top scope of the read set)".
- **Add rows to the P3.3 gate table:** `the auth is broken` → no slot; `we use pnpm here` in `apps/web` → `pkg.manager=pnpm` at `""`.

### 10. Non-human detection and the "76%" figure

- **Where:**
  - D24 ("or with an `origin` marking it non-human"); A7 §2 `nonhuman` ("or a non-human origin").
  - DECISIONS §0 row 2 ("76% of packets: task notifications and agent messages"); ROADMAP findings ("76% of packets fire on non-human submits"); A5 §5 baseline ("packets on non-human submits 76%").
- **Evidence:**
  - The UserPromptSubmit payload is common fields + `prompt` only (`hooks.md:1337-1349`). `origin.kind` exists only on the **transcript** line (R6 §1.1), which lags the hook.
  - R6 §4.2's 76% = task-notification 54% + **queued mid-turn 16%** + peer 6%. Queued prompts are human-typed (R6 §1.1 `promptSource=queued`; D12 counts them as `src=user`). Strictly non-human packets are 60% (61% with meta).
  - Cron and `/loop` wakeups submit a stored prompt with no wrapper; their text is in the Stop payload's `session_crons[].prompt` (`hooks.md:2560`).
- **Fix, D24:** "A prompt whose first non-space characters are `<task-notification`, `<agent-message`, `<cross-session-message` or `<teammate-message`, **or** whose text equals a `session_crons[].prompt` seen in the window's last Stop payload (stored in `ctx.json`), gets no packet and does not advance the turn counter. There is no payload `origin` field. The transcript's `origin.kind` is used only at encode time (sleep), to correct `src` after the fact. Queued prompts are **human** and count."
- **Fix, A7 §2 `nonhuman` detector:** the same text, without the `origin` clause.
- **Fix, DECISIONS §0 row 2 "What the evidence showed":** "…The main cause is **firing on non-human submits** (60% of packets: task notifications 54%, agent messages 6%; a further 16% followed queued mid-turn prompts) with a fixed 6 bullets". Apply the same correction to the ROADMAP findings row ("**60%** of packets fire on task notifications or agent messages (76% counting queued mid-turn prompts)") and to the A5 §5 baseline row ("packets on non-human submits | 60% (76% incl. queued)").

### 11. Subagent windows

- **Where:** D2 (subagent tool events "add to the **parent's** place signal at half weight"); A4 §2 (subagent ×0.5); D25 / A4 §4 (`size_now − off`); A5 `subagent` ("the parent's scope is unchanged").
- **Evidence:**
  - `transcript_path` inside a subagent is the main session's transcript (`hooks.md:2385`). A child window's refractory distance would measure the parent's growth. The child's own transcript is `<session>/subagents/agent-<agent_id>.jsonl`.
  - A **fork** subagent "inherits the entire conversation so far" (`sub-agents.md:1149`), including Eden's packets. A fresh child ledger re-delivers them.
  - R2 §5.3 and R3 F2 said subagent events must not drift the parent. The A5 arm asserts the parent's scope is unchanged, yet D2 adds subagent paths to the parent's weight. R6 §9.4 wanted main-thread paths weighted **above** subagent fan-out, not added to it.
- **Fix, D25, new bullet:** "**Child windows:** distance is measured on `dirname(transcript_path)/<session_id>/subagents/agent-<agent_id>.jsonl` (the path SubagentStop reports as `agent_transcript_path`). A child whose `agent_type` is `fork` starts with a **copy** of the parent's ledger."
- **Fix, D2, last sentence:** "Tool events carrying an `agent_id` update that window's `last_paths`. They enter the **parent's** place signal only as a tie-breaker (×0.5) when the parent's own main-thread paths from the last 3 human turns carry < 30% of the weight."
- **Fix, A5 `subagent` arm:** add "…the parent's scope is unchanged **when the parent has its own recent paths**; a fork subagent receives no SubagentStart bullet already delivered to the parent."

### 12. Concurrent writers on window files

- **Where:** A4 §1 (`ctx.json` "last_paths, q_prev tokens, context vector, fail streak"; `hwm.json`); A4 §5.5 ("Update `ctx.json`"); §3.3; §5.7.
- **Evidence:**
  - Only `delivery.log` is specified as append-only.
  - `ctx.json` is written by the main PostToolBatch, by up to 31 parallel subagents' PostToolBatch (R3 E2 p90; D2 parent half-weight), by Stop, and by Submit.
  - `hwm.json` is advanced by the encoder at Submit, at PostToolBatch (P0.6 "records … in one write") and at async Stop.
  - Read-modify-write loses updates (R3 F12's lesson), and two encoders on one delta encode the same lines twice.
- **Fix, A4 §1 layout:** replace `ctx.json` with `ctx.log   # append-only: {k:"paths"|"exit"|"sig"|"crons", …}; folded on read (last 3 human turns only) and compacted at Stop`. Add: "`hwm.json` is advanced only under `flock(windows/<win>/hwm.lock, LOCK_EX|LOCK_NB)`; a process that cannot take the lock skips encoding (the next hook catches up). Rows carry `src_uuid`, and the repo writer drops a row whose `(src_uuid, kind, key)` already exists."
- **Fix, A7 §8 line 2:** "read `ctx.log` (fold ≤ 16 KB), `delivery.json` + `delivery.log`, `tau.json`, `shadow.json`: < 3 ms".

### 13. The shadow set must be per window

- **Where:** A4 §1 (`repos/<repo>/shadow.json`); D27.
- **Evidence:**
  - InstructionsLoaded fires per session when a file is loaded, including lazy `nested_traversal` / `path_glob_match` loads and `compact` reloads (`hooks.md:1288`, `:1302`).
  - A nested `apps/web/CLAUDE.md` loaded in session A is not in session B's context. Subagents can omit CLAUDE.md (`sub-agents.md:230` `omitClaudeMd`).
  - A per-repo shadow suppresses facts in windows that never loaded the file (a G1 miss).
- **Fix, A4 §1 layout:** move `shadow.json` from `repos/<repo>/` to `windows/<win>/shadow.json   # instruction files loaded in this window (InstructionsLoaded) + AGENTS.md/MEMORY.md read at SessionStart`. Keep `repos/<repo>/shadowfacts.json   # file sha → facts it states (cache)`.
- **Fix, D27:** append "Per window; a subagent window starts empty unless its type loads CLAUDE.md."

### 14. The `cid` scheme

- **Where:** A4 §4 `cid` scheme; A4 §4 example (`P:merge-self`); A4 §10 (`I:no-self-merge` → `P:no-self-merge`); A7 §5 (`"id": "P:no-self-merge"`); A4 §1 (`id` = ULID).
- **Evidence:**
  - Windows are global, but repos vary within one window (R6 §5: 40% of paths are outside cwd). `s:|pkg.manager` in repo A and repo B collide.
  - Promotion changes the cid (`I:` → `P:`), so a rule just delivered as an intent is re-delivered as a pin.
  - A7 stores the prefix inside `id`, which yields `P:P:…`.
  - A repo pin and its user-global copy are two rows with two cids.
- **Fix, A4 §4 `cid` scheme:**
  > `cid = <repo8>/<kind-letter>:<key>`, where `repo8` is the first 8 hex chars of the repo key (`_user` for user-global). Slot: `s:<scope>|<slot>`. Policy **and** intent: `P:<rule_key>`, where `rule_key = hash(class, polarity, object)` (D9). An intent and the pin it becomes share a cid, and a repo pin and its user-global copy map to the user-global cid. Gotcha: `G:<error_sig hash>`. Procedure: `R:<id>`. Episode: `E:<hash(normalized text)>`. Row `id`s are ULIDs and never carry a prefix.
- **Fix, A7 §5 JSON:** `"id": "01J9…ULID", "rule_key": "integrate|neg|*"`.

### 15. `ignored` labels gate delivery through τ

- **Where:** A4 §8 ("These labels feed τ refit negatives … so these labels never gate delivery in v1"); A7 §4 (silence set includes "logged human prompts that received **no** use and whose deliveries were `ignored`"); D17.
- **Evidence:**
  - R6 §1.3 and §4.1: the "used" proxy is 67% against a 54% random baseline, so it is uninformative.
  - Feeding `ignored` prompts into the silence set that sets τ raises τ against true positives the agent simply did not echo. That is gating.
  - At R6's rate (178 human prompts over weeks, one user), 300 per-repo prompts take months, so τ stays at the R1 fixture value for most repos.
- **Fix, A7 §4 silence-set bullet 2:** "this repo's logged human prompts on which the **pre-gate candidate set was empty** (no row shared a MEDIUM+ token), plus prompts in `ack` mode". Delete "whose deliveries were `ignored`".
- **Fix, A4 §8 last paragraph:** "These labels feed the backlog triggers (DECISIONS §7) and dogfood reports only. They do not enter τ refit or ranking in v1 (R6: the proxy is 67% vs a 54% baseline)."
- **Fix, A7 §4 bullet 3:** "never fewer than 300 prompts **pooled across the user's repos (idf-rescaled)** before τ is trusted".

### 16. The P4.3 gate is not supported by R1

- **Where:** ROADMAP P4.3 gate ("CueBench at repo τ: recall ≥ 0.55, FIR ≤ 5% on real negatives"); A4 G3; A5 `false_rate`.
- **Evidence:** R1 §3.1–3.2. The best lexical method, BM25F_ctx, reached recall 0.580 at **test FIR 15%**, and 0.498 at test FIR 7.5% (strict point). Every lexical method missed FIR ≤ 5% on test. Only bge-small (daemon-only, D15) reached 0.589 at 5.0%. R1 §3.2: lexical thresholds "transfer poorly".
- **Fix, P4.3 gate cell:** "CueBench at repo τ: recall ≥ 0.50 with test FIR ≤ 7.5% (R1 strict point: 0.498 / 7.5%), **and** FIR ≤ 5% on the ≥ 300 real-negative set. If the real-negative FIR exceeds 5%, raise τ and report the recall cost; do not relax the FIR gate."

### 17. Addendum A's costs are missing

- **Where:** DECISIONS §0 row 7, D18; A7 §1 layer 3, §7 row P; ROADMAP findings row 4.
- **Evidence:** R1 Addendum A, high-stakes row:
  - "Other positive cues gaining a policy bullet: **19%**";
  - "Policy bullets per policy cue: **1.6**";
  - recall "0.47 (**0.55 of reachable**)";
  - "Caveat: the author had seen **12 of the 60** policy cues".

  The "at 4% FIR" figure is the trigger's own FIR. The similarity methods' ≤ 0.22 was at 5–15% FIR, not at 4%.
- **Fix, D18 Evidence cell:** "R1 Addendum A (policy recall 0.47 at 4% FIR on negatives, vs ≤ 0.22 for similarity at 5–15% FIR; cost: 19% of other positive cues gain a policy bullet, 1.6 policy bullets per policy cue; the lexicon author had seen 12/60 cues)".
- **Fix, A7 §1 layer 3 "Measured":** append "; cost: 19% of non-policy positives gain a policy bullet (Addendum A). The ledger's 400 KB refractory and the ≤ 2-per-class cap are what keep this under the G3 target, so the A5 `policy-trigger` arm must report `false_rate` on non-policy positives as well".
- **Fix, A5 `policy-trigger` assert:** "recall ≥ 0.45 at FIR ≤ 5%, **and** policy bullets on non-policy positives ≤ 10% after the ledger".

### 18. Sleep scheduling

- **Where:** D34; A4 §6.
- **Evidence:**
  - "Claude's first response still waits for the hooks to finish" (`hooks.md:1124`). "A prompt you send while SessionStart hooks are still running doesn't reach Claude until they finish" (`:1128`). Heavy sleep at SessionStart (alias replay over 500 cues, τ refit, repo mining with `git ls-files` at 1–5 s cold, R5 §8) would stall the first response.
  - No hook fires during idle, so "5 min after last agent activity" has no trigger.
  - Under `-p`, async hooks are killed at teardown (`hooks.md:3688`).
- **Fix, D34:**
  > • **Light** (≤ 1 s): the async `stop-sleep` hook (finding 6). <br>• **Idle:** `stop-sleep` spawns a **detached** `eden sleep --idle --repo <k> --after 300` (setsid, stdio closed), unless one is already pending (pid file under `.lock`). It exits without work if any window of the repo appended to `delivery.log`/`ctx.log` in the last 5 min. <br>• **Heavy:** the same detached process at ≥ 30 min idle, or launched **detached** from SessionStart (which returns immediately). A hook never waits for heavy sleep.

### 19. D20 misdescribes the existing daemon path

- **Where:** D20 ("already a fallback path in the plugin … its socket gets a 5 ms connect budget, then falls back to in-process"); ROADMAP P6.2.
- **Evidence:** `plugins/eden-memory/scripts/hook.ts`, in order:
  1. import in-process first;
  2. then `fetch http://127.0.0.1:8794/hook` with `AbortSignal.timeout(8000)`;
  3. then `spawnSync` fallbacks with `timeout: 8000` each.

  The worst case is ~24 s on UserPromptSubmit, against A4's 150 ms budget (`hooks.md:1329`: 30 s host timeout). There is no socket, and the order is the reverse of D20's.
- **Fix, D20:** "…(`hookd`; today's plugin reaches it over HTTP **after** the in-process import fails, with 8 s timeouts, which P0.1 must replace). Target: try a Unix socket first with a 5 ms connect budget and a total 100 ms response budget, then run in-process. No path may exceed the 150 ms Submit budget."
- **Fix, ROADMAP P0.1 build cell:** append "; the plugin's fallback chain obeys the 150 ms budget (no 8 s fetch/spawn timeouts on Submit)".

### 20. FileChanged needs `watchPaths`

- **Where:** D31 ("re-checked when `FileChanged` fires on their cited file"); ROADMAP P3.4 ("FileChanged watches cited files").
- **Evidence:**
  - The FileChanged `matcher` "is registered as a literal filename **in the working directory**" (`hooks.md:2859`), so it cannot name `apps/web/package.json` or a worktree's lockfile.
  - Arbitrary paths need `watchPaths` (absolute), returned from SessionStart, CwdChanged or FileChanged. That output "**Replaces** the current dynamic watch list" (`:2922`).
- **Fix, D31, first sentence:** "…re-checked when `FileChanged` fires on their cited file. SessionStart (and CwdChanged) return `watchPaths` = the absolute paths of every cited file in the repo (≤ 200, newest-cited first). FileChanged returns the same full list, since each return replaces the list. …"

### 21. Decline tracking has no signal

- **Where:** A6 §2.5 ("Three declined asks on the same rule within 14 days → sleep proposes revoking it"); ROADMAP P2.3 ("decline tracking").
- **Evidence:** PermissionDenied "doesn't run when you manually deny a permission dialog" (`hooks.md:2201`). No hook reports the user's answer to an `ask`.
- **Fix, A6 §2.5 bullet 4:** "Every ask is logged with its `tool_use_id`. At the next PostToolBatch (whose `tool_calls` carry every call in the batch) and at sleep, from the transcript, the ask is labelled **approved** if that `tool_use_id` has a successful `tool_result`, and **declined** if its `tool_result` is the permission-rejection message. Three declines on the same rule within 14 days → …". Add to A5 `policy-guard`: "a declined ask is labelled `declined` from the transcript".

### 22. Non-human silence vs `Updated:`

- **Where:** A5 §2 `silence` (a) "non-human submits (must be 0)"; A4 G3 "**0** on non-human submits"; D24 ("It may carry only a dishabituation (`[updated]`)"); A4 §5.1 step 0.
- **Fix, A5 `silence`(a):** "packets on non-human submits other than `Updated:` items (must be 0)". Apply the same wording to A4 G3.

### 23. Place weights differ

- **Where:**
  - D4: "main thread ×2, most recent batch ×2, subagent ×0.5". No prompt weight, no Bash.
  - A4 §2: prompt 3; main-thread (implicit ×1); ×2 for the most recent batch; subagent ×0.5; Bash with no weight.
  - P3.2: "prompt, main, recent, subagent ×0.5, Bash paths".
- **Fix: one table, pasted into D4 and A4 §2:**

  | Source | Weight |
  |---|---|
  | path named in the prompt | 3 |
  | main-thread tool path, most recent batch | 2 |
  | main-thread tool path, last 3 human turns | 1 |
  | Bash path (`cd X &&`, path arguments), main thread | 1 |
  | subagent tool path | 0.5, only under D2's tie-breaker rule (finding 11) |

### 24. Intents' distance and policy "value tokens"

- **Where:** D25 and A4 §4 list distances for policies/pins (400 KB) and slots, gotchas, procedures and episodes (1.2 MB). Intents are in neither list. A4 §4 PostCompact re-arms on "value tokens", which are undefined for policies and intents.
- **Fix, A4 §4 "Distances":** "…**400 KB** for policies, pins and intents (a fresh cue is also required)…".
- **Fix, A4 §4 PostCompact bullet:** "…absent from `compact_summary`. 'Value tokens' are the slot value for slots, and for policies and intents the object plus the class verb stem of the rule text (e.g. `merge`, `pr`)."

### 25. A gotcha is delivered twice for one failure

- **Where:** D22; A4 §5.5 ("On a non-zero exit whose `error_sig` matches a gotcha, deliver it"); A4 §5.6.
- **Evidence:** A failed Bash call fires PostToolUseFailure (`hooks.md:2082`) and is then part of the batch PostToolBatch sees (`:2144`). Both paths deliver.
- **Fix, A4 §5.5 bullet 3:** "Record error signatures; gotchas are delivered **only** at PostToolUseFailure (§5.6). PostToolBatch delivers a gotcha only for a failure PostToolUseFailure did not see (an MCP tool error reported as success text)."

### 26. R3 fixes that v2 dropped without replacing

| R3 item | Status in v2 | Fix text |
|---|---|---|
| F14: `restate` excludes the first prompt of a session unless it follows a contradicting agent action; frustration adds `how many times` and `again?` | D30 drops both | Append to D30 bullet 3: "• the turn is not the first human prompt of the session, unless it follows an agent action that contradicted the value (e.g. `npm i` while `pkg.manager=pnpm`)". Frustration regex: "`I (already )?(told|said)\|as I (said\|mentioned)\|like I said\|how many times\|again\?`" |
| F13: A5 **pin-habituation** arm ("≤ 1 delivery per 400 KB of transcript growth, plus one per violation") | Missing. No arm tests the 400 KB / 1.2 MB distances, which are unmeasured proxies (R3 guessed "≈ 100k tokens") | Add A5 Delivery arm `re-eligibility`: "a pin delivered at off=0 is refractory at 399 KB, re-eligible at 401 KB with a fresh cue, and not re-eligible without a cue; log `message.usage` context tokens alongside bytes so the ratio can be fitted from dogfood". Add to ROADMAP P1.1 gate |
| F7: `cwd → (repo, toplevel)` cache file | D1 says "cached" but A4 §1's layout has no file | A4 §1 layout: add `<root>/dirmap.json   # realpath(dir) → {repo, top}; written under flock; stat-checked on miss` |
| F5: `att` resolved lazily | Dropped (finding 7) | See finding 7 |
| F23: "Stop **and SubagentStop** read `last_assistant_message`" for use labels | A4 §8 names Stop only | A4 §8 first line: "At Stop and SubagentStop (for child windows)…" |
| F6: "a procedure's exact command in a `tool_use.input.command` of the last 2 turns drops that procedure" | D26 drops the exception ("Tool output never counts") | Append to D26: "Exception: a procedure whose exact command string appears in a `tool_use` input of the last 2 turns is dropped" |
| F15: "≤ 8 aliases per row" | Dropped from D21 and A7 §6 | Append to A7 §6 step 3: "and the row holds ≤ 8 accepted aliases" |

### 27. ROADMAP dependency inversions

- P3.2's gate lists `cascade`, but cascade (D5) is built in P3.5. **Fix:** move `cascade` from the P3.2 gate to the P3.5 gate, and make P3.2's gate "`fan-out`, `single-package`".
- P1.3's residual rule "a slot bullet is dropped if its value and a subject alias co-occur" needs `slots.json` (P3.3). **Fix, P1.3 build cell:** "…Residual on typed and assistant text only (D26): episode/policy Jaccard now; the slot co-occurrence rule lands with P3.3".
- MVD time. The MVD's own sizes add up to ≤ 53 working days (1 L + 12 M + 7 S = 10 + 36 + 7). **Fix, ROADMAP "Estimated at…":** "Upper bound at the sizes above: 53 working days (~11 weeks); expected 6–8 weeks."

### 28. R0 lacks facts that D19 and the ROADMAP cite to it

- D19's Evidence cites "R0 (PreToolUse `if`, `ask`; its `additionalContext` arrives alongside the tool result)". The ROADMAP open item cites "(R0)" for auto mode. R0 F1–F22 contain none of these.
- **Fix: append to R0's table** (the only research edit this audit recommends; the doc owner makes it):

  | # | Fact | Location | Consequence |
  |---|---|---|---|
  | F23 | `if` on handlers: one permission rule, tool events only, best-effort (runs on unparseable commands) | `hooks.md:427, 432, 446-448` | One handler per pattern; the guard re-checks the command |
  | F24 | PreToolUse `ask`: forces a prompt in auto mode (≥ v2.1.211); reason shown to the user, not Claude; precedence deny > defer > ask > allow | `hooks.md:1797, 1803, 1807` | Guard text also goes in `additionalContext` |
  | F25 | PreToolUse `additionalContext` lands next to the tool **result** | `hooks.md:1003, 1799` | Context-only guards act after the call |
  | F26 | `dontAsk` auto-denies prompts; bypass disables prompts | `permission-modes.md:533, 549` | The guard downgrades by `permission_mode` |
  | F27 | SubagentStart input has no task prompt; SubagentStop `transcript_path` is the main transcript | `hooks.md:2349, 2385` | Task paths come from PreToolUse(Agent); child distance uses the agent transcript |
  | F28 | SessionStart hooks delay the first response | `hooks.md:1124-1128` | Heavy sleep is detached |
  | F29 | FileChanged matcher = literal cwd filenames; `watchPaths` replaces the dynamic list | `hooks.md:2859, 2922` | Citations return `watchPaths` |
  | F30 | Common field `prompt_id`; UserPromptSubmit has no origin field; pasted text arrives in `<pasted_content>` markers | `hooks.md:737, 1337` | `hturn` idempotence; paste stripping |

### 29. Paste stripping ignores the host's markers

- **Where:** D12; A6 §2.1 `paste` row.
- **Evidence:** "Pasted content that collapsed to a `[Pasted text #N]` placeholder arrives expanded in place … between a `<pasted_content id="…">` line and a `</pasted_content id="…">` line" when paste marking is on (`hooks.md:1337`). This is exact where R3's heuristics guess.
- **Fix, D12, "Before extraction, remove:"** prepend "spans between `<pasted_content id=…>` and `</pasted_content id=…>` lines (exact, when the host marks pastes);". Add to A5 `poison`: "a pasted README inside `<pasted_content>` markers with no fences → `src=paste`".

---

## 4. S2: misquotes, stale references, drift

| Where | Says | Should say | Evidence |
|---|---|---|---|
| DECISIONS §0 row 5 | "with subagents, 70%; with Bash paths, 79%" | "with subagent paths, 70%; main-thread plus Bash-command paths (no subagents), 79%" | R6 §5 table (79% row is "prev 3, main + Bash") |
| D1 Evidence | "the git call costs 20–40 ms (R5 §8)" | "(R5 §7)" | R5 line 257 sits in §7 |
| D10 Evidence | "A4 §6.2" | "R2 §3.5" (A4 v2 §6 is the sleep table and has no §6.2) | A4 v2 |
| D17 Evidence, A7 §4 | "a single df ≤ 5 word fired on 90/150 negatives" | "90/150 negatives **contain** a df ≤ 5 token, so the rule would fire on them" | R1 §0.7, §5 |
| D19 Evidence, ROADMAP | "PR policy restated 17× across sessions" | "git/PR-workflow category: 17 cross-session recurrences (loose category bound; strict lexical recurrence 0)" | R6 §6 table 1 |
| A7 §2 `nonhuman` | "(A4 D24)" | "(DECISIONS D24)" | — |
| A7 §8 | "SQLite FTS at P6, ~25 ms" | "~25 ms (estimate, not measured; R1 §7)" | R1 §7 "would be ~25 ms" |
| A7 §8 | "`delivery.json` … (≤ 8 KB each)" | "≤ 32 KB (256 entries × ~120 B)" | A4 §4 overflow at 256 entries |
| D12 wrapper list | lacks `<cross-session-message>`, `<bash-`, `<teammate-message` | add them (A6 §2.1 already lists the first two) | A6 §2.1 |
| D13 keyword rule | `(password\|secret\|token\|…)` | `(password\|passwd\|pwd\|secret\|token\|…)` as in A6 §2.2(b) | A6 §2.2 |
| D18 vs A7 §5 | `generated-files` vs `generated` | one name: `generated` | — |
| D23, D24 vs D14, A4 | `[updated]` | `Updated:` (D14 bans bracket tags) | D14 |
| D3 / A4 §2 | "tracked files only (`git ls-files -co --exclude-standard`)" | "tracked plus untracked-not-ignored files (`git ls-files -co --exclude-standard`)" | R5 §9.2 step 1 |
| A4 §1 layout vs A5, D30, P1.1 | `hook.log.d/` vs `hook.log` | pick `hook.log.d/<yyyy-mm-dd>.jsonl` and use that name in A5 §2, D30, P1.1 | — |
| A4 §5.2 startup | "(last session's read set)" has no storage | add `repos/<repo>/last_read.json` to the A4 §1 layout | — |
| A4 §10 step 1 vs §5.4 | "Eden: you said (today): …" | "Eden: rule you set (today): …" | A4 §5.4 |
| D9 | intents adopted | add Overrules: "R3 cut list (intents deferred); reason: R6 §6 shows 'not yet' constraints are the largest restated class" | Register precedence rule |
| A4 §4 Budget | "After 6k tokens, only `Updated:` items and guard deliveries are allowed" | add Overrules to D28: "R3 cut list (cut the budget policy, keep the counter); kept as a cap because R6 §9.8 max epoch was 79k" | Register precedence rule |
| D29 / A4 §5.9 | "move to the end of the last user message" | "attach to the last **human** user message and keep it on that message for every tool-loop step of the turn" (otherwise each step moves the packet and breaks the cached tail) | A1 annex §E |

---

## 5. Numbers checked and found correct

- **R6** (all match; except where noted in findings 10 and §4):
  - 55.8% same-session exact repeats; 63% non-human submits; 18/23 "continue" got a packet (0.22 silence, 78% packet); 54% of human prompts packed.
  - Tokens per epoch: p90 40k, max 79k, 10/24 epochs over 6k. Median 3 human prompts per session.
  - Place: 35% / 70% / 79%; 85% manifest prediction; 40% of paths outside cwd, 9% in worktrees; 2.6% new-scope batches.
  - Copula 0.5%; 28 mentions / 17 cross-session recurrences; 13% "continue" (34% Eden); 52% noise-shaped bullets.
  - "Used" proxy 67% vs 54%. ~8.2 subagent files per main session (327/40). ~1.7 non-human per human submit.
- **R1** (all match; except the Addendum A context and the P4.3 gate, findings 16–17):
  - 50% FIR today; ctx 0.18 → 0.41; 0.00–0.12 zero-overlap recall; static 0.38–0.46 vs 0.56; bge +0.01–0.03 and 165 ms cold, 1.3 ms warm.
  - CE 0/80; τ 3.2 / 4.1; dev 0 → test 7.5%; 0.58 / 0.85 vs 0.52 / 0.50; 20k in-process build ~100 ms; warm BM25F 5.5 ms.
  - ≤ 0.07 indirect; 39% FIR for topical classes; 0.47 at 4%.
- **R5:** 90.2 / 80.9 / 76.1% agreement; 3.8 / 10.7 / 22.4% root-leak; 12 unit rows in §9.3; 20–40 ms git call (§7, not §8).
- **R3:** 27% rewinds; ~89% subagent windows (327/367); 5/5 false "again"; the 64 KB tail holds about 1 typed prompt.
