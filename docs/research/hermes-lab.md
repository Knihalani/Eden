# Hermes Agent with and without Eden: the lab harness

Status: 2026-11-02. Harness built and smoke-tested on free models. The full bench has not run.

Every number below comes from a command run this session. Estimates are labelled.

## What it compares

Hermes Agent ([NousResearch/hermes-agent](https://github.com/NousResearch/hermes-agent), commit `06433066`) is an open
source personal agent. The bench compares two arms on the same tasks.

**`hermes`:**
- Hermes with one MCP server, `sources`: a read-only `search_<source>` tool per sim source (pi-ab's `tools`).
- Every one of Hermes' own toolsets is off: terminal, files, web, browser, code, memory, skills, delegation and cron.
  The agent is read-only, and the arms differ only in Eden.

**`hermes+eden`:** the same Hermes, plus Eden through Hermes' own two extension surfaces.
- **Eden's MCP server** (`createMcpServer`, `ask_context`; the guided description with `askGuard`).
- **The Eden plugin** (`packages/sim/lab/hermes/eden`), with three hooks:
  - `pre_llm_call` observes the turn and injects Eden's packet into the user message, as Hermes does with any plugin
    context;
  - `post_tool_call` reports each tool result to Eden;
  - `transform_tool_result` appends packets Eden queued since then, so context found mid-task reaches the agent
    before its next request.
- **Fail-open:** any error, timeout or refusal is "no context" (tested).

## How it runs (`hermes-ab.ts`)

- **Hosting:** the Bun process holds the sim sources and a `ContextPartner` per stream (a world under one condition),
  as `pi-ab.ts` does, and serves them on localhost (`hermes-host.ts`).
- **Workers:** each stream runs one Python worker on Hermes' venv (`packages/sim/lab/hermes/worker.py`), with its own
  `HERMES_HOME`. Each task gets a fresh `AIAgent` with:
  - no memory, no context files and no background review;
  - a fresh session, its id stamped with the sim clock, because Hermes dates its prompt from that stamp.
- **Model endpoint:** Hermes' `base_url` is the Bun process.
  - Every chat completion goes to OpenRouter through the run's pacer: rate, `--max-requests`, 429 backoff.
  - Each request is reserved against `--budget` and capped at 2,000 output tokens.
  - Its tokens, cost and timing go on the task's timeline.
  - The API key never reaches Python.
- **Output:** results and timeline match pi-ab's, so `pi-ab-report.ts` and `agent-ab-report.ts` read them. The report
  pairs `hermes+eden` with `hermes`.

### Setup

```bash
git clone https://github.com/NousResearch/hermes-agent $HERMES
cd $HERMES && uv sync --frozen --no-install-project --extra mcp   # locked deps only, the project is not built
```

### Hermes settings the harness relies on

| Setting | Why |
|---|---|
| `enabled_toolsets: [mcp-sources(, mcp-eden)]` | Only the MCP tools are sent (checked: 5 tools in `hermes`, 6 in `hermes+eden`) |
| `tools.tool_search.enabled: off` | Hermes' default hides MCP tools behind `tool_search`/`tool_call` meta-tools |
| `discover_mcp_tools()` once per worker | A bare `AIAgent` does not connect MCP servers; the CLI does |
| `plugins.enabled: [eden]` | General plugins are opt-in |
| `NO_PROXY=127.0.0.1` | Hermes' HTTP client otherwise sends local calls to the machine's HTTPS proxy |
| Session id `YYYYMMDD_HHMMSS_…` from the sim clock | Hermes stamps "Conversation started:" from it before any clock |

## Smoke (free models, 27 requests, $0)

- Agent `nvidia/nemotron-3.5-super-vl:free`, grader `dots-studio/dots-3-note-preview:free`, ALL3.
- Task: dev6a seed 41, hidden variant, `second-signature`.
- Cards replayed from disk.

| | hermes | hermes+eden |
|---|---|---|
| Hidden fact raised | no | yes (from `ask_context`, citing the planted Slack item) |
| Model requests | 3 | 2 |
| Tool calls | 8 | 7 (one `ask_context`) |
| Prompt / output tokens | 10,258 / 761 | 6,812 / 509 |
| First request's input tokens | 2,782 | 3,039 |
| Wall | 13.3 s | 14.0 s |
| Eden items injected | 0 | 2 |

Checked in the forwarded requests (`--dump`):
- **Tools:** only the MCP tools.
- **Date:** "Conversation started: Tuesday, October 27, 2026", the sim date. Before the session-id fix it was the
  machine's date.
- **Packet placement:** Eden's packet is in the user turn, in its data envelope.
- **No cross-task leakage:** a stream's second task starts from two messages (system and user).

Also seen:
- **Fresh agents cost time:** about 4.8 s of each task's wall time, before the first request, in both arms, is Hermes
  building a fresh agent.
- **Hermes' fixed prompt:** about 8,100 characters, plus the tool schemas. Its first request is about 2,800 tokens,
  against Pi's whole-task mean of 3,579 (D64).
- **A rerun differs:** on a rerun of the same task in the Eden arm the fact was not raised (n=1 each, free model).

**Unverified:** in one smoke, Hermes sent 3 requests but 2 were booked. A stream Hermes stops reading never reached
the booking code. The proxy now books a request when its stream ends, fails or is cancelled. That fix has not run live.

## Estimates for the full bench

These are estimates from the smoke, not measurements.

- **Size:** all nine hidden-context suites, seeds 41–44, both variants, is 1,168 tasks an arm (D64's task set), so
  2,336 tasks for the two arms.
- **Requests per task:** 2–3 agent requests plus 1 grading request, so 3–4.
- **Free models:** about 8,000–9,000 requests. At the free tier's 1,000 a day, that is 8–9 days. One day buys about
  125 paired tasks.
- **Paid, agent on `z-ai/glm-5.3-flash`** ($0.15 / $0.50 per million tokens):
  - from the smoke's tokens, about $0.0013 (Eden) to $0.0019 (Hermes) of agent cost a task;
  - grading on deepseek-v4.1-flash adds about $0.00016 a task (D64);
  - about $4–6 for the whole bench, from token counts measured on a different model.
- **Pi comparison:** Hermes' prompt makes each request about 3× Pi's input tokens.

## Full bench command

```bash
bun packages/sim/src/lab/hermes-ab.ts --hermes-src $HERMES \
  --suite hidden,heldout,heldout2,heldout3,heldout4,heldout5,heldout6,heldout7,heldout8 \
  --seeds 41,42,43,44 --variants hidden,control --conditions hermes,hermes+eden --config ALL3 \
  --cards packages/sim/lab/cards/cards-v2.jsonl --model z-ai/glm-5.3-flash --grader deepseek/deepseek-v4.1-flash \
  --budget 7 --concurrency 6 --out hermes-full.json
bun packages/sim/src/lab/pi-ab-report.ts hermes-full.json
```

Free models: add `--model nvidia/nemotron-3.5-super-vl:free --grader dots-studio/dots-3-note-preview:free --card-model
nvidia/nemotron-3.5-super-vl:free --allow-logging --rpm 18 --max-requests 950` and run one seed or suite a day.
