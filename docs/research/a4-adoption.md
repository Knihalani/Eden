# A4: why a team would not adopt Eden, and what was fixed (2026-11-07)

Session A4 of the afternoon audit ([audit-1107-plan.md](audit-1107-plan.md)), decisions D276–D280. Branch
`claude/a4-adoption` from `claude/lucid-hypatia-v9wqk5` (c7cfc8fc9). Spend: about $0.0005 (three Haiku calls checking the proxy live through Anthropic's OpenAI-compatible endpoint: 677
input and 772 output tokens at `pricing.ts`'s rates; everything else $0).

## In plain words

I played an engineer at a company building a personal agent, deciding whether to adopt Eden: cloned it, followed the
README and INTEGRATION.md, started the server with and without a model key, called it with curl, the TypeScript
client, the example agent, MCP over stdio, and a container. The biggest reasons to say no were: the free path (no
model key) was a different, weaker product than the one the docs describe; when Eden stayed silent there was no way to
ask why; only TypeScript had a client; there was no way to measure Eden's cost and latency on your own traffic; and
there was no supported way to host it. Those five are fixed. Beyond the blockers I asked what would make a team *want* Eden, and built the strongest idea:
an OpenAI-compatible proxy, so adding Eden is changing the model's base URL, with a shadow mode that lets a team try
it on real traffic without changing a single answer. What is left is mostly trust work (a security review,
verifying the model provider's data terms, real-user quality numbers) and connectors (Eden reads MCP servers you
bring; it ships none of its own).

## The blockers, ranked by how likely each stops adoption

Status: **fixed** here, **partly** fixed, or **open**.

| # | Blocker | Why it stops a team | Status |
|---|---|---|---|
| 1 | **The no-key server was not the product.** D237 made the push hand the agent five candidates with no model call, but the push still required the reader dependency, which is only built with `OPENROUTER_API_KEY`. So the free path most teams try first ran no push: an acting request got nothing unless a no-model rule fired. | A trial that misrepresents the product ends the evaluation. | **Fixed (D276).** The candidates run with no reader. `bun run eval` (no-model wiring) now equals D237's keyed live eval (precision 0.5909, recall 0.52, falseFireRate 0); funnel train1–6 seeds 41–42 with no cards and no intent: hidden facts delivered before the agent's first model call 93 → 202 of 384, decoys 73 → 190 (the same D3 trade D237 accepted). |
| 2 | **No "why did Eden say this / stay silent".** Traces existed only as a server-wide log (`EDEN_TRACE=1`) keyed by session id alone, with fixed reason words only a reader of `partner.ts` understands. | Debugging a silent context partner is impossible; support tickets cannot be answered. | **Fixed (D277).** `POST /v1/explain` and `explain()` in both clients: the session's last 32 decisions, each with a plain sentence, counts, cost and item ids, no content, scoped like every route. |
| 3 | **TypeScript only.** Most agent stacks are Python. | A team would have to write and maintain its own fail-open client. | **Fixed (D278).** `packages/client-python` (`eden_client`): the same calls, stdlib only, fail-open on every shape, `eden_id` identical to `edenId` (tested), run end to end against the real handler in `bun run test`. Async: wrap with `asyncio.to_thread` (no native async client yet). |
| 4 | **No way to check cost and latency on your own traffic.** Every figure in the docs is from simulated worlds. | Finance and SRE sign-off needs numbers from their traffic. | **Partly fixed (D279).** `bun run trace-report` reads an `EDEN_TRACE=1` log: spoke/silent and why, time to a decision per kind (p50/p95/p99), source and model calls per event, request-time spend. Background card and intent spend is not traced (left: a per-tenant spend endpoint). |
| 5 | **No supported hosting.** No Dockerfile; README said Bun 1.3+, but `bun.lock` is format 2 and Bun 1.3.14 refuses it; dev mode (no auth) could listen on 0.0.0.0 silently. | An ops team cannot deploy what it cannot build. | **Fixed (D280).** Root `Dockerfile` (built and run: 409 MB, healthy, `/data` volume), README says Bun 1.4+, `packageManager` 1.4.4, a stderr warning for `EDEN_DEV=1` beyond loopback. |
| 6 | **The quickstart confused.** It started with `bun run check` (30 s of tests), its ask asked about "Dana", whom the example sources do not hold ("Nothing in the connected sources."), and the dev server forked a process per core. | First five minutes decide whether a team keeps looking. | **Fixed (D280).** A $0, no-key block that runs as written: question, acting request, pending, ask, explain, the example agent, MCP stdio, trace-report; `EDEN_PROCESSES=1`. |
| 7 | **Trust and security review.** PRIVACY.md is candid, but: OpenRouter's ZDR and no-collection flags are still "to verify before launch"; the candidates (D237) send up to five unvetted redacted excerpts per acting request to the tenant's own model; prompt injection is handled by an envelope and `safeLine` (D221), with one fixed Eden instruction now inside it; no third-party security review or threat model document. | Security and legal review block many teams regardless of quality. | **Open.** Next: a one-page threat model (what Eden reads, stores, sends, to whom, for how long, how to delete), the OpenRouter verification probe, an injection test suite run against the candidates' packet. |
| 8 | **Connectors are bring-your-own.** Eden reads MCP servers with read tools; it ships no Gmail, Calendar or Drive connector and no OAuth flow. Per-user credentials go in a JSON file or an embedding's vault (`SourceDirectory`). | A team without MCP servers for its users' accounts has nothing to connect. | **Open.** Next: a worked example wiring a public Gmail/Calendar MCP server per user, and an OAuth-backed `SourceDirectory` example. |
| 9 | **Quality is measured on simulated worlds only.** Every hidden-fact and decoy number is from generated users; INTEGRATION.md is labelled "mostly unmeasured". | Teams want evidence on real data before shipping to users. | **Open** (by design until real users exist); `trace-report` lets a team measure silence and cost on theirs. |
| 10 | **Multi-tenant operations.** Tenant keys are an env var read at startup (rotation needs a restart); per-tenant caps are divided by `EDEN_PROCESSES`; in-memory user state is lost on a restart or a change of N; no admin API for spend or usage per tenant. | Fine for one tenant; awkward for a platform hosting many. | **Open.** Next: key reload on SIGHUP, a per-tenant usage endpoint. |
| 11 | **MCP-only agents get no push.** `ask_context` is the only MCP tool; Eden's unasked context (its main value) needs the HTTP `observe` events. | An MCP-only integration sees a search tool, not a context partner. | **Open** (documented in INTEGRATION.md "Other languages"). |
| 12 | **The docs are dense with decision numbers.** README and INTEGRATION.md are accurate but read as a lab notebook. | Slows evaluation; not a blocker on its own. | **Partly fixed:** the quickstart and the new INTEGRATION sections are plain; the rest is unchanged. |

## What would make a team want Eden (ideas, with estimated impact)

Estimates are judgement, not measurements.

| Idea | What it is | Why it pulls a team in | Effort | Status |
|---|---|---|---|---|
| **A. Eden in front of the model** | An OpenAI-compatible proxy: the agent changes its `base_url`, Eden sees the conversation and injects context; any language, any agent framework, no SDK | Integration drops from "learn our event model and wire five calls" to one config line. Covers the large majority of agents, which speak the OpenAI chat API. Highest impact | 1 day | **Built (D280)**: `bun run proxy`, 8 tests, one live run on Anthropic's OpenAI-compatible endpoint where a plain stdlib call with no Eden code got the hidden constraint |
| **B. Shadow mode** | The proxy reports and decides but injects nothing; `explain` and `trace-report` show what Eden would have added | Removes the risk objection: try it on production traffic for a week, read what it would have said, then switch injection on. Pairs with A | hours | **Built (D280)**: `EDEN_PROXY_SHADOW=1`, tested |
| **C. "Eden caught this" report** | Per tenant, the deliveries the agent then used (feedback and usage inference exist, D13, D18) with the turns they changed, as a weekly digest; built on `explain`'s traces | Turns "trust us, it helps" into evidence on their own users, which is what a buyer needs | 2–3 days | Not built. `trace-report` and `explain` are the base |
| **D. A five-minute demo world** | `bun run demo`: the sim's generated user (about 1,500 items over mail, calendar, docs, CRM, chat, `@eden/sim`) as sources, a scripted day of requests, and a side-by-side of the agent with and without Eden | Shows the value before any connector work; today the example has three documents | 1 day | Not built (the sim and the funnel already hold every piece) |
| **E. Connector presets** | One-line entries for standard MCP servers (`{"preset": "google-calendar", "token": {"env": …}}`) with tested search, list and fetch tool mappings, and an OAuth-backed `SourceDirectory` example | Blocker 8: most teams have no MCP servers for their users' accounts yet | 3–5 days | Not built |

Recommended next: D, then C (D shows value in five minutes; C proves it on their traffic), then E.

## What was done, and how it was checked

- **D276** (`partner.ts` `observe`, `config-check.ts`): the push starts when `askReader`, `readerPush` and either a
  reader or `pushCandidates` > 0. New tests in `push-candidates.test.ts` (no reader: candidates delivered; with
  `pushCandidates: 0` no push; an ask still answers; nothing constraint-like gives no packet; the config check accepts
  it). Three older tests that assumed a no-reader partner pushes nothing now set `pushCandidates: 0`. The keyed wiring
  is unchanged by construction (a reader is wired there, so the condition was already true), so no paid live eval was
  run; the no-model eval and funnel above are the measurement.
- **D277** (`trace.ts` `explainTrace`, `partner.ts` `Session.traces`/`explain`, `http.ts` `/v1/explain`,
  `client.ts` `explain`, protocol `ExplainedDecision`): tests in `explain.test.ts`, `http.test.ts` (no event or item
  text leaks, other users and sessions never shown, an ended session has none) and `client.test.ts` (each failure
  shape is `[]`).
- **D278** (`packages/client-python`): 9 Python unit tests, an end-to-end run against `createHandler`, and id parity.
- **D279** (`packages/server/src/trace-report.ts`, `bun run trace-report`): tests on synthetic and real traces.
- **D280** (`Dockerfile`, `.dockerignore`, README, `package.json`, `main.ts` warning): built and run in Docker here.
  `packages/proxy` (`createProxy`, `bun run proxy`, shadow mode): 8 tests with a fake upstream and the real handler;
  live runs through Anthropic's OpenAI-compatible endpoint (Haiku 5.5), before and after the review's rework; both
  replies named the mail constraint only the candidates packet carried. A second review's 12 findings (shrinking
  histories, a per-request deadline, proxy auth, keying, hop-by-hop headers, trace-report and parity nits) are fixed
  and tested (14 proxy tests).
- Walked as a newcomer: README block run as written; `examples/personal-agent/agent.ts` offline; MCP stdio
  `initialize`, `tools/list`, `tools/call`; the server with and without `OPENROUTER_API_KEY` (no paid call was made:
  no request was sent while a key was set).

## What is left (next steps, in order)

1. The demo world (idea D) and the "Eden caught this" report (idea C).
2. A threat model page and the OpenRouter ZDR verification (blocker 7).
3. A per-user Gmail/Calendar MCP worked example with an OAuth-backed `SourceDirectory` (blocker 8).
4. A per-tenant usage and spend endpoint covering the background roles, so `trace-report`'s gap closes (blocker 4).
5. Key reload without restart (blocker 10); an asyncio Python client if teams ask (blocker 3).
