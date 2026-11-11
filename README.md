# Eden

**A context partner for agents.** Eden runs beside a personal or proactive agent, reads the user's connected sources
(mail, calendar, docs, CRM, memory stores, anything with MCP read tools), answers the agent's questions, and puts the
context the agent needs in front of it before it knows to ask. Most of the time it stays silent.

- **Not a subagent.** A subagent only answers what the agent thinks to ask. Eden watches the session and speaks first.
- **Model as last resort.** Cues, a learned source map and a local index decide most turns, with no model call.
  With `OPENROUTER_API_KEY` set, one model (`EDEN_MODEL`, default Claude Haiku 5.5 via OpenRouter, ZDR routing) writes
  implication cards and the intent index in the background, under per-session budgets and a per-tenant daily cap. For
  a request that acts or opens like an instruction, Eden hands the agent the five best candidates it found, framed to
  be checked against the
  request, with no model call of its own (D237); without a key the same default runs its no-model path, the
  candidates included (D276).
- **Read-only, per-user, redacted.** It never calls a write tool; users never share state; secrets are scrubbed
  before anything is stored or sent to a model.

Start with [docs/VISION.md](docs/VISION.md) and [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md).

## See it first (one command, no key, $0)

```bash
bun install && bun run demo
```

The demo builds a simulated user (about 1,500 items of mail, calendar, docs, CRM and chat with a few things planted
that change what a good assistant should do), starts the real server on it with no model key, and sends a short day
of requests through the client. For each one it prints what Eden put in front of the agent before its first model
call, whether that was the fact the request needed but did not say ("Pay Dean's invoice to the new bank details" →
Dean's warning that his inbox was compromised), and why, from `/v1/explain`; chatter gets nothing. With
`OPENAI_API_KEY` (and `OPENAI_BASE_URL`, `AGENT_MODEL` for any OpenAI-compatible endpoint) an agent model answers
each request without and with Eden's context. Its three requests are picked: across six training suites and two
seeds the same no-key path caught the deciding item for 208 of 384 requests (D292). `bun run demo --trace demo.log
&& bun run digest demo.log` shows the report you would give stakeholders from your own server's log (D293).

## Quick start (five minutes, no model key, $0)

Needs [Bun](https://bun.sh) 1.4+ (`bun.lock` is lockfile format 2, which Bun 1.3.14 refuses), or Docker:
`docker build -t eden .` then `docker run -p 127.0.0.1:8790:8790 -e EDEN_DEV=1 eden` (the `Dockerfile` header has the
production flags; D280). Everything below runs without any API key: Eden's default answers from its
no-model path, and for a request that acts or opens like an instruction it hands the agent candidates to check
(D237, D276, D710).

```bash
bun install

# Terminal 1: the API with two example sources (a calendar and a mailbox) and no auth.
EDEN_DEV=1 EDEN_PROCESSES=1 EDEN_SOURCES_FILE=examples/personal-agent/sources.json EDEN_TRACE=1 bun run dev | tee server.log

# Terminal 2: a question, a request that acts, and why Eden spoke or stayed silent.
curl -s -X POST 'localhost:8790/v1/events?waitMs=3000' \
  -d '{"userId":"u","sessionId":"s","kind":"user_message","text":"What time is lunch with Priya Raman?"}'
curl -s -X POST 'localhost:8790/v1/events?waitMs=3000' \
  -d '{"userId":"u","sessionId":"s","kind":"user_message","text":"Move lunch with Priya Raman to Friday"}'
curl -s -X POST localhost:8790/v1/pending -d '{"userId":"u","sessionId":"s"}'     # the candidates packet
curl -s -X POST localhost:8790/v1/ask -d '{"userId":"u","sessionId":"s","question":"Where is lunch with Priya?"}'
curl -s -X POST localhost:8790/v1/explain -d '{"userId":"u","sessionId":"s"}'     # why, per decision (no content)

# A whole agent loop against it (offline stub model without OPENAI_API_KEY), and the MCP tool over stdio:
bun examples/personal-agent/agent.ts "move lunch with Priya Raman to Friday"
EDEN_USER=u EDEN_TENANT=t EDEN_SOURCES_FILE=examples/personal-agent/sources.json bun packages/server/src/mcp-stdio.ts

# Stop terminal 1, then: what Eden did and cost on that traffic (D279).
bun run trace-report server.log    # the server's output, saved by `tee` above
```

Four things that tripped first-time users (fresh-eyes walkthroughs, D856):

- **Another port:** `PORT=8711 bun run dev` moves the server; set `EDEN_URL=http://127.0.0.1:8711` for everything
  else (both clients, the examples, and the proxy read it when no base URL is passed).
- **Keys in dev mode:** with `EDEN_DEV=1` pass no API key at all (unset `apiKey`/`api_key`, no `EDEN_API_KEY`): a dev
  server accepts a missing key and refuses any made-up one with a 401.
- **Staying at $0:** the startup line says `model roles on` when `OPENROUTER_API_KEY` is in the server's environment,
  and Eden then makes paid model calls in the background. Start it with `env -u OPENROUTER_API_KEY …` to stay on the
  no-model path.
- **One `sessionId` per conversation:** an item is handed out once per session, so a second script (or the curls
  above) reusing `"s"` gets `(shown above)` instead of the text. Use a fresh session id per run or conversation.

What you see: the first request gets a packet (`injection.text`, the `<context …>` envelope your agent puts before
its model call) and `pending: true` (slower work may queue more for `/v1/pending`). An item is delivered once per
session, so the later `/v1/ask` cites the same items as `(shown above)` rather than repeating them; ask in a new
`sessionId` to see their text again. Your agent is in its own repository? `bun run pack:client` writes the
TypeScript client as a standalone package (`npm install /path/to/Eden/dist/eden-client`; the workspace package cannot
be installed from outside, D365), and Python uses `pip install /path/to/Eden/packages/client-python`.

Then point Eden at your users' real connectors (`EDEN_USER_SOURCES_FILE`, docs/INTEGRATION.md "Connect each user's
own sources"; presets such as `{"preset": "gmail", …}` name a common server's read tools for you, D294), set `EDEN_API_KEYS` instead of `EDEN_DEV`, and optionally `OPENROUTER_API_KEY` for the background
cards and intent index. Developing Eden itself: `bun run check` (format, types, tests) and `bun run eval` (the
no-model scenario metrics); `OPENROUTER_API_KEY=… bun run eval --live --usd-cap 0.05` is the shipped wiring with a
hard spend cap (D128).

## Integrating an agent

**One line: put Eden in front of your model.** With the server above running,
`EDEN_PROXY_UPSTREAM=https://api.openai.com/v1 bun run proxy` serves an OpenAI-compatible endpoint on
`http://127.0.0.1:8791/v1` (`PROXY_PORT` moves it; against a keyed server add `EDEN_API_KEY`, and `EDEN_URL` if it is
not on `127.0.0.1:8790`); point your agent's `base_url` there and send `x-eden-user-id` (or the body's `user`). At
startup it prints whether it reached Eden. Each chat request's new messages are reported to Eden and its context is
inserted before the latest user message, and kept there on later turns (D336); the answer streams back unchanged, and
with Eden down the request goes through as it came (D280). Agents on Anthropic's Messages API use the same proxy:
`EDEN_PROXY_UPSTREAM=https://api.anthropic.com/v1`, the SDK's `base_url` set to `http://127.0.0.1:8791`, and Eden's
context arrives as a text block of the user's message (D653); OpenAI's Responses API (`/v1/responses`) is served
too (D656). Any OpenAI-compatible upstream works (OpenAI, OpenRouter,
Anthropic's `https://api.anthropic.com/v1`, a local server). For full control, use the SDK:

```ts
import { EdenClient, guardTools, withContext } from "@eden/client";

const eden = new EdenClient({ apiKey, userId, sessionId }); // a sent user message waits up to 3 s for its lookup
const { injection } = await eden.observe({ kind: "user_message", text });  // report each event
messages = withContext(messages, await eden.collect(injection));           // before each model call
const answer = await eden.ask("What did Dana say about the renewal?");     // or expose as a tool
const tools = guardTools(eden, { send_email, book_meeting });              // acting tools: checked before each call
await eden.sourceChanged("gmail", { refs: changedMessageIds });            // a connector's change notice: send its refs
```

Wrap the tools that send, book, pay or share with `guardTools`: Eden's party check only sees calls it is shown, and
a finding comes back to the agent as the tool's result (D376, D420). Forward change notices with the refs (or items)
they name, not a bare "changed" signal, which makes Eden re-read and slows the agent's asks (D347, D421). On Hermes
Agent, use the plugin in `examples/hermes` with Eden in place of the source tools (D422).
Python agents use `packages/client-python` (`eden_client`: the same calls, `guard_tools` included, standard library
only, fail-open, D278).
Debugging: `eden.explain()` (or `POST /v1/explain`) lists the session's last decisions with a sentence each on why
Eden spoke or stayed silent, never content (D277); `bun run trace-report` summarises an `EDEN_TRACE=1` log, and
`bun run digest` turns it into a content-free "what Eden added and whether the agent used it" report (D293).
Security review: [docs/THREAT-MODEL.md](docs/THREAT-MODEL.md).
MCP-capable agents can also use the `ask_context` tool: `bun packages/server/src/mcp-stdio.ts` serves it over stdio for
one user (`EDEN_USER`, `EDEN_TENANT`), and `createMcpServer` attaches it to any other MCP transport. A full loop:
[examples/personal-agent/agent.ts](examples/personal-agent/agent.ts), run with the dev server above; without
`OPENAI_API_KEY` it runs a scripted offline model, free.
[docs/INTEGRATION.md](docs/INTEGRATION.md) has advice on placement, caching and cost (unmeasured).

Without a wait, a user message's observe replies before a slow lookup ends and its context misses the first model
call, so the client waits up to 3,000 ms on each sent user message by default (D105, D112) and the server replies as
soon as the lookup ends; `defaultWaitMs: 0` (or `waitMs` per call) overrides it, see
[docs/INTEGRATION.md](docs/INTEGRATION.md).

Both servers run the engine's one default (`DEFAULT_CONFIG`, D112), the best measured configuration: probes, the
no-model grounds, background sync, implication cards, the intent index and the push's candidates for the agent to
judge (D237; the ask-time reader is wired but called only with `pushCandidates: 0`). With `OPENROUTER_API_KEY` set,
the cards, the intent index and the reader run on `EDEN_MODEL` (default
`anthropic/claude-haiku-5.5`), each role under its own budget and all of a tenant's roles under one cap per UTC day
(`EDEN_MODEL_USD_PER_TENANT_DAY`, default $25); no judge is wired. Without a key no role is built and the same default
answers from its no-model paths; the push's candidates make no model call and run there too (D276). The HTTP server
runs one process per core by default (`EDEN_PROCESSES`, the core count capped at 64, D178), each user pinned to
one, and every process holds 1/N of each per-tenant cap (the $25 model
cap, `EDEN_TENANT_RPS` 200 and `EDEN_TENANT_BURST` 400): on 4 cores a tenant whose traffic comes from one user gets
$6.25 a day, 50 rps and a burst of 100. Raise the caps or set `EDEN_PROCESSES=1` for such a tenant; in a container
with a CPU quota set `EDEN_PROCESSES` to the quota (see [docs/INTEGRATION.md](docs/INTEGRATION.md), "Processes"). To change a setting, or take a part out (`PARTS` in `packages/engine/src/parts.ts`),
point `EDEN_ENGINE_CONFIG` at a JSON file of engine settings (`packages/engine/src/config.ts`); an unknown key, a wrong
type, a number out of its range or a setting that would do nothing stops startup with a message naming it (D103).
Trial switches (such as the action firewall, `actionCheck`) stay off until measured;
[docs/profiles/](docs/profiles/README.md) holds "default minus a part" files, and docs/DECISIONS.md lists the trials
with their owners and end dates.
`EDEN_SOURCES_FILE` holds static documents only, since that file's sources are shared by every user. Each user's MCP
connectors, with their own credentials, go in `EDEN_USER_SOURCES_FILE` or an embedding's `SourceDirectory` (D108,
docs/INTEGRATION.md).

## Repository

| Path                | What it is                                                                                         |
| ------------------- | -------------------------------------------------------------------------------------------------- |
| `packages/protocol` | Wire types, ids, validation                                                                        |
| `packages/engine`   | The partner: cues, cache, two-speed pipeline, the default's parts, learning                        |
| `packages/sources`  | Source interface, MCP read-only source, fan-out                                                    |
| `packages/graph`    | Source map: who holds which entities, what helps when                                              |
| `packages/llm`      | OpenRouter client, pricing, budgets and the per-tenant daily cap                                   |
| `packages/redact`   | Secret gate                                                                                        |
| `packages/server`   | HTTP API and MCP server; runs the default and wires the model roles                                |
| `packages/client`   | SDK for agent builders (TypeScript)                                                                |
| `packages/proxy`    | Proxy in front of the agent's model, OpenAI chat completions and Anthropic Messages (`bun run proxy`) |
| `packages/client-python` | The Python client (`eden_client`, standard library only)                                      |
| `packages/eval`     | Scenario harness and metrics                                                                       |
| `packages/sim`      | Simulated users and the lab; `bun run demo`                                                        |
| `docs/`             | Vision, architecture, decisions, roadmap, cost, privacy, research                                  |
| `archived/`         | Earlier products (passive memory for coding agents; compile era; observability). History, not code |

## Status

M0 (scaffold) done; M1, an eval worth tuning against, in progress, with every measured result in
[docs/research/INDEX.md](docs/research/INDEX.md). See [docs/ROADMAP.md](docs/ROADMAP.md). Nothing is published to
npm, PyPI or an image registry yet: install from a checkout as above (`bun run pack:client`, `pip install
./packages/client-python`, `docker build`).
