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
| `eden setup` | Write the memory hooks for Claude Code, Gemini CLI, Codex and OpenCode, whichever are present. Not together with the Claude plugin |
| `eden doctor --memory` | Memory only: hooks, plugin copy, load time, flags, breaker, kill switches. Exits 0 when every line is ok |
| `eden doctor` | Everything, memory included; names each extra host as ok, half-wired, skipped or not installed |
| `eden memory remember [--global] "<text>"` | Store what a statement says now. `--global` keeps only its rules, for every repo. `--jsonl -` reads `{"text", "kind"?, "cwd"?, "scope"?}` lines from stdin |
| `eden memory dump [--json]` | Print every row under the memory root and every window's ledger records |
| `eden memory purge <regex>`, `eden memory forget --secret <regex>` | Rewrite every file under the memory root with each match replaced by `[REDACTED]`, and list the Claude Code transcripts that still hold one (Eden never edits them) |
| `eden memory forget --all-in <scope>` | Send every rule stored for one folder scope of this repo to history |
| `eden memory scopes [--json] [<path>…]` | Build this repo's folder-scope catalog from its files now, and say which repo and scope each path belongs to |
| `eden memory import [--dry-run] <path>` | Read JSONL or JSON transcripts into memory |
| `eden memory migrate [--dry-run \| --apply \| --rollback \| --contract]` | Move stores written before per-repo memory (one per session) into per-repo stores |
| `eden sleep` | Run a full sleep on this repo's store now: consolidate, then mine the repo's files |
| `eden eval build-negatives [--label \| --freeze]` | Build your private set of prompts that need no memory, from your own transcripts, in `~/.eden/eval` |
| `eden hook`, `eden hookd` | Hook entry point, and the daemon that answers the hooks `eden setup` writes (they fall back to `eden hook` when it is down) |
| `eden wrap` | The local proxy (`127.0.0.1:8788`): memory for OpenAI-compatible agents |

## Memory

Default is **on**. No hook calls a model or an embedding service, and the store never leaves the machine. Delivery is silent injection: there is no memory UI, and `memory_search` is not the default loop.

### Three states

`EDEN_MEMORY` (`src/memory-consent.ts`). Unset, empty, `1`, `on`, `true`, or `yes` is **on**.

| State | Set | What it does |
|---|---|---|
| on | unset (default) | Recall and write |
| read-only | `readonly`, `read-only`, or `ro` | Recall existing notes. No write |
| off | `0`, `off`, `false`, or `none` | Identity. Inject returns the original body. No encode |

Unknown values fail open to on.

### Store

JSONL under `EDEN_MEMORY_DIR`, or `$EDEN_HOME/memory`, or `~/.eden/memory`. One store per repo, `<dir>/repos/<key>/`, keyed by the repo's git common dir, so every session, worktree and subagent of a repo shares it (outside git, by the folder a session starts in). Each context window keeps its ledger in `<dir>/windows/<window>/`. Directories `0700`, files `0600`.

`EDEN_MEMORY_CAP` is retrieve k (default **6**), not store size. A set value stays in the 6–10 packet band. `EDEN_MEMORY_STORE_CAP` is the JSONL cap (default **2000**).

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
| `guard.ask` | The guard asks you before an irreversible command a rule forbids | off | `EDEN_POLICY_GUARD` |

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

`eden setup` installs the ten memory events `eden doctor` checks: UserPromptSubmit, SessionStart, SubagentStart, PreCompact, PostCompact, Stop, SessionEnd, PostToolUse, SubagentStop and InstructionsLoaded. On Claude Code it also installs PostToolBatch, which records each tool batch, and PostToolUse leaves the recording to it. Its hooks call `eden hookd` when it runs (`eden wrap` starts it too) and fall back to `eden hook`. The Claude plugin registers its own set, which adds FileChanged, CwdChanged and the PreToolUse guard ([plugins/eden-memory/README.md](../../plugins/eden-memory/README.md)). Do not enable the Claude plugin and `eden setup` together — both attach UserPromptSubmit.

`eden doctor --memory` prints only the memory section and exits 0 when every line is ok: the hooks registered, the installed eden-memory plugin (enabled, and the same as the checkout it runs), a probe that runs that plugin's hook on a Submit (Eden loads in-process, median of 3 within 150 ms), the fallbacks the plugin logged, and how the store is keyed (repo key, scope catalog, guard).

## Compiled tools (retired)

The commands under "compile traces into a tool" in `eden --help` (`compile`, `import`, `explain`, `approve`, `play`, `demo`, `claims`, `savings`, and `promote`, `schedule`, `audit`, `archive`, `know` under `eden help -a`) belong to Eden's earlier tool-path compiler. They still run and their tests still pass, but they are not the product. Their documents are in [archived/compile-era/](../../archived/compile-era/README.md); the example traces are in [examples/compile-traces/](../../examples/compile-traces/README.md).
