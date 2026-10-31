# Economics research: facts found, total cost, end-to-end time (track econ-research, D71)

Status: 2026-10-31. A research track with no engine change: a survey of primary sources on what the state of the art and
real platforms do about Eden's three priorities, set against the full Pi benchmark (D64,
[pi-full-benchmark.md](pi-full-benchmark.md)), plus a re-analysis of that benchmark's recorded timelines. Live spend:
**$0** (no model call was made; OpenRouter's public endpoints API was read without a key).

The owner's priorities, in order: (1) **facts found**, the agent raises the decisive hidden fact; (2) **total cost**,
agent tokens, Eden's model calls, background enrichment and sync, runtime; (3) **end-to-end time** of the agent's task.
False concerns on control tasks must not rise meaningfully.

**Discipline.** Every re-analysis below reads only the D64 run files under the session scratchpad (`bench/`). Anything
split by suite uses the in-sample suites only (dev, held-out 1–4); held-out 5–9 were not read per task. Numbers taken
from the D64 summary (which covers all nine suites) are labelled "D64". Numbers from web sources are labelled with
their source and are the vendor's or authors' own claims, not measured here. Estimates are labelled as estimates.

**Outcome.** The track proposed its row as D65; the econ synthesis renumbered the plan's decisions D65–D71 in merge
order, and this track's is D71 (cost is reported billed and re-priced at a fixed endpoint). What became of each
recommendation in §8, as integrated; every number behind these is in-sample until the blind run:

| Rec. | Outcome |
|---|---|
| R1 pre-executed ask | Not adopted. The oneturn track found the agent's own ask adds facts even when the packet holds the fact (0.913 with the ask against 0.837 without, [econ-oneturn.md](econ-oneturn.md)); D70 keeps `ask_context`. |
| R2 threshold from uptake | Not adopted. oneturn's held-back items and decide's ordered list both converted poorly. Future work behind R8 first (D71). |
| R3 re-priced cost | Adopted (D71): `pi-ab-report.ts` prints cost billed and re-priced at fixed prices with each condition's endpoint mix (`reprice.ts`, [econ-lab.md](econ-lab.md)). |
| R4 coverage line | Not adopted. Alone it measured −0.037 hidden (−0.104..+0.030) in oneturn's size runs. |
| R5 trust the synced cache | Adopted as `syncPollBehind` (D65, [econ-judge.md](econ-judge.md)), off by default. |
| R6 push freshness | Adopted as `syncPush` (D66, [econ-background.md](econ-background.md)), off by default; the webhook route is a follow-up. |
| R7 pre-action check | Adopted as `actionCheck` (D69, [econ-firewall.md](econ-firewall.md)), off by default. |
| R8 supersession on graph edges | Future work; the first step before any R2 gate (D71). |
| R9 price-routed cards | Adopted as the card maker's `sort: "price"` (D66), with `cardsEconomy`; `max_price` not taken. |
| R10 tenant guide | [../INTEGRATION.md](../INTEGRATION.md), labelled as unmeasured advice. |

## Contents

1. [What the benchmark data already says (new re-analysis)](#1-what-the-benchmark-data-already-says)
2. [Agent latency and cost: caching, routing, output tokens, speculation, context engineering](#2-agent-latency-and-cost)
3. [Proactive and memory agents: when to inject](#3-proactive-and-memory-agents-when-to-inject)
4. [Pre-execution guardrails for tool calls (action firewalls)](#4-pre-execution-guardrails-for-tool-calls)
5. [Connector push APIs, quotas and the cost of freshness](#5-connector-push-apis-quotas-and-the-cost-of-freshness)
6. [Cheap structured extraction at scale](#6-cheap-structured-extraction-at-scale)
7. [Knowledge graphs and personal knowledge bases](#7-knowledge-graphs-and-personal-knowledge-bases)
8. [Top 10 recommendations, ranked](#8-top-10-recommendations-ranked)
9. [Commands](#9-commands)

## 1. What the benchmark data already says

Four findings from re-reading D64's per-request timelines (`tasks.jsonl`: per model request `in`, `out`, `cost`,
`firstTokenMs`, start and end; per-event spans) and per-task results (`pi-*.json`), joined to the funnel
(`funnel-ALL.json`). The scripts are in §9.

### 1.1 The cost comparison between conditions is confounded by OpenRouter's routing

OpenRouter load-balances `z-ai/glm-5.3-flash` across about 40 endpoints whose prices differ by up to 10× (endpoints API,
queried 2026-10-31: input $0.0163–0.50/M, output $0.0355–2.00/M; Z.AI's own endpoint $0.15/$0.50, cache read $0.03).
Matching each request's reported cost to an endpoint's price (within 3%) identifies the endpoint for 70–80% of the
29,518 agent requests in H and ALL. **The mix differs by condition, within the same concurrent run**: OpenInference
(fp4, $0.0172/$0.0355, the cheapest output) served 29% of `none` requests (no tools), 21% of `eden` (one tool) and 9%
of `tools` (five tools) in run H. Fewer tool definitions route more often to the cheapest endpoints.

Re-pricing every condition's tokens at one fixed endpoint removes the confound (agent only, all nine suites, D64 runs):

| Condition (run) | Calls / task | Input / task | Output / task | Billed $/1k | At Z.AI list $/1k | At Wafer-us $/1k |
|---|---|---|---|---|---|---|
| tools (H) | 3.34 | 3,579 | 921 | 0.320 | 0.998 | 0.342 |
| eden (H) | 2.28 | 2,313 | 886 | 0.291 | 0.790 | 0.279 |
| eden (ALL) | 2.20 | 2,233 | 869 | 0.318 | 0.770 | 0.272 |
| both (ALL) | 2.99 | 3,169 | 820 | 0.321 | 0.886 | 0.304 |
| none (H) | 1.00 | 113 | 486 | 0.097 | 0.260 | 0.102 |

At a fixed price the Eden agent costs **20–23% less than the tools agent** (0.770 vs 0.998 at list; 0.272 vs 0.342 at
Wafer-us). As billed, the two look equal (0.318 vs 0.320) because ALL's eden requests happened to land on pricier
endpoints. The billed difference between conditions is routing noise of the same size as the effect.

A least-squares fit of cost on tokens over all requests gives an effective $0.053/M input and $0.191/M output (output
3.6× input; D64 quoted 2.8× from a different estimator). Input is 46% of agent spend at those prices.

### 1.2 Time is output tokens; Eden's own share is the pre-first-request wait

Fitting each request's duration on its tokens: **743 ms + 7.7 ms per output token**, with input tokens contributing
nothing measurable (−0.04 ms/token). TTFT p50 360 ms. Endpoint speed ranges from 4.7 to 8.3 ms per output token (p50),
TTFT from 318 to 579 ms. OpenAI's latency guide says the same of every model: generation "is almost always the highest
latency step", and "cutting 50% of your prompt may only result in a 1-5% latency improvement"
([OpenAI latency guide](https://developers.openai.com/api/docs/guides/latency-optimization)).

Eden's critical-path cost is the wait before the agent's first model request: p50 **448 ms** in eden (ALL), 684 ms in
eden (H) (p90 879 / 1,156 ms; 3,001 ms with the judge). In eden (ALL) the span that fills it is `eden.slow` (p50 552
ms, p90 963 ms), waiting on `eden.source` calls (p50 307 ms, p90 674 ms) and `eden.sync.freshen` (p90 677 ms), even
though D64 found every planted item already in the synced cache at decision time. `ask_context` itself is 6.8 ms p50.

### 1.3 The ask round trip, in-sample

In-sample hidden and control tasks, eden (ALL), split by whether Eden delivered the planted item (or, on control, the
decoy) proactively and whether the agent then called `ask_context`:

| Variant | Delivered | Asked | n | Raised (hidden) / false concern (control) | Wall p50 s | Agent $/1k | Calls |
|---|---|---|---|---|---|---|---|
| hidden | yes | no | 48 | 0.896 | 3.74 | 0.115 | 1.00 |
| hidden | yes | yes | 170 | 0.859 | 9.59 | 0.287 | 2.06 |
| hidden | no | no | 8 | 0.125 | 4.64 | 0.100 | 1.00 |
| hidden | no | yes | 42 | 0.476 | 7.80 | 0.462 | 2.50 |
| control | no | yes | 248 | 0.032 | 8.75 | 0.330 | 2.46 |
| control | yes | yes | 15 | 0.133 | 9.38 | 0.191 | 2.13 |

(Control rows with n ≤ 3 omitted.) Pooled: P(raised | delivered) = **0.867** (n=218), P(raised | not delivered) =
**0.420** (n=50); P(false concern | decoy delivered) = **0.111** (n=18), P(false concern | not delivered) = **0.032**
(n=250). The agent asks after 78% of in-sample deliveries; when it does not, the task takes 3.74 s instead of 9.59 s
and 40% of the cost, with no loss of the fact (observational: the agent chose not to ask, so these tasks may be easier).
On control tasks Eden delivers nothing 93% of the time and the agent then asks 99% of the time: the round trip there
is the agent's diligence about an empty packet, not distrust of a delivered one.

Whether the agent asks after a delivery varies with the packet (in-sample, small cells): 56/76 after an
anticipated-conflict packet and 46/62 after a grounded-conflict one, but 28/29 after grounded-graph, 9/9 after
grounded-card and 9/9 after sources. Packets of 200–399 characters were followed by an ask 91/129 times, 400–599
characters 46/50. A packet that states the decisive relation (a clash, a conflict) is asked about less often.

### 1.4 What uptake implies for the delivery threshold

Uptake says what a delivery is worth. On in-sample tasks, delivering the planted item raises the hidden rate by
0.867 − 0.420 = **+0.447**; delivering a decoy raises the false-concern rate by 0.111 − 0.032 = **+0.079**. If a false
concern costs *w* missed facts, delivering a candidate with precision *p* pays when *p* × 0.447 > (1 − *p*) × 0.079 ×
*w*, that is when *p* exceeds 0.15 (*w* = 1), 0.35 (*w* = 3) or 0.47 (*w* = 5). Eden's deliveries today run at about
0.87 precision (D64: 342 planted against 52 decoys over 584 hidden tasks). Under any *w* up to 5, the funnel holds back
candidates that would pay. This is the cost-sensitive gate that PRISM formalises (§3), and it says the decision gap
(D64: every miss is a decision, not a retrieval) is partly a threshold set for a cost ratio the agent does not have.
Caveat: the false-concern effect is measured on control tasks only; extra items on hidden tasks may also distract.

## 2. Agent latency and cost

### 2.1 Prompt caching

| Provider (via OpenRouter) | Mode | Cache read | Cache write | Notes |
|---|---|---|---|---|
| Z.AI (GLM) | automatic | ≈ 0.2× | free | session affinity key from account and `session_id` |
| DeepSeek | automatic | 0.1× | 1× | |
| OpenAI | automatic (explicit on newer models) | 0.25–0.5× | free (1.25× explicit) | 1,024-token minimum |
| Gemini 2.5+ | implicit; explicit via `cache_control` | 0.25× | free implicit | minimum 1,024–4,096 tokens by model |
| Anthropic | explicit `cache_control` or automatic | 0.1× | 1.25× (5 min), 2× (1 h) | minimum 512–4,096 by model |
| Grok, Moonshot | automatic | 0.25× | free | |

Source: [OpenRouter prompt caching](https://openrouter.ai/docs/guides/best-practices/prompt-caching); Gemini's
75% implicit discount: [Google developers blog](https://developers.googleblog.com/en/gemini-2-5-models-now-support-implicit-caching/).
OpenRouter keeps a conversation on one provider ("sticky routing") only when that provider's cache reads are cheaper
than its input price; stickiness lasts 10 minutes of inactivity; `session_id` (or `x-session-id`) makes it start on
the first request rather than after a first hit; setting `provider.order` bypasses it.

What it is worth here: GLM 5.3 Flash's cheapest endpoints barely discount cached reads (OpenInference $0.0157 vs
$0.0172 input, Wafer $0.053 vs $0.054); Z.AI's 0.2× applies only at its $0.15 list price, 3–9× the routed price.
Requests are short (p50 822 input tokens; 39% reach 1,024). With input at 46% of spend and about half of a multi-call
task's input being a repeated prefix, the ceiling is roughly 0.46 × 0.45 × 0.8 ≈ **17% of agent cost at Z.AI's list
price, about zero at the routed price** (estimate). Manus calls KV-cache hit rate "the single most important metric for
a production-stage AI agent", at a 100:1 input-to-output ratio and 50 tool calls per task
([Manus](https://manus.im/blog/Context-Engineering-for-AI-Agents-Lessons-from-Building-Manus)); Eden's tasks are
2.2 calls at about 2.6:1. Caching matters for a tenant with a long system prompt, not for this benchmark.

What Eden controls is to never break a tenant's cache: Manus's rules are a stable prefix ("even a single-token
difference can invalidate the cache from that token onward"), append-only context and deterministic serialisation.
The client's `withContext` and the Pi harness put Eden's packet as a system message just before the user turn, after
the stable system prompt and tools, which is right; it must stay byte-stable for the same items (D64's harness puts
`Now: <time>` in the system prompt, the pattern Manus warns against, harmless here because it is fixed per world).

### 2.2 Routing

OpenRouter's default load-balances endpoints weighted toward price; `provider.sort` ("price", "throughput",
"latency"), the `:floor` / `:nitro` suffixes, `preferred_max_latency` / `preferred_min_throughput` and a hard
`max_price` control it ([OpenRouter provider routing](https://openrouter.ai/docs/provider-routing)). §1.1 shows the
default makes cost comparisons between conditions noisy; pinning one endpoint (`provider.order` with
`allow_fallbacks: false`, or `sort: "price"` with `max_price`) makes them clean.

### 2.3 Output tokens, speculation and parallel tools

- **Fewer output tokens is the latency lever.** OpenAI's guide lists seven principles: process tokens faster, generate
  fewer tokens, use fewer input tokens, make fewer requests, parallelise, make users wait less, don't default to an
  LLM. In D64, 85% of model time is output; the Eden agent's final answer is 482 tokens at p50 and its earlier calls
  261 tokens (reasoning plus the `ask_context` call). Each avoided extra request saves its TTFT (≈ 360 ms) plus its
  output (≈ 260 × 7.7 ms ≈ 2.0 s) plus the next request's TTFT.
- **Speculative actions.** A cheap predictor guesses the agent's next action and runs it in parallel, committing only
  on a match: up to 55% next-action accuracy and 20% end-to-end lossless speedup in the arXiv version, "up to 30%" in
  the ICLR 2026 listing ([Ye et al., arXiv 2510.04371](https://arxiv.org/abs/2510.04371)). Eden's `ask_context`
  answers in 5 ms, so speculating the *tool* gains nothing; what can be removed is the *model round trip* that decides
  to call it (§8, R1).
- **Parallel function calling.** LLMCompiler plans independent calls as a DAG: up to 3.7× latency, 6.7× cost and ~9%
  accuracy over ReAct, 1.35× over OpenAI's parallel calling
  ([Kim et al., arXiv 2312.04511](https://arxiv.org/abs/2312.04511)). This is why the `tools` agent costs 3.34 calls per
  task: sequential lookups. Eden replaces those lookups with one packet, the same effect without the agent planning.
- **Streaming the injection.** NeMo Guardrails runs input rails concurrently with generation and discards the
  generation if a rail blocks ([NVIDIA engine support](https://docs.nvidia.com/nemo/guardrails/reference/engine-feature-support)).
  The equivalent for Eden is to start the agent's first request without waiting for slow sources and inject what
  arrives later before the next request, which the harness already supports (`lateItems`). With a synced cache the
  wait buys nothing measurable (§1.2).

### 2.4 Context engineering practice

- **Anthropic** ([Effective context engineering](https://www.anthropic.com/engineering/effective-context-engineering-for-ai-agents)):
  context is "a finite resource with diminishing marginal returns"; recommends a hybrid of "retrieving some data up
  front for speed" plus just-in-time tool lookups (Claude Code: CLAUDE.md up front, glob and grep on demand); tools
  "self-contained, robust to error, and extremely clear"; bloated tool sets a common failure. Eden is the up-front
  half of that hybrid; `ask_context` is the just-in-time half.
- **LangChain** ([Context engineering for agents](https://www.langchain.com/blog/context-engineering-for-agents)):
  write, select, compress, isolate. Eden is "select" done outside the agent's loop.
- **Manus**: keep errors in context, recite the plan at the end of context, mask tools instead of removing them
  (removing breaks the cache), restorable compression (keep a URL or path, drop the content). Eden's citations are
  restorable references: the agent can `ask_context` or fetch by id instead of Eden sending full text.
- **Position.** Models use information at the start or end of the context best, a U-shaped curve
  ([Liu et al., "Lost in the Middle"](https://arxiv.org/abs/2307.03172)). The packet just before the user turn sits at
  the end; it should stay there.
- **Privilege.** OpenAI's instruction hierarchy ranks system > user > tool outputs, tool outputs the least trusted
  ([Wallace et al., arXiv 2404.13208](https://arxiv.org/abs/2404.13208)). Delivering the packet as a tool result
  rather than a system message matches its status ("data, not instructions") to the slot models are trained to treat
  as data (§8, R1).

## 3. Proactive and memory agents: when to inject

| Product / work | What is precomputed | How relevance is decided | Source quality |
|---|---|---|---|
| ChatGPT memory | saved memories; a summary of past chats | injected into every conversation's context; no per-turn retrieval decision is documented | OpenAI help pages for the settings ([memory FAQ](https://help.openai.com/en/articles/8590148-memory-faq)); mechanics are third-party reverse engineering ([llmrefs](https://llmrefs.com/blog/reverse-engineering-chatgpt-memory)) |
| ChatGPT Pulse | overnight asynchronous research over memory, chats and (opt-in) Gmail and Calendar | a once-a-day batch, delivered as cards; being retired into scheduled tasks | [OpenAI](https://openai.com/index/introducing-chatgpt-pulse/), [help](https://help.openai.com/articles/12293630-chatgpt-pulse) |
| Gemini Personal Intelligence | connected Gmail, Photos, YouTube, Search history | Gemini "analyzes your prompt" and decides whether past chats or connected apps "could help"; explains which sources it used | [Google](https://gemini.google/overview/personalization/); details secondary ([DataCamp](https://www.datacamp.com/blog/gemini-personal-intelligence)) |
| Apple Intelligence | an on-device semantic index of personal content; App Intents as a capability index | the index identifies relevant personal data per request and feeds it to the on-device or Private Cloud Compute model | WWDC statements via secondary sources ([Wing VC](https://www.wing.vc/content/unpacking-apple-intelligence-apples-vision-for-personalized-ai)) |
| Microsoft 365 Copilot | a per-tenant semantic (vector) index over Microsoft Graph, near-real-time for mailbox content | lookup in Graph plus the semantic index before the model, ranked with Graph signals about "the user and their close network"; post-processing against Graph after | [Microsoft Learn](https://learn.microsoft.com/microsoftsearch/semantic-index-for-copilot) |
| ProMemAssist (Meta Reality Labs, U. Toronto) | a model of the user's working memory from glasses' camera and microphone | timing by value of help against the cost of interruption; +32.7% timing accuracy over an LLM-only baseline, n=12 | [arXiv 2507.21378](https://arxiv.org/abs/2507.21378) |
| ProactiveBench | — | defines false-alarm rate; most models "fail to stay quiet" | [Lu et al., arXiv 2410.12361](https://arxiv.org/abs/2410.12361) |
| PRISM (ICLR 2026) | — | intervene only when a calibrated acceptance probability exceeds a threshold derived from the asymmetric costs of missed help and false alarms: −22.78% false alarms, +20.14% F1 | [arXiv 2602.01532](https://arxiv.org/abs/2602.01532) |

What this says for Eden:

- **Every shipping product injects on the request, not on arbitrary events,** and the large ones (Gemini, Copilot)
  decide relevance with the model or with a learned ranker over a precomputed index. None publishes a per-turn
  precision. Eden's no-model decision over a synced index is the Copilot/Apple shape at a fraction of the cost, and
  D64 measured the model judge adding nothing (+0.010, −0.024..+0.046).
- **Precompute is the norm:** Apple's semantic index, Copilot's semantic index, ChatGPT's chat summary, Pulse's
  overnight batch. Eden's sync, graph and cards are this; the open question is the gate, not the index.
- **The gate should be cost-sensitive.** PRISM's threshold from asymmetric costs is exactly §1.4's arithmetic; Eden has
  the measured inputs (uptake 0.867 vs 0.420, false-concern lift +0.079) to set it, per delivery path.
- **Attribution builds trust.** Gemini explains which sources it used. Eden's packet already cites; adding what was
  searched (sources and time window) is the data an agent needs to judge completeness (§8, R4).

## 4. Pre-execution guardrails for tool calls

| System | Hook point | Decision | Cost |
|---|---|---|---|
| OpenAI Agents SDK tool guardrails | `tool_input_guardrail` before the tool runs, `tool_output_guardrail` after | `allow`, `reject_content` (block the call, continue the run with a message to the model), `raise_exception` | your function ([PR #2218](https://github.com/openai/openai-agents-python/pull/2218/files)) |
| Claude Code / Agent SDK hooks | `PreToolUse` | `permissionDecision` allow/deny/ask/defer, `updatedInput`, `additionalContext` (a 2026 bug report said it was not injected; closed as resolved) | your command ([hooks](https://docs.anthropic.com/en/docs/claude-code/hooks)) |
| NeMo Guardrails | tool-call and tool-result rails (IORails, low latency); execution rails (LLMRails) | Colang flows | one LLM call for routing plus rails (secondary) |
| Invariant Gateway / mcp-scan proxy | a transparent proxy for LLM and MCP traffic | Python-like policy rules over the trace, e.g. no `send_email` after `get_website` | rules, optional model checks ([docs](https://explorer.invariantlabs.ai/docs/guardrails/gateway)) |
| LlamaFirewall | PromptGuard 2 on inputs; AlignmentCheck (Llama 4 Maverick) on reasoning and tool calls | attack success on AgentDojo 17.6% → 1.75% combined; AlignmentCheck detects 83% with 2.5% false positives on its own set | a large-model call per check ([Meta, arXiv 2505.03574](https://arxiv.org/abs/2505.03574)) |
| MCP spec | tool `annotations` (`readOnlyHint` …) | clients "MUST consider tool annotations to be untrusted unless they come from trusted servers" | — ([spec](https://modelcontextprotocol.io/specification/2025-06-18/server/tools)) |

These are security products: they block. Eden's use of the same hook is different and safer: at the moment the agent
is about to act, Eden adds the user's data that bears on the action (a clash at that time, an invoice already paid,
a person who declined). The action's arguments are the most precise query Eden ever gets: an exact time, attendee,
amount or recipient, where the user's request had only words. Eden's best delivery paths are already relational
(anticipated-conflict 109 hits, grounded-conflict 90, D64), and a check on arguments is their exact-match form. The
platforms already expose the hook (OpenAI's `reject_content` message or Claude's `additionalContext` carry data back
to the model), so it is a client SDK helper, not a protocol change. The packet stays data: Eden returns items and
the relation (same time, same amount), never "do not book". Blocking stays the tenant's policy.

Two cautions from the literature. AlignmentCheck's 2.5% false-positive rate is for a model check; Eden's must be
no-model and keep D64's false-concern bound. And D64's harness has no action tools ("You cannot send, book, pay or
order anything yourself"), so testing this needs a harness variant where the agent drafts actions as tool calls.

## 5. Connector push APIs, quotas and the cost of freshness

| Connector | Push mechanism | Lifetime / renewal | Payload | Incremental read | Quota and price |
|---|---|---|---|---|---|
| Gmail | `users.watch` → Cloud Pub/Sub | renew at least every 7 days; Google recommends daily | email address + new `historyId` only; max 1 notification/s per user, excess dropped | `history.list` from the last `historyId` | 2 units per `history.list`, 20 per `messages.get` (60 for full/raw), 100 per `watch`; 6,000 units/min per user, 1.2M/min per project; no charge ([push](https://developers.google.com/workspace/gmail/api/guides/push), [quota](https://developers.google.com/workspace/gmail/api/reference/quota)) |
| Pub/Sub | — | — | — | — | first 10 GiB/month free, then $40/TiB; each request billed as at least 1 KB ([pricing](https://cloud.google.com/pubsub/pricing)) |
| Google Calendar | `events.watch` channels | no automatic renewal; re-watch with a new id (channels overlap) | headers only (`X-Goog-Resource-State: sync / exists / not_exists`), no data | `events.list` with `syncToken`; 410 Gone means full resync | 600 requests/min per user, 10,000/min per project; free, with charges for over-quota use "planned … later in 2026" ([push](https://developers.google.com/workspace/calendar/api/guides/push), [sync](https://developers.google.com/workspace/calendar/api/guides/sync), [quota](https://developers.google.com/workspace/calendar/api/guides/quota)) |
| Microsoft Graph (Outlook) | subscriptions (webhooks) | message, event, contact: 10,080 min (under 7 days); 1,440 min with resource data; lifecycle notifications (`reauthorizationRequired`, `missed`) | ids by default; resource data optional (encrypted) | delta query (`@odata.deltaLink`) | message notification latency < 1 min average, 3 min max; 10,000 requests per 10 min and 4 concurrent per app per mailbox ([subscription](https://learn.microsoft.com/en-us/graph/api/resources/subscription), [throttling](https://learn.microsoft.com/en-us/graph/throttling-limits)) |
| Microsoft Teams | subscriptions on chatMessage | 4,320 min (3 days) | optional resource data | `/messages/delta` | chatMessage < 10 s average, 1 min max |
| Slack | Events API (HTTP push) | permanent subscription; respond within 3 s; 3 retries (now, 1 min, 5 min); disabled if > 95% fail in 60 min | events are often "abbreviated versions of full objects" | `conversations.history` | 30,000 events per workspace per app per hour ([Events API](https://docs.slack.dev/apis/events-api/)); **non-Marketplace commercial apps: `conversations.history` and `.replies` at 1 request/min and 15 objects** (new installs from 2025-05-29; existing installs by 2026-03-03 per Slack's FAQ) ([changelog](https://docs.slack.dev/changelog/2025/05/29/rate-limit-changes-for-non-marketplace-apps)) |

**What freshness costs per user** (estimate at 50 new mail items a day, D57's assumption): 50 Gmail notifications ×
1 KB billed = 1.5 MB per user-month, so the 10 GiB free tier covers about 7,000 users and beyond it the cost is
$0.00006 per user-month; Gmail quota 50 × (2 + 20) + 100 (daily watch) = 1,200 units per user-day, 0.2% of one
minute's per-user allowance. Calendar and Graph are free within quota. The API cost of a fresh per-user index is
effectively zero; the costs are an HTTPS endpoint, a renewal scheduler (7 days Gmail and Outlook, 3 days Teams), and
Slack's limits, which make push the *only* practical way to keep Slack fresh for a non-Marketplace app.

What this means for D57's sync: today staleness is a learned posterior and a stale source is freshened on the
critical path (`eden.sync.freshen` p90 677 ms, §1.2). With a push channel, a source is current by construction until a
notification says otherwise (Graph's documented maximum lag is 3 minutes for messages), so the critical path never
needs to poll. Eden stays read-only (D7): it receives "user U's source S changed" pings from the tenant's webhook relay
and reads the change through the same read-only `list`/`fetch` tools. Eden does not need to own the Pub/Sub topic or
the Graph subscription; the tenant's connector platform usually already does.

## 6. Cheap structured extraction at scale

Card enrichment (D59) is Eden's only per-item model spend; D64 put the one-time backfill at $0.156 per 1k tasks
(about $0.005 per user for 1,500 items), a third of Eden ALL's all-in cost. Measured cost per card call (moon-cards,
572 calls): 1,599 input and 677 output tokens, $0.000181.

Prices from OpenRouter's models and endpoints APIs (2026-10-31), cost of one card call (1,599 in, 677 out) and per
1,000 items at 10 items per call:

| Model / route | Input $/M | Output $/M | $ per card call | $ per 1k items |
|---|---|---|---|---|
| glm-5.3-flash, measured (mixed routing) | — | — | 0.000181 | 0.018 |
| glm-5.3-flash, cheapest default route (Relace) | 0.0163 | 0.1479 | 0.000126 | 0.013 |
| glm-5.3-flash, OpenInference (fp4) | 0.0172 | 0.0355 | 0.000052 | 0.005 |
| glm-5.3-flash `:batch` | 0.05 | 0.18 | 0.000202 | 0.020 |
| mistral-nemo | 0.029 | 0.030 | 0.000067 | 0.007 |
| gpt-oss-20b | 0.018 | 0.090 | 0.000090 | 0.009 |
| qwen3.7-flash | 0.030 | 0.130 | 0.000136 | 0.014 |
| claude-haiku-5.5 `:batch` | 0.05 | 0.25 | 0.000249 | 0.025 |

Batch APIs: OpenAI, Anthropic and Gemini each take about 50% off for a 24-hour window (secondary roundups;
[Simon Willison on Anthropic's](https://simonwillison.net/2024/Oct/8/anthropic-batch-mode/)); OpenRouter's Batch API
(`POST /api/v1/batches`, `:batch` endpoint variants, "typically 50% of the sync per-token price", 24 h on most
providers, up to 96 h on Vertex, `callback_url` webhook, results matched by `custom_id`;
[OpenRouter batch](https://openrouter.ai/docs/guides/features/batch-api)). **For GLM 5.3 Flash the batch variant costs
more than the cheapest synchronous route**, because the batch discount applies to a list price and the open-weight
market is already far below list. Time-of-day pricing exists too: Alibaba's endpoint for deepseek-v4.1-flash charges
2× from 00:00 to 14:00 UTC (endpoints API).

So for background extraction, latency does not matter and price does: route with `provider.sort: "price"` (or
`:floor`) and a `max_price` cap, and pass a JSON schema (`response_format`) only to endpoints that support it. That
cuts the card backfill 30% (cheapest default route) to 70% (OpenInference fp4, quality unmeasured) without a model
change; the D64 card share would fall from $0.156 to about $0.05–0.11 per 1k tasks (estimate). Validate precision on
the cheaper endpoint before switching: quantisation's effect on extraction is unmeasured.

## 7. Knowledge graphs and personal knowledge bases

| System | Index cost | Query cost / latency | Published result |
|---|---|---|---|
| GraphRAG (Microsoft) | LLM entity extraction plus community summaries; a data change rebuilds communities (≈ 1,399 × 2 × 5,000 tokens in LightRAG's estimate) | global search reads community reports: 610 reports × 1,000 tokens = 610,000 tokens, hundreds of calls, on LightRAG's legal set | — |
| LazyGraphRAG | indexing "identical to vector RAG and 0.1% of the costs of full GraphRAG" (no up-front summarisation) | comparable to GraphRAG global search at > 700× lower query cost | [Microsoft Research](https://www.microsoft.com/en-us/research/blog/lazygraphrag-setting-a-new-standard-for-quality-and-cost/) |
| LightRAG | entity and relation extraction; incremental insert without rebuild | < 100 tokens, one API call per query | [Guo et al., arXiv 2410.05779](https://arxiv.org/abs/2410.05779) §4.5 |
| Zep / Graphiti | several LLM steps per episode (extraction, reflection, resolution, temporal extraction, edge invalidation); bi-temporal edges (valid/invalid time and created/expired time); hybrid BM25 + cosine + BFS retrieval, rerankers | LongMemEval_S: 71.2% vs 60.2% full context (gpt-4o), 2.58 s vs 28.9 s, 1.6k vs 115k context tokens; DMR 94.8% vs MemGPT 93.4% | [Rasmussen et al., arXiv 2501.13956](https://arxiv.org/abs/2501.13956) |
| Mem0 / Mem0g | LLM extraction and update per message | LOCOMO: +26% relative LLM-judge score over OpenAI memory; 91% lower p95 latency and > 90% fewer tokens than full context; graph variant ≈ +2% | [Chhikara et al., arXiv 2504.19413](https://arxiv.org/abs/2504.19413) |

All headline numbers are the authors' own, on conversational-memory benchmarks, not on proactive delivery. Three
lessons transfer:

1. **Defer the model.** LazyGraphRAG's whole gain is not summarising up front; LightRAG's is a one-call query. Eden's
   graph (D58) is already no-model; cards (D59) are the only up-front model spend and should stay prefiltered and
   price-routed (§6).
2. **Time on edges.** Zep invalidates an edge when a newer one contradicts it (old edge's invalid time = new edge's
   valid time). Eden's decoys are mostly stale or superseded facts (a moved meeting, a paid invoice). A no-model
   supersession rule in the graph (same entity pair and relation, newer source time wins; keep the old one as
   history) is the mechanism Zep found worth building, and it targets false concerns directly.
3. **Hybrid retrieval beats any one signal.** Zep fuses BM25, embeddings and graph distance with reciprocal-rank
   fusion; Copilot ranks with Graph signals about the user's network. Eden's grounded-graph and grounded-card paths are
   this; RRF is a cheap, parameter-light way to merge their candidate lists before the gate.

## 8. Top 10 recommendations, ranked

Each is an experiment to run in-sample (dev, held-out 1–4), behind a flag off by default or as tenant-side SDK/docs
guidance, then once on the blind suites at synthesis. Expected impacts are estimates from §1's in-sample numbers.

**R1. Pre-executed ask: deliver the packet as the result of an `ask_context` call the SDK made for the agent.**
A client helper (`withPrefetchedAsk`, tenant's choice) appends to the history an assistant `ask_context` call whose
question is the user's message and whose result is Eden's packet (or Eden's answer, which is 5 ms), instead of a
system message. The agent sees the lookup already done, in the lowest-privilege slot (tool output, instruction
hierarchy), at the end of context. This is speculative execution of the agent's most predictable action: the agent
asks in 92% of Eden tasks (D64). No model call, no packet text change.
*Facts:* neutral to slightly positive expected (in-sample, delivered and not asked 0.896 vs asked 0.859); risk is the
not-delivered case, where asking recovered 0.476 vs 0.125, so the prefetched answer must be the same search an ask
would run. *Cost:* −35–50% agent cost on tasks that would have asked (in-sample $0.287 → $0.115 per 1k when the agent
did not ask). *Time:* −2.7 to −5.9 s on those tasks (one TTFT + ≈ 260 output tokens + next TTFT ≈ 2.7 s, up to the
measured 9.59 → 3.74 s); wall p50 8.55 s → about 5–6 s overall (estimate).

**R2. Set the delivery threshold from measured uptake, per path (cost-sensitive gate).**
Deliver a candidate when its estimated precision exceeds 0.079 *w* / (0.447 + 0.079 *w*), with *w* the false concerns
the owner trades for one fact (0.35 at *w* = 3). Estimate per-path precision from the funnel (in-sample), as PRISM
does with calibrated acceptance. Needs a decision under "precision over recall": the bound is on false concerns, not
on precision.
*Facts:* the largest lever: of 584 hidden tasks D64 delivered 342 with every item cached, and each extra correct
delivery is worth +0.447. *Cost/time:* none (no model); packets slightly longer. *Precision:* bounded by construction.

**R3. Re-price benchmark cost at a fixed endpoint, and pin the endpoint in pi-ab.**
Report all-in cost twice: as billed and re-priced at one endpoint (§1.1), and run pi-ab with `provider.order` pinned
(no fallbacks) or `sort: "price"` plus `max_price`. *Facts:* none. *Cost:* changes what is measured: Eden's agent is
20–23% cheaper than tools at a fixed price, a difference the billed numbers hide. *Time:* removes endpoint speed
variance (4.7–8.3 ms per output token) from wall comparisons.

**R4. Coverage metadata in the packet envelope (data only).**
Add attributes to `<context>`: the sources searched, the time window and as-of time (e.g. `searched="calendar mail
crm" window="2026-10-24..2026-11-07" asof="…"`). It states what Eden looked at; it asks nothing of the agent. Gemini
explains its sources; Manus keeps restorable references. Hypothesis: the agent asks less when it can see a search was
already done (in-sample asks follow 74% of conflict packets but 100% of graph, card and source packets).
*Facts:* neutral. *Cost/time:* fewer asks; ≈ 15 extra input tokens per packet.

**R5. Trust the synced cache on the critical path; freshen in the background.**
With `sync` on and the source current, decide from the cache immediately and do not wait for on-path source calls;
inject what later freshens before the next model request (the harness's late-items path).
*Facts:* neutral expected (D64: 100% of planted items cached at decision time). *Time:* −0.4 s p50 (first model
request at 448 ms p50 in eden ALL, p90 879 ms), about 5% of wall. *Cost:* fewer source calls.

**R6. Push-driven freshness: a change-hint endpoint plus delta reads.**
Accept "user U, source S changed" hints (from a tenant's Gmail Pub/Sub, Graph subscription, Calendar channel or Slack
Events relay), mark S stale and pull the delta through the existing read-only tools; with an active channel, treat
S as current without polling. Makes R5 safe in production and is the only practical Slack path for non-Marketplace
apps (1 request/min, 15 objects). *Facts:* fresher cache, fewer stale decoys. *Cost:* ≈ $0 API (§5);
$0.00006/user-month Pub/Sub beyond the free tier. *Time:* removes `sync.freshen` from the path (p90 677 ms).

**R7. Pre-action check helper (action firewall hook, data only).**
SDK helpers for OpenAI Agents SDK `tool_input_guardrail`, Claude Agent SDK `PreToolUse` (`additionalContext`) and
MCP gateways: on a write tool call, send the tool name and arguments to a no-model Eden `check`, which returns
conflicting items and the relation as data; the tenant decides whether to block. *Facts:* a second, exact-argument
chance for the 242 D64 hidden tasks not delivered proactively (the relation paths already carry the most hits).
*Cost:* no model; one 5 ms call per write action. *Time:* ≈ 0. Needs a harness variant with action tools.

**R8. Supersession on graph edges (Zep-style bi-temporal, no model).**
When a newer item states the same relation for the same entities (a rescheduled meeting, a paid invoice, a changed
address), mark the older edge invalid from the newer one's time; prefer valid edges in the gate and show the
supersession in the packet as data. *Facts:* fewer stale-fact decoys (D64 decoy deliveries 52/584, 8 from `cache`
and 9 from grounded-conflict), so R2 can lower thresholds without raising false concerns. *Cost/time:* none.

**R9. Price-route background extraction.**
Run card enrichment with `provider.sort: "price"` and a `max_price` cap, not `:batch` (dearer for GLM 5.3 Flash), after
checking card precision on the chosen endpoint. *Cost:* card backfill −30% (cheapest default route) to −70%
(OpenInference fp4): D64's $0.156 per 1k tasks share → about $0.05–0.11 (estimate). *Facts/time:* none if precision
holds; extraction is off the path.

**R10. Tenant integration guide (docs and SDK defaults, the tenant's choice).**
A docs page with measured advice: put Eden's packet after the stable prefix and keep it byte-stable (prompt caching);
pass an OpenRouter `session_id` per user for sticky routing where the provider discounts cache reads; a recommended
`ask_context` description that says context Eden already delivered came from the same search; low reasoning effort on
the tool-deciding call; concise final answers. *Facts:* neutral. *Cost:* up to ≈ 17% agent cost from caching at
list prices, more with long tenant prompts. *Time:* output tokens are 85% of model time, so answer length is the
tenant's biggest lever.

Not recommended: Eden's model judge on the default path (D64: +0.010, −0.024..+0.046, for +0.64 s and +$0.019/1k);
GraphRAG-style up-front community summaries (cost and rebuilds, §7); batch routes for GLM extraction (§6).

## 9. Commands

Run in this session. The scripts are in [econ-research-scripts/](econ-research-scripts/) (`$E` below); `$B` is the
D64 run directory (`bench/` in that session's scratchpad: `pi-{H,R,ALL}-4{1..4}.json`, their `.timeline/tasks.jsonl`
and `funnel-ALL.json`). They need Python 3 and numpy (`prices.py` only). That run data was not committed (it holds
the lab's request timelines), so the numbers here cannot be reproduced from this repo alone: a rerun needs a fresh D64
run (`packages/sim/src/lab/pi-ab.ts`) in its place, and will differ by its own sampling.

```bash
curl -sS https://openrouter.ai/api/v1/models/z-ai/glm-5.3-flash/endpoints        # endpoint prices (no key)
curl -sS https://openrouter.ai/api/v1/models/deepseek/deepseek-v4.1-flash/endpoints
curl -sS https://openrouter.ai/api/v1/models -o models.json                     # model prices
python3 -I $E/prices.py   $B    # effective $/token, time per output token, input-size distribution
python3 -I $E/routes.py   $B    # endpoint inferred per request, by condition; speed by endpoint
python3 -I $E/normcost.py $B    # cost per 1k tasks, billed vs re-priced at a fixed endpoint
python3 -I $E/edenpath.py $B    # time to first model request, ask rate, output before the final answer
python3 -I $E/spans.py    $B    # Eden span durations in eden (ALL)
python3 -I $E/uptake.py   $B    # in-sample uptake, ask round trip, asks by path and packet size
python3 -I $E/cheap.py    models.json   # card-call cost by model
```
