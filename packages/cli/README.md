# eden

CLI that compiles repeated agent tool stretches into one inspectable program.

Needs [Bun](https://bun.sh). Compile does not Approve. A key never turns a tool On. This package is not published to a public registry.

From this clone:

```bash
bun install
alias eden='bun packages/cli/src/cli.ts'
eden --help
eden wrap
eden demo          # TicketShip T-100 sitting
eden compile --traces <dir>
```

Hosted wrap: https://useeden.vercel.app — `POST /v1/signup`, then `eden login --url https://useeden.vercel.app --key <key>`.

Point an agent at `OPENAI_BASE_URL=http://127.0.0.1:8788/v1` (local wrap) or the hosted `/v1`. Keep `OPENAI_API_KEY` as the model key. An Eden key is wrap auth, not OpenAI. The hosted `/v1` refuses a chat call without your own provider key; it never pays for model calls.

## Memory

Local notes for the agent. Default is **on**. Nothing here calls NVIDIA or a cloud memory service. There is no forget HTTP route, no Memorable product, and `memory_search` is not the default loop. Memory does not put a 60ms CLI in front of wrap.

### Three states

`EDEN_MEMORY` (`src/memory-consent.ts`). Unset, empty, `1`, `on`, `true`, or `yes` is **on**.

| State | Set | What it does |
|---|---|---|
| on | unset (default) | Recall and write |
| read-only | `readonly`, `read-only`, or `ro` | Recall existing notes. No write |
| off | `0`, `off`, `false`, or `none` | Identity. Inject returns the original body. No encode |

Unknown values fail open to on.

### Store

JSONL under `EDEN_MEMORY_DIR`, or `$EDEN_HOME/memory`, or `~/.eden/memory`.

`EDEN_MEMORY_CAP` is retrieve k (default **6**), not store size. A set value stays in the 6–10 packet band. `EDEN_MEMORY_STORE_CAP` is the JSONL cap (default **2000**).

`EDEN_MEMORY_MIN` (default **0.15**) omits inject when the best on-cue aboutness is below that floor. SessionStart still briefs pins and gists. Unset, empty, NaN, or negative stays 0.15.

`EDEN_MEMORY_LOG=1` prints note ids and relative ages to stderr. Default off. `EDEN_MEMORY_SWALLOW=1` prints inject swallows to stderr. Default off. `EDEN_MEMORY_INJECT_LOG` is a metric file path; unset writes nothing.

`EDEN_MEMORY_AGENT` and `EDEN_MEMORY_PROJECT` isolate a store (project falls back to cwd). `EDEN_MEMORY_SESSION` or `EDEN_MEMORY_PARENT` names the wrap session file. `EDEN_MEMORY_CHILD` opens that session’s child file (`parent--child`). The hook reads the same three names when the payload has no session id.

### Sleep

Consolidation budgets in `src/sleep.ts`.

| Env | Unset | Other values |
|---|---|---|
| `EDEN_SLEEP_EVERY` | 32 turns | `0` / `off` disables. `"8"` is 8 turns. `"64k"` (also `kb` / `mb` / `b`) is a byte threshold and sets turns to 0 |
| `EDEN_SLEEP_IDLE` | 5 min (300000 ms) | `0` / `off` disables idle full-sleep. A plain integer is milliseconds |
| `EDEN_SLEEP_BUDGET` | 25ms incremental budget | A non-negative number of milliseconds. Blank, non-finite, or negative stays 25 |

### Import

```bash
eden memory import <path>
eden memory import --dry-run <path>
```

Reads a JSONL or JSON transcript file or directory into local memory. `--dry-run` counts records and does not write. Off and read-only do not write. Missing or unreadable paths exit 0. No NVIDIA. No cloud.

### Hooks

`eden setup` installs seven memory events. `eden doctor` lists the same seven: UserPromptSubmit, SessionStart, PreCompact, Stop, SessionEnd, PostToolUse, SubagentStop. Memory stays on unless you set `EDEN_MEMORY`. Do not enable the Claude plugin and `eden setup` together — both attach UserPromptSubmit.
