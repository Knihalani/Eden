# R0 — Claude Code hook facts (verified against the raw docs)

**Verified 2026-09-29.** Source: `https://code.claude.com/docs/en/hooks.md`, fetched raw (246,601 bytes). Raw snapshots are in `research/sources/` (hooks, permission-modes, sub-agents; fetched 2026-09-29), and line numbers refer to them.

> **Method note.** A documentation agent that read this page through a summarizing fetch reported that PreCompact, PostCompact, SubagentStart, the 10,000-character cap, the 30 s timeout, and transcript persistence were "not documented". **All of those are documented.** The summarizer dropped them. Design facts must come from the raw page, grepped, not from a summary.

## Facts the design depends on

| # | Fact | Doc quote / location | Design consequence |
|---|---|---|---|
| F1 | Events include `SessionStart`, `UserPromptSubmit`, `PostToolUse`, **`PostToolBatch`**, **`SubagentStart`**, `SubagentStop`, `Stop`, **`PreCompact`**, **`PostCompact`**, **`InstructionsLoaded`**, **`CwdChanged`**, **`FileChanged`**, `SessionEnd`, … | event table, `hooks.md:36-75` | More delivery and invalidation channels than the design used (below) |
| F2 | `SessionStart.source` ∈ `startup, resume, clear, compact, fork` | hooks.md SessionStart | Epoch bump on every value except `startup` |
| F3 | UserPromptSubmit input: common fields + `prompt`. There is **no open-file / editor field** | `hooks.md:1335-1350` | Place must come from tool paths (A4 §2.2), confirming A1 C1.1 |
| F4 | `additionalContext` for UserPromptSubmit is inserted "alongside the submitted prompt"; for PostToolUse / **PostToolBatch** "next to the tool result"; for SessionStart / SubagentStart "at the start of the conversation" | `hooks.md:996-1005` | Tail placement; cache-safe (A2 §2.10) |
| F5 | **"Claude Code saves the injected text in the session transcript."** On `--resume`, it **replays** saved text instead of re-running the hook | `hooks.md:1021` | Repetition accumulates across turns and survives resume. The delivery ledger (A4 §4) is required, not optional. Resume does **not** remove earlier packets, so `resume` should *not* reset the ledger (see below) |
| F6 | `additionalContext` / stdout cap: **10,000 characters**; above that, written to a file plus a 2,000-char preview | `hooks.md:923, 1009` | 900 B packet is safe |
| F7 | UserPromptSubmit default timeout **30 s**; on timeout the output, including `additionalContext`, is discarded | `hooks.md:1329-1331` | Internal 150 ms budget stays; fail-open already matches |
| F8 | **"The transcript file is written asynchronously and may lag the in-memory conversation"**; use `last_assistant_message` on Stop/SubagentStop instead of reading the transcript | `hooks.md:738`; Stop input | The encode high-water mark (A4 §6.1) must tolerate lag: the current prompt comes from `prompt`, and the final assistant text from `last_assistant_message`. The transcript is only used for older lines, and a torn last line is skipped |
| F9 | PostToolUse input: `tool_name`, `tool_input` (file paths **absolute**, native separators), `tool_response` (structured), `tool_use_id`, `duration_ms` | `hooks.md:1984-2010` | `last_paths` source; normalise Windows separators |
| F10 | **PostToolBatch** fires once per batch of (possibly parallel) tool calls, "before Claude Code sends the next request to the model", with all `tool_calls` (input + serialized response), and **can return `additionalContext`, injected once before the next model call** | `hooks.md:2142-2200` | **A second delivery point.** Memory can arrive when the agent *enters a place*, mid-turn (for example on its first Read in `packages/cli`), not only when the user types. This is the path/event trigger from the cue-anchored design, and it is new to A4 |
| F11 | PostToolUse fires **concurrently** for parallel tool calls | PostToolBatch section | Ledger and `last_paths` writes must be lock-safe or batched. Prefer PostToolBatch for encode and place |
| F12 | **SubagentStart can inject `additionalContext` into the subagent**, and "injects the returned context only when the subagent's context doesn't already hold the copy from an earlier run"; after the subagent auto-compacts, the copy is re-injected | SubagentStart section | Claude Code itself applies habituation here, which validates the ledger design. Subagents get their own window, so their own ledger is keyed by `agent_id` |
| F13 | Hook input carries `agent_id` / `agent_type` inside subagents; SubagentStop gives `agent_transcript_path`, `last_assistant_message` | common fields; SubagentStop | Child ledger keyed `session--agent_id` |
| F14 | **PostCompact input includes `compact_summary`** | PostCompact section | Precise re-arm: after compaction, re-arm only the delivered items whose values are **absent from the summary**. That beats a blanket epoch reset |
| F15 | PreCompact `trigger` ∈ `manual, auto`; can block compaction (Eden must never block) | PreCompact section | Never return `decision` |
| F16 | **InstructionsLoaded** fires whenever a CLAUDE.md or `.claude/rules/*.md` is loaded (`session_start`, `nested_traversal`, `path_glob_match`, `include`, **`compact`**), with `file_path` | InstructionsLoaded section | An **exact** shadow-set feed: Eden knows which instruction files are in context right now and can suppress facts they already state. It does not fire for AGENTS.md read directly via the Project-instructions setting; that must be read from disk |
| F17 | Nested CLAUDE.md files are loaded **on demand** when Claude reads files in that subdirectory (memory docs) | code.claude.com/docs/en/memory | The shadow set is scope-dependent; follow F16 events instead of assuming |
| F18 | Stop input: `last_assistant_message`, `stop_hook_active`, `background_tasks`, `session_crons`. Not fired on user interrupt | Stop section | Use labels (A4 §8) read `last_assistant_message`, not the transcript |
| F19 | `"async": true` command hooks run in the background; **their output is delivered on the next conversation turn**; they cannot block | "Run hooks in the background" | Sleep / prefetch at Stop runs as an **async hook that prints nothing**, so it never injects by accident. Or it detaches a child process |
| F20 | **"Write the text as factual statements rather than imperative system instructions … Text framed as out-of-band system commands can trigger Claude's prompt-injection defenses"** | `hooks.md` "Add context for Claude" | The packet must read as project information, e.g. `Rule you set: .env is never committed`, not `[rule] never commit .env`. This refines A6 §2.3 |
| F21 | FileChanged watches named files; CwdChanged fires on `cd` | event table | Citation invalidation (A4 P5.1) can be event-driven for `package.json` / lockfiles instead of stat-on-Submit |
| F22 | Plain stdout and `additionalContext` are each injected as a system reminder **"that starts with the hook's name"** | UserPromptSubmit decision control | The packet header can be short; the host already labels the source |

### Added 2026-09-29 after the v2 consistency audit (R7 §28); verified against the raw pages in `research/sources/`

| # | Fact | Doc location | Design consequence |
|---|---|---|---|
| F23 | `if` on a handler holds **exactly one** permission rule, applies to tool events only, and is **best-effort**: the hook runs regardless when Claude Code can't parse the Bash input (`$()`, backticks, `$VAR`) | `hooks.md:427, 432, 446-448` | One handler per `(class, pattern)`; the guard re-checks `tool_input.command` itself |
| F24 | PreToolUse `ask`: the prompt is labelled `[plugin:<name>]` for plugin hooks; `permissionDecisionReason` is **shown to the user but not Claude**; precedence `deny > defer > ask > allow`; in auto mode `ask` forces a prompt from **v2.1.211** (the classifier can still deny) | `hooks.md:1797, 1803, 1805, 1807` | The guard also sends the rule as `additionalContext`; minimum version stated |
| F25 | PreToolUse `additionalContext` is added **alongside the tool result**, i.e. after the call ran | `hooks.md:1003, 1799` | Context-only guards and procedures help the *next* step, never the current one |
| F26 | `dontAsk` auto-denies every call that would prompt; `bypassPermissions` disables prompts; `-p` without a permission host denies prompting calls | `permission-modes.md:58, 533, 549` | The guard downgrades to context-only in `dontAsk` and `bypassPermissions`; Eden never causes a deny |
| F27 | SubagentStart input is common fields + `agent_id` + `agent_type`, with **no task prompt**; in SubagentStop, `transcript_path` is the **main** transcript and `agent_transcript_path` the child's | `hooks.md:2349, 2385` | Task paths come from `PreToolUse(Agent)`; child distances use the child transcript |
| F28 | Claude's **first response waits** for SessionStart hooks | `hooks.md:1124-1128` | Heavy sleep is launched detached, never awaited |
| F29 | The FileChanged matcher is a literal filename in the working directory; arbitrary files need `watchPaths` (absolute), and each return **replaces** the list | `hooks.md:2859, 2922` | Citation watching returns the full `watchPaths` list every time |
| F30 | Common field `prompt_id` (v2.1.196+); UserPromptSubmit has **no origin field**; pasted text arrives expanded between `<pasted_content id=…>` markers when paste marking is on | `hooks.md:737, 1337` | Idempotent `hturn`; non-human detection is textual; exact paste stripping |

### Added 2026-10-02 from real payloads (P0.0a probe capture)

A probe plugin that registers every event recorded the payloads of two headless Claude Code 2.1.285 sessions: a Read, two Bash calls in one message, a failing Bash call and an Explore subagent; then `--resume` and `/compact`. The key lists are in `benchmarks/memory-long-horizon/harness/fixtures/payload-keys.claude-2.1.285.json`.

| # | Fact | Evidence | Design consequence |
|---|---|---|---|
| F31 | Field order and presence: `prompt_id` appears once the process has had a prompt (absent on SessionStart(startup/resume) and the InstructionsLoaded before them, present on SessionEnd, PreCompact, SessionStart(compact)); `permission_mode` on UserPromptSubmit and the tool-context events; `effort` on the tool-context events only; `agent_id`/`agent_type` after `permission_mode` in a subagent | 23 captured shapes | Encoders must not assume `prompt_id` on SessionStart |
| F32 | `/compact` fires PreCompact, then **SubagentStop for an internal compaction agent** (`agent_type: ""`, an `agent_transcript_path` with no file), then SessionStart(compact) (with `model`), then PostCompact | resume-then-compact sequence | SubagentStop handlers (D25 fold, P1.2) must skip `agent_type: ""`; SessionStart(compact) runs **before** PostCompact sees `compact_summary` |
| F33 | Two Bash calls in one assistant message run one after the other: PreToolUse, PostToolUse, PreToolUse, PostToolUse, then one PostToolBatch. The transcript writes one assistant line per `tool_use` block | debug log `tool_dispatch_start/end` | Concurrent PostToolUse (F11) is for concurrency-safe tools such as Read |
| F34 | A peer message is a transcript `user` line with `isMeta: true`, `origin.kind: "peer"`, text opening `Another Claude session sent a message:` then `<agent-message from="…">`; its `queued_command` form starts with `<agent-message`. The UserPromptSubmit `prompt` for it was **not** captured | this machine's transcripts | D24's prefix test is right for the queued form; check the live payload before relying on it for idle peer messages |

### Added 2026-10-03 from real sessions (P0.0b end-to-end check)

Two headless Claude Code 2.1.285 sessions in a project whose `CLAUDE.md` held a marker (`ZEBRA-7731`). Each subagent was asked, with no tools, to list every token of that shape in its context; its task text never contained the marker (checked in its transcript).

| # | Fact | Evidence | Design consequence |
|---|---|---|---|
| F35 | A **general-purpose** subagent's context holds the project's `CLAUDE.md`; **Explore** and **Plan** subagents' contexts do not. **No InstructionsLoaded fires inside any of them**: the probe saw one, `session_start`, for the main thread only | sessions `d43429be-…` (general-purpose reported the marker) and `9f8d15cb-…` (Explore and Plan reported only the example token); one trial each, the subagent's own report | D27's per-window shadow set cannot come from InstructionsLoaded inside a subagent: by type, a general-purpose window starts with the parent's instruction files, Explore and Plan with none. The harness's simulated window follows this |

## Corrections this forces in the design

1. **Resume is not a reset** (F5). Replayed packets are still in context after `--resume`, so the ledger survives resume. `clear` and `compact` reset; for `fork`, copy the parent ledger.
2. **Compaction re-arm is selective** (F14). Re-arm a delivered item only if its value tokens are absent from `compact_summary`.
3. **PostToolBatch is a delivery point** (F10), gated by the same ledger. Its main trigger is a scope change (the agent's first touch of a new scope this epoch) or a file whose path is cited by a live memory (procedure, gotcha, rule with a path glob).
4. **Shadow set from InstructionsLoaded** (F16), plus a disk read of AGENTS.md.
5. **Packet wording is declarative** (F20).
6. **Concurrency** (F11): encode place and tool facts at PostToolBatch, not per-PostToolUse.
