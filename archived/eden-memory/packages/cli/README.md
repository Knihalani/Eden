# eden

The CLI for Eden, passive memory for coding agents: the hook entry points, `eden setup`, `eden doctor --memory`, and the commands that inspect and maintain the store. What Eden does and how to install it: the [root README](../../README.md).

Needs [Bun](https://bun.sh). This package (`@kaiavn/eden`) is not published to a public registry. From this clone:

```bash
bun install
alias eden='bun packages/cli/src/cli.ts'
eden --help
```

## Commands

| Command | What it does |
|---|---|
| `eden setup` | Write the hooks for Claude Code (always), and Gemini CLI, Codex and OpenCode when their config folders exist (`--all-agents`: always). Not together with the Claude plugin. Its hooks also run the retired tool recorder (see Hooks) |
| `eden doctor --memory` | Memory only: hooks, plugin copy, load time, flags, breaker, kill switches. Exits 0 when every line is ok |
| `eden doctor` | Everything, memory included; names each extra host as ok, half-wired, skipped or not installed. Its exit status follows the compile-era checks (`config`, `wrap`, `approve-gate`), so use `--memory` for memory's |
| `eden memory remember [--global] "<text>"` | Store what a statement says now. `--global` keeps only its rules, for every repo. `--jsonl -` reads `{"text", "kind"?, "cwd"?, "scope"?}` lines from stdin |
| `eden memory dump [--json]` | Print every row under the memory root and every window's ledger records |
| `eden memory purge <regex>`, `eden memory forget --secret <regex>` | Rewrite every file under the memory root with each match replaced by `[REDACTED]`, and list the Claude Code transcripts that still hold one (Eden never edits them) |
| `eden memory forget --all-in <scope>` | Send every keyed row of one folder scope of this repo (its rules, and slot facts such as the package manager) to history |
| `eden memory scopes [--json] [<path>…]` | Build this repo's folder-scope catalog from its files now, and say which repo and scope each path belongs to |
| `eden memory import [--dry-run] <path>` | Read JSONL or JSON transcripts into memory |
| `eden memory migrate [--dry-run \| --apply \| --rollback \| --contract]` | Move stores written before per-repo memory (one per session) into per-repo stores |
| `eden sleep` | Run a full sleep on this repo's store now: consolidate, then mine the repo's files |
| `eden eval build-negatives [--label \| --freeze]` | Build your private set of prompts that need no memory, from your own transcripts, in `~/.eden/eval` |
| `eden hook`, `eden hookd` | Hook entry point, and the daemon that answers the hooks `eden setup` writes (they fall back to `eden hook` when it is down) |
| `eden wrap` | The local proxy (`127.0.0.1:8788`): memory for OpenAI-compatible agents |

## Memory

Default is **on**. No memory hook calls a model, an embedding service or the network, and the store stays local. Delivery is silent injection: there is no memory UI, and `memory_search` is not the default loop.

### Three states

`EDEN_MEMORY` (`src/memory-consent.ts`). Unset, empty, `1`, `on`, `true`, or `yes` is **on**.

| State | Set | What it does |
|---|---|---|
| on | unset (default) | Recall and write |
| read-only | `readonly`, `read-only`, or `ro` | Recall existing notes. No write |
| off | `0`, `off`, `false`, or `none` | Identity. Inject returns the original body. No encode |

Any other value is off.

### Store

JSONL under `EDEN_MEMORY_DIR`, or `$EDEN_HOME/memory`, or `~/.eden/memory`. One store per repo, `<dir>/repos/<key>/`, keyed by the repo's git common dir, so every session, worktree and subagent of a repo shares it (outside git, by the folder a session starts in). Each context window keeps its ledger in `<dir>/windows/<window>/`. Directories `0700`, files `0600`.

`EDEN_MEMORY_CAP` is retrieve k (default **6**), not store size. A set value stays in the 6–10 packet band. `EDEN_MEMORY_STORE_CAP` is the JSONL cap (default **2000**). `EDEN_MEMORY_TAU` overrides τ_repo's normalized threshold, the BM25F sum a row needs on MEDIUM evidence (A7 §4; unset: the store's refit, R1's strict point until one is trusted; `0`: no τ).

`EDEN_MEMORY_LOG=1` prints note ids and relative ages to stderr. Default off. `EDEN_MEMORY_INJECT_LOG` is a metric file path; unset writes nothing. Every hook invocation also appends one wide event (ids, hashes, counts, times; no text) to `hook.log.d/<date>.jsonl` under the memory root.

`EDEN_MEMORY_SESSION` or `EDEN_MEMORY_PARENT` names the wrap session file. `EDEN_MEMORY_CHILD` opens that session’s child file (`parent--child`). The hook reads the same three names when the payload has no session id.

### Delivery flags

Each delivery point has a flag, `off`, `shadow` or `on` (`src/memory-flags.ts`), read on every event, so editing a flags file takes effect at the next event. `off` delivers nothing and writes no ledger. `shadow` runs the whole pipeline, prints nothing, and records what it would have delivered in the window's `delivery.shadow.log`.

| Flag | Point | Default | Environment |
|---|---|---|---|
| `deliver.submit` | UserPromptSubmit packet | on | `EDEN_FLAG_DELIVER_SUBMIT` |
| `deliver.session_start` | SessionStart brief | on | `EDEN_FLAG_DELIVER_SESSION_START` |
| `deliver.subagent` | SubagentStart brief | shadow | `EDEN_FLAG_DELIVER_SUBAGENT` |
| `deliver.batch` | PostToolBatch delivery | shadow | `EDEN_FLAG_DELIVER_BATCH` |
| `deliver.failure` | Delivery after a failed tool call (not wired to an event yet: P4.5) | shadow | `EDEN_FLAG_DELIVER_FAILURE` |
| `guard.context` | The policy guard re-delivers a rule a command is about to break | shadow | `EDEN_FLAG_GUARD_CONTEXT` |
| `guard.ask` | The guard asks you before an irreversible command a rule forbids, or a call a live intent covers. `EDEN_POLICY_GUARD=off` turns the whole guard off, `guard.context` included | off | `EDEN_POLICY_GUARD` |

Sources, highest first: the environment, `<repo>/.eden/flags.json`, `$EDEN_HOME/flags.json`, then the default. Both files map a flag name to its value: `{"deliver.submit": "shadow"}`. A repo file may lower `guard.ask`, never raise it. An unknown value is `off` (`shadow` for `deliver.submit`). An unhandled exception at an `on` point forces it to `shadow` for 24 h (`$EDEN_HOME/flags.auto.json`), and the next SessionStart says so once.

### Sleep

Consolidation budgets in `src/sleep.ts`.

| Env | Unset | Other values |
|---|---|---|
| `EDEN_SLEEP_EVERY` | 32 turns | `0` / `off` disables. `"8"` is 8 turns. `"64k"` (also `kb` / `mb` / `b`) is a byte threshold and sets turns to 0 |
| `EDEN_SLEEP_IDLE` | 5 min (300000 ms) | `0` / `off` disables idle full-sleep. A plain integer is milliseconds. The memory hook's idle sleeper (`eden sleep --idle`, which Stop and SessionEnd start detached) waits this long without hook activity in the repo |
| `EDEN_SLEEP_HEAVY` | 30 min (1800000 ms) | `0` / `off` never mines from the idle sleeper. A plain integer is milliseconds. Once the repo's hooks have been quiet this long, the idle sleeper runs the heavy tier: it mines the repo's lockfiles, manifests and CI files into cited facts. SessionStart also starts `eden sleep --heavy` detached, which mines at once. With `EDEN_SLEEP_IDLE` `0` / `off` no detached sleeper starts at all, SessionStart's included: the repo's files are then mined only by a manual `eden sleep` |
| `EDEN_SLEEP_BUDGET` | 25ms incremental budget | A non-negative number of milliseconds. Blank, non-finite, or negative stays 25 |

`EDEN_SLEEP_EVERY` and `EDEN_SLEEP_BUDGET` steer the wrap's in-process sleep; the hook never sleeps in-process.

### Import

```bash
eden memory import <path>
eden memory import --dry-run <path>
```

Reads a JSONL or JSON transcript file or directory into local memory, each record into the store of the repo it ran in (its cwd, else this folder). `--dry-run` counts records and does not write. Off and read-only do not write. Missing or unreadable paths exit 0. No NVIDIA. No cloud.

### Hooks

On Claude Code, `eden setup` writes the ten memory events `eden doctor` checks: UserPromptSubmit, SessionStart, SubagentStart, PreCompact, PostCompact, Stop, SessionEnd, PostToolUse, SubagentStop and InstructionsLoaded, plus PostToolBatch, which records each tool batch (PostToolUse then leaves the recording to it). On Gemini CLI, Codex and OpenCode it writes the equivalents each host has. Its hooks call `eden hookd` when it runs (`eden wrap` starts it too) and fall back to `eden hook`.

Besides memory, `eden hook` still runs the retired compile-era tool recorder, and `eden setup` still installs its PreToolUse hook on every host. Each tool call's redacted arguments and result are written to `~/.eden/runs/`. Once `~/.eden/config.json` holds a key (the first `eden wrap`, `eden login`, or `eden setup` given a key writes one), tool stretches are posted to that wrap's `/v1/traces`: loopback by default, a remote host after `eden login --url …`. Once you have approved a compiled tool (`~/.eden/live-tools.json`), the PreToolUse hook can steer or deny a call, PostToolUse can replace a call's result, and PostToolBatch can add context, to serve it. With a key, setup also writes `.mcp.json` in the current folder.

The Claude plugin runs memory only. It registers its own set ([plugins/eden-memory/README.md](../../plugins/eden-memory/README.md)): PostToolBatch instead of PostToolUse, plus FileChanged, CwdChanged, the PreToolUse policy guard and the PreToolUse(Agent) hook that records a subagent's task paths. Do not enable the Claude plugin and `eden setup` together — both attach UserPromptSubmit.

`eden doctor --memory` prints only the memory section and exits 0 when every line is ok: the hooks registered, the installed eden-memory plugin (enabled, and the same as the checkout it runs), a probe that runs that plugin's hook on a Submit (Eden loads in-process, median of 3 within 150 ms), the fallbacks the plugin logged, and how the store is keyed (repo key, scope catalog, guard).

## Compiled tools (retired)

The commands under "compile traces into a tool" in `eden --help` (`compile`, `import`, `explain`, `approve`, `play`, `demo`, `claims`, `savings`, and `promote`, `schedule`, `audit`, `archive`, `know` under `eden help -a`) belong to Eden's earlier tool-path compiler. They still run and their tests still pass, but they are not the product. Their documents are in [archived/compile-era/](../../archived/compile-era/README.md); the example traces are in [examples/compile-traces/](../../examples/compile-traces/README.md).
