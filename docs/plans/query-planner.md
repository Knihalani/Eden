# Plan: an adaptive query planner, tested on real connectors

Status: phases 0–6 done, 2026-10-28. Phase 5 (shadow) ran in simulation by the owner's decision (D29); phase 6
(default on) was judged by D31's cost-normalised gate with D32's reading, and the server serves through the planner
by default since D33. Results and gate status: docs/research/query-planner-results.md; departures from this plan
are listed in D28–D33. The iteration loop continues; each iteration is logged in the results' "Iterations" section.

## Why

The simulation (docs/research/simulation.md) found that what a connector's search does with Eden's query decides
most of recall. Through Gmail-style AND search only 21% of needed facts came back at all; through ranked search, 74%.
Sending the cue's entities alone took that to 40%, and recall with a judge from 0.19 to 0.32. No judge or ranking
recovers an item no query returned.

Tenants will connect any MCP server: mail, calendars, docs, CRMs, ticketing, chat, databases, memory products, their
own internal tools. Eden cannot hand-write a query mapping for each. It has to find out how each connector behaves,
for each user, and adapt.

## What gets built

A `QueryPlanner` that, for every lookup and every chosen connector, decides *what to send*: which query shapes, how
many, and in which argument. It learns per (user, connector) from outcomes, starts from a cheap capability probe, and
stays inside the existing budgets (deadlines, rate limits, per-source concurrency).

### Query shapes

Built from the cue the engine already makes (content terms, typed entities, idf from the user's cache):

| Shape | Example from "Prep me for the Globex call with Sam Ortiz" | Good for |
|---|---|---|
| `full` | `prep globex call sam ortiz` | ranked search (Drive, vector/memory products) |
| `entities` | `Globex Sam Ortiz` | AND search, name-matching CRMs |
| `entity+term` | `Globex call` (the cue's rarest term, by the user's idf) | AND search with a topic |
| `each-entity` | `Globex`, then `Sam Ortiz` (two queries) | title or record-name search |
| `or` | `Globex OR "Sam Ortiz" OR call` | connectors whose syntax has OR (probed, never assumed) |
| `phrase` | `"Sam Ortiz"` | phrase-only or exact-match search |
| `id` | `OPS-142` | ticket, invoice, order ids |

Shapes are data (a small closed set with a builder each), not free text from a model.

### Learning

- **Arms**: shapes, per (tenant, user, connector). **Context**: a few cheap buckets (cue has an id; has 0 / 1 / 2+
  entities; length). Thompson sampling over Beta posteriors, as `BetaBandit` does, extended with per-arm decay
  (connectors change; a half-life in lookups, not days) and logged propensities, so a new policy can be evaluated
  offline on old logs (inverse propensity scoring, `ipsValue` exists).
- **Pulls per lookup**: one or two shapes per connector (the best draw, plus an exploration draw while the posterior is
  wide), within the lookup's deadline and the connector's rate budget. Never more calls than today's single query
  without a measured gain.
- **Reward**, credited to the shape(s) that returned an item, in three stages because evidence arrives late:
  1. *immediate*: the result holds a cue entity as whole terms (the cache's `containsAll` check) — weak, but at once;
  2. *at decision*: the item was delivered on the fast or source path, or the judge picked it;
  3. *later*: inferred or explicit usage of the injection that carried it (the existing usage tracker).
  Weights are tuned in simulation and fixed by a decision. An empty result is a reward of 0 for that shape.
- **Priors**: from the probe (below), else uniform. With tenant opt-in (D9), a tenant-level prior per connector *kind*
  from content-free counts; never another user's queries or terms.
- **Persistence**: arm counts in the source map's SQLite (content-free: connector id, shape, bucket, two counts,
  updated-at), written behind like outcomes. No query text is ever stored.

### Capability probe

On a connector's first use for a user, and again when its results drift: a handful of searches built from terms the
user's *own* recent results contain (so they can only match that user's data):

- one term vs two terms that co-occur in one item: does adding a term shrink (AND) or grow (OR/ranked) the results?
- a term present only in titles vs only in bodies: does body text match?
- `A OR B`, `"A B"`: is there operator syntax? (Literal-only connectors return nothing or match the word "OR".)
- result count vs the requested limit: is there pagination or a hard cap?
- two co-occurring but non-adjacent terms vs the same terms as they appear in the item: is the whole string matched
  as one substring (CalDAV, Twenty, the reference memory server do this)?
- a nonsense term: does the connector ever return nothing? Vector connectors (mem0, Chroma, HubSpot's FAISS cache)
  return their nearest items for any query, so an empty result cannot be the miss signal there and a score
  threshold is needed.

The probe sets priors and a capability record (`and | or | ranked | titles | phrase`, `operators: OR, quotes`). It
runs within the connector's rate budget, at most once per connector per user per day, and is skipped for connectors
the operator marks as expensive.

### Calling the tool: schema-driven arguments

A survey of real MCP servers' code (docs/research/connectors.md) found that a query string covers only one of eight
shapes of call. Others take field criteria and no free text (IMAP), text plus *required* non-text arguments (CalDAV's
date window, Typesense's collection and `query_by`, Rocket.Chat's channel), a DSL object (Elasticsearch), an array of
queries (Chroma), or one tool per entity type (EspoCRM). So the argument mapper is the core of the planner, not an
add-on.

Today `McpSource` takes an `args(query)` function per connector. The planner replaces it with a mapping derived from
the tool's JSON schema, deterministic and overridable by the operator:

- **text argument**: by name (`query`, `q`, `search`, `text`, `keywords`, `search_text`…), type and description;
- **field arguments**: typed cue entities go to matching fields (person → `from`/`to`/attendee/assignee,
  organisation → company/account/name, id → id field); each extra field narrows (AND), so fields are a shape of
  their own, learned like the others, never all filled at once;
- **required context**: collection, index, channel or `query_by` come from operator config; a time window comes from
  the cue (the event's time ± a range, per connector kind). If a required argument has no value, the call is not made
  and the connector is marked misconfigured, rather than guessing;
- **DSL backends**: one fixed template per backend (Elasticsearch `multi_match`, never `query_string`), filled with
  escaped terms;
- **arrays of queries**: several shapes in one call, credited per shape when the backend says which query matched;
- **result size**: the limit argument, capped by the lookup's budget.

Results are read by the existing `toItems`, extended to find title / body / url / time / id fields in arbitrary JSON.

SQL-only and path-glob connectors (postgres-mcp's `execute_sql`, the filesystem server's `search_files`) are not
targets for generated queries; they stay usable through operator-written templates only.

D7 does not change for a connector with one search tool. Connectors that expose one search tool per entity type (CRMs)
are configured as one Eden source per tool for now; a connector with a small operator-listed set of read-only tools
and a router would need a new decision (see [Decisions](#decisions)).

### Security

- **Query injection**: cue terms come from untrusted text (user and tool messages, item text). A term such as
  `in:trash`, `from:`, `OR`, a leading `-`, `*`, a quote, a JQL or SQL fragment must never become syntax. Every shape
  builder escapes or drops operator characters per the connector's probed capabilities; operators are emitted only by
  the shape builder, never copied from input. Fuzz-tested. Real servers pass syntax through by design (Gmail, notmuch,
  GitHub, Zulip, Basic Memory's AND/OR/NOT) and at least one interpolates the query unescaped into a GraphQL document
  (a Wiki.js server), so until a connector is probed, quotes and operator characters are dropped, not escaped.
- **Read-only**: unchanged (D7); the schema mapper may only fill arguments of the configured read-only search tool.
- **Isolation**: arms, probes and capability records are keyed by tenant/user/connector; a test asserts no cross-user
  reads. Probe terms come only from that user's own cached items.
- **Content-free traces** (D19): traces carry shape names and counts, never query text.
- **Amplification**: more queries per lookup cannot exceed the connector's rate budget or the lookup deadline; the
  circuit breaker and AIMD limiter already in `SourceFanout` apply per call.
- **Budget**: no model call is added. (A model query rewrite is a later, separate decision with a cost estimate.)

### Code layout

| Where | What |
|---|---|
| `@eden/primitives` | `ContextualBandit`: Beta arms per context bucket, decay, propensity log, IPS evaluation. Benchmarked. |
| `@eden/sources` | `QueryPlanner` (shapes, choose, credit), `probe.ts`, `schema-args.ts` (schema → call mapping), `escape.ts` (per-capability escaping), `toItems` extension |
| `@eden/graph` | planner tables in the source map (arm counts, capability records) |
| `@eden/engine` | `searchLive` asks the planner for calls per source; credits the retrieving shape when a delivered item is handed out (D39; no usage credit) |
| `@eden/sim` | the connector zoo and the real-connector harness (below) |

## How it is tested

Four tiers, each a gate for the next. The same metrics throughout: **reachability** (needed facts returned by any
query), **recall** and **in-time recall**, **precision**, **hard / soft false fires**, **source calls per lookup**,
**429s and timeouts**, **latency**.

### Tier 1 — unit and property tests

Shape builders on hostile input (operators, quotes, unicode, empty cues, 1,000-term cues); escaping round-trips per
capability; bandit math (posterior updates, decay, propensities sum to 1); probe classification on scripted fake
connectors; schema mapper on a corpus of real MCP tool schemas (collected from public servers' `tools/list`).

### Tier 2 — the simulation's connector zoo

Extend `packages/sim/src/sources.ts` with connectors nobody tunes the planner for:

| Behaviour | Modelled on |
|---|---|
| AND, newest first, operators (`OR`, quotes, `from:`) | Gmail, Slack |
| AND, no operators | many REST search endpoints |
| ranked full text | Drive, Confluence, Elasticsearch-backed tools |
| title / record-name only | CRMs, Notion's quick search |
| phrase-only, prefix-only | autocomplete-style endpoints |
| id lookup only | ticket and order systems |
| whole string as one substring | CalDAV, Twenty CRM, the reference memory server (read in their code) |
| field criteria only, no free text | IMAP servers |
| required non-text arguments (time window, collection) | CalDAV, Typesense, Rocket.Chat, Chroma |
| one search tool per entity type | EspoCRM, SuiteCRM |
| vector (semantic) search, never empty | memory products (Mem0, Supermemory), vector-DB MCPs |
| small page size with pagination | many APIs |
| odd argument names and nested result JSON | community MCP servers |
| behaviour changes mid-run | drift, for the decay |

Splits against overfitting: connector variants and world seeds are divided into **tune** and **held-out**; every
reported number is on held-out ones; held-out sets rotate when they have been looked at too often.

**Gate to tier 3**: on held-out zoo connectors, reachability and recall beat both the current single-query behaviour
and the best fixed shape per connector kind, with false fires and source calls per lookup no worse (95% intervals
not overlapping in the right direction).

### Tier 3 — real connectors, seeded with the simulated world

The key idea: **put a simulated world into real services**, so real search semantics meet known ground truth.

0. **A local lab first**, no accounts needed, **built** (docs/research/connector-lab.md): open-source MCP servers
   from pinned commits, each in front of a real backend in a container (Meilisearch, Dovecot, Radicale, Gitea,
   Chroma, file-backed stores), seeded with a simulated world and run with no secrets and no network beyond their
   backend. It measures each query variant's reach, empty rate, result size and latency against world labels. First
   runs (10 configurations, one world): Eden's current query reaches 0% on the 6 whole-string-substring connectors,
   where one call per entity reaches 27–77% of the same cases; the best variant differs by connector (per entity on
   most, the cue's terms on OR and FTS search, the raw question on vector search). Next: more connectors (CRM,
   wiki, chat), more seeds, and the per-connector baselines phase 0 needs.
1. **Sandbox accounts**, never personal ones, for hosted services with no open-source backend: a Google Workspace
   test domain (Gmail, Calendar, Drive), a Notion test
   workspace, a Slack test workspace, a HubSpot developer sandbox, a Linear or Jira free workspace, a GitHub test
   organisation (issues), a Postgres database behind an SQL MCP server, a filesystem MCP over a seeded folder, and a
   memory product's free tier.
2. **A seeding tool** (`packages/sim/src/seed/`), one adapter per service, that writes a world's items through each
   service's *write* API: emails as messages (delivered or imported), events, documents, CRM records, tickets, chat
   messages. It records the mapping from world item id to the service's id. Seeding is a test fixture, separate from
   Eden, which stays read-only (D7). Rate-limited and idempotent; one world per sandbox, reseeded on schedule.
3. **Real MCP servers** in front of each service: official ones where they exist, well-used community ones otherwise,
   pinned by version.
4. **A real-connector runner** that plays the simulation's sessions against `McpSource` instances on those servers,
   with the planner on and off, and scores with the world's labels (mapping real ids back to world items).
5. **Recording**: every request and response is recorded (redacted, synthetic content only) into fixtures, so tier 3
   replays deterministically in CI without credentials, and live runs are needed only to refresh them and to catch
   drift.

Costs and limits: seeding writes are rate-limited by each service's API quotas (not yet looked up per service);
a world of ~1,500 items per service is enough. Live runs use real latency, so they are smaller (a few users, tens of
sessions) and run nightly, not per change.

**Gate to tier 4**: on at least five real services with different search behaviour, the planner improves
reachability and recall over the single-query baseline with no rise in false fires, 429s or timeouts, and the
probe's capability record matches what each service documents.

### Tier 4 — shadow mode on real accounts, with consent

Only with an account owner's explicit consent, and read-only. On real data there are no labels, so:

- run the planner in **shadow**: the current behaviour serves, the planner's queries run alongside within budget, and
  only aggregates are kept: result counts per shape, entity-hit rates, how often the planner's results include the
  item the served path delivered, latency, errors. No content, no query text, nothing per item leaves the process.
- weekly, the owner may label a small sample in a local tool (relevant / not) to calibrate the proxies.

This session already has Gmail and Google Calendar connectors on the owner's account; using them for shadow runs
needs the owner's explicit yes, and seeding them is out of the question.

## Prior work it draws on

From the literature, cited by name; nothing here was re-measured in this repository.

- **Uncooperative federated search**: Callan and Connell's query-based sampling (2001) learns a remote collection's
  vocabulary by sending queries and reading results; the capability probe is a narrow form of it, restricted to terms
  from the user's own data.
- **Verbose query reduction**: Bendersky and Croft (2008) and Kumaran and Carvalho (2009) select key concepts from
  long queries, which is what `entities` and `entity+term` approximate without a model.
- **Query performance prediction**: pre-retrieval predictors (idf of the terms, query clarity, Cronen-Townsend et al.
  2002) and post-retrieval ones (score spread, Shtok et al.'s NQC 2012) give a cheap confidence per shape; useful as
  bandit context and as the miss signal for vector connectors.
- **Bandits**: Thompson sampling with Beta posteriors (Chapelle and Li 2011, which also covers delayed feedback);
  discounting for non-stationary arms; off-policy evaluation by inverse propensity scoring, self-normalised (SNIPS,
  Swaminathan and Joachims 2015) to keep variance down with few lookups per user.

## Building it: phases

| Phase | Work | Exit |
|---|---|---|
| 0 | Decisions below; a labelled schema corpus from the surveyed servers (each search tool's `inputSchema` with its correct argument mapping); sim connector zoo with tune/held-out splits; the local lab; baselines (single query, each fixed shape) in sim and lab | baselines reported with intervals |
| 1 | `ContextualBandit` primitive (tests, benchmark); shape builders and escaping (fuzzed) | tier 1 green |
| 2 | `QueryPlanner` + engine wiring, behind `PartnerDeps.planner` (off by default then; on in the server since D33); content-free traces | tier 2 gate met |
| 3 | probe; schema-driven arguments; `toItems` extension | tier 2 gains hold on zoo variants with unknown argument names |
| 4 | seeding tool + real-connector runner + recording; sandbox accounts | tier 3 gate met on 5+ services |
| 5 | shadow mode, aggregates only | two weeks of shadow data on consenting accounts |
| 6 | default on; D-number recording the change; docs | reviewer approval, eval and sim reports in the PR |

Each phase is one or more PRs under CLAUDE.md's workflow: tests first, `bun run check`, `bun run eval`, the sim
matrix (tune and held-out), the reviewer subagent, docs in the same PR.

## After it ships: the iteration loop

Until the owner says stop, every iteration is one small, measured change:

1. **Pick** the top item from a ranked backlog, refreshed each iteration from: the funnel's biggest loss on held-out
   sim; the worst real-connector service in the latest tier-3 run; failing or flaky tests; the reviewer's and the
   security pass's open findings; the latest saturation profile; edge cases logged by shadow mode.
2. **Change** one thing, test first.
3. **Measure**: `bun run check`; `bun run eval`; the sim matrix on held-out splits (3 seeds, intervals); tier-3 replay
   from fixtures; a 60-second perf ramp. Live tier 3 nightly, soak weekly.
4. **Keep it only if** the target metric improves beyond its interval and no guardrail regresses: hard false-fire
   rate, secrets leaked (must be 0), source calls per lookup, 429s, `observe` p99, heap per user. Otherwise revert
   and record why.
5. **Ship**: commit, PR with before/after numbers, merge; update the report and a changelog.
6. **Every fifth iteration**: the reviewer subagent on everything since the last review; a security pass (query
   injection fuzzing, isolation tests, a privacy check that no query text reaches traces or logs); rotate held-out
   seeds; re-check that no number in the docs is stale.
7. **Report** each iteration in one short message: what changed, the numbers, what is next.

Iteration themes, in rough order once the basics hold: shape set and escaping per capability; reward weights and
decay; probe accuracy and cost; pagination; vector connectors; query expansion from the user's co-occurrence table;
cross-connector dedup of results; latency (parallel vs sequential shapes); memory of planner state; failure modes
(connectors that return everything, nothing, errors, or the same item for every query).

Guards against fooling ourselves: held-out connectors and seeds; real services as the final judge; no metric is
optimised without its guardrails; every number comes from a command run in that session (CLAUDE.md).

## Decisions

Needed before or during the work; each becomes a numbered entry in DECISIONS.md.

1. **Sandbox accounts** for tier 3: who creates them, and where their credentials live (environment secrets for this
   cloud environment, never the repository).
2. **Shadow mode on real accounts**: whose, with what consent, and what aggregates may be kept.
3. **Tenant-level priors** (D9): opt-in content-free counts per connector kind, or per-user learning only.
4. **A model budget** for the judge in live tier-3 runs (the current OpenRouter key's $0.01 limit is spent).
5. **Default-on criteria** for phase 6: decided, a cost-normalised gate (D31).
6. **Running third-party MCP servers in the lab**: granted by the owner on 2026-10-27, for pinned open-source
   servers in containers without secrets or network beyond their backend.
7. **Multi-tool connectors** (D7): keep one Eden source per search tool, or allow a connector with an operator-listed
   set of read-only search tools and a router.
