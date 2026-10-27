# The connector lab: real MCP servers, a simulated world, known answers

Status: first runs, 2026-10-27. Code in `packages/sim/src/lab/`, images in `packages/sim/lab/`. Raw reports:
[connector-lab.jsonl](connector-lab.jsonl).

## What it is

Tier 3 of the query-planner plan (docs/plans/query-planner.md), without any accounts. Each connector is an
open-source MCP server, built from a pinned commit, in front of a real backend, seeded with a simulated world (seed
1000: 1,499 items) through the backend's own write path. Eden's `McpSource`, including its read-only check, then
sends every case through five query variants. Every seeded item carries its world key in a field the server returns
(a document id, file path, Message-ID, UID, issue number or calendar UID), so each result maps back to world items
exactly and is scored against the world's labels.

A case is an agent question or a user turn that needs a fact: 196 cases from 45 asks and 120 sessions
(`labCases`). A case counts for a connector when one of its needed facts is in an item that connector holds.

The variants are instrumentation, not a planner:

| Variant | Sends | For "Prep me for the Globex call with Sam Ortiz" |
|---|---|---|
| `question` | the text as written (an integrator passing the agent's words through) | the whole sentence |
| `terms` | the cue Eden sends today: distinct content terms | `prep globex call sam ortiz` |
| `entities` | the cue's entities, joined | `Globex Sam Ortiz` |
| `each-entity` | one call per entity (up to 3) | `Globex`, then `Sam Ortiz` |
| `entity+term` | the first entity and the cue's rarest other term | `Globex call` |

**Reach** is the share of cases where a variant's calls returned at least one item holding a needed fact. It bounds
what any later stage (cache scoring, judge) can deliver from that connector; it is not end-to-end recall. A call
keeps at most 10 results, in the server's order, as a client would, even from servers with no limit argument.

## Isolation

Third-party code is installed and built only inside `docker build` (`bun run sim:lab:build`), with the session's
HTTPS proxy and its CA, from the commits in `packages/sim/lab/servers.json`. At run time each server is
`docker run -i --rm` over stdio. The container gets only the variables the lab sets with `-e`; the Docker CLI gets
only `PATH`, `HOME` and the `DOCKER_*` settings that locate the daemon. Each server runs with `--network none`, or
with only the internal `lab-net` network where its backend lives (`docker network create --internal`: no route out;
the lab refuses to run if a network of that name is not internal). Backends are official images from registry
mirrors (Meilisearch, Dovecot, Gitea), or Radicale installed from PyPI. Lab credentials are fixed test strings for
those containers.

Build time is not sandboxed the same way: package installs run third-party build code (`setup.py`, npm lifecycle
scripts where not disabled, Go module code generation) with network access through the proxy. They see no secret of
this session, since only `HTTPS_PROXY` and the proxy's CA are passed in, but they are not isolated from the network.

## Results

Reach by variant over every case the connector can answer, with 95% Wilson intervals; the best variant is bold. A
case with no entity in its text counts as a miss for the three entity variants, so every column is scored on the
same cases.

| Connector (search semantics) | Cases | question | terms (today) | entities | each-entity | entity+term |
|---|---|---|---|---|---|---|
| memory: reference server, whole query as one substring | 196 | 0% (0–2) | 0% (0–2) | 48% (42–55) | **71% (65–77)** | 0% (0–2) |
| caldav: whole query as one substring, date window | 73 | 0% (0–5) | 0% (0–5) | 56% (45–67) | **77% (66–85)** | 0% (0–5) |
| imap-body: IMAP BODY substring (Dovecot) | 154 | 0% (0–2) | 0% (0–2) | 23% (17–31) | **36% (29–44)** | 0% (0–2) |
| imap-subject: IMAP SUBJECT substring | 154 | 0% (0–2) | 0% (0–2) | 36% (29–44) | **51% (43–58)** | 0% (0–2) |
| gitea-db: issue search, database indexer | 196 | 0% (0–2) | 0% (0–2) | 13% (9–18) | **27% (21–33)** | 0% (0–2) |
| gitea-bleve: issue search, Bleve indexer | 196 | 0% (0–2) | 0% (0–2) | 13% (9–19) | **27% (21–34)** | 0% (0–2) |
| basic-memory: FTS5, AND of prefixes, OR fallback | 196 | 59% (52–66) | **63% (56–70)** | 55% (48–61) | 60% (53–67) | 35% (28–42) |
| meilisearch: ranked, typo-tolerant | 196 | 10% (6–15) | 30% (24–37) | 53% (46–59) | **64% (57–70)** | 56% (49–63) |
| mcpvault: any term (OR), then BM25-style rerank | 196 | 72% (65–78) | **83% (77–87)** | 53% (46–60) | 51% (44–58) | 51% (44–57) |
| chroma: vector, all-MiniLM-L6-v2 | 196 | **91% (87–95)** | 88% (82–92) | 59% (52–66) | 56% (49–63) | 55% (48–61) |

Where the entity variants apply (cases whose text names an entity), their reach is higher:

| Connector | Cases with an entity | entities: reach where it applies | each-entity: reach where it applies |
|---|---|---|---|
| memory | 156 of 196 | 95/156 = 61% | 140/156 = 90% |
| caldav | 57 of 73 | 41/57 = 72% | 56/57 = 98% |
| imap-body | 120 of 154 | 36/120 = 30% | 56/120 = 47% |
| imap-subject | 120 of 154 | 56/120 = 47% | 78/120 = 65% |
| gitea-db | 156 of 196 | 25/156 = 16% | 52/156 = 33% |
| gitea-bleve | 156 of 196 | 26/156 = 17% | 53/156 = 34% |
| basic-memory | 156 of 196 | 107/156 = 69% | 118/156 = 76% |
| meilisearch | 156 of 196 | 103/156 = 66% | 125/156 = 80% |
| mcpvault | 156 of 196 | 104/156 = 67% | 100/156 = 64% |
| chroma | 156 of 196 | 116/156 = 74% | 110/156 = 71% |

Cost and shape of results:

| Connector | Seeded | Seed + index | Empty (terms) | Empty (each-entity) | Calls per case (each-entity) | Items kept per case (terms) | Items sent per case, uncapped (each-entity) | Latency p50 / p95 (terms) |
|---|---|---|---|---|---|---|---|---|
| memory | 1,499 | 0.0 s | 100% | 6% | 1.37 | 0 | 39.1 | 21 / 28 ms |
| caldav | 85 | 1.5 s | 100% | 0% | 1.26 | 0 | 2.9 | 81 / 107 ms |
| imap-body | 1,214 | 4.2 s | 100% | 8% | 1.32 | 0 | 7.7 | 41 / 53 ms |
| imap-subject | 1,214 | 4.0 s | 100% | 11% | 1.32 | 0 | 4.4 | 5 / 8 ms |
| gitea-db | 1,499 | 31.9 s | 100% | 6% | 1.37 | 0 | 9 | 29 / 40 ms |
| gitea-bleve | 1,499 | 38.9 s | 100% | 6% | 1.37 | 0 | 9 | 9 / 12 ms |
| basic-memory | 1,499 | 209.3 s | 15% | 4% | 1.37 | 6.8 | 10.5 | 53 / 2,116 ms |
| meilisearch | 1,499 | 1.3 s | 41% | 0% | 1.37 | 5.1 | 10.7 | 5 / 7 ms |
| mcpvault | 1,499 | 0.1 s | 0% | 3% | 1.37 | 9.2 | 10.9 | 220 / 263 ms |
| chroma | 1,499 | 41.8 s | 0% | 0% | 1.37 | 10 | 13.7 | 248 / 306 ms |

Latency is the server and backend on this machine with no network between them, not a hosted service.

## Findings

1. **What Eden sends today reaches nothing on 6 of 10 connectors.** Six of the ten configurations match the whole
   query as one string: the reference memory server, CalDAV, both IMAP fields and both Gitea indexers. On all six,
   `terms`, `question` and `entity+term` reach 0% and come back empty every time. On the same cases, one call per
   entity reaches 27–77%; the rest are cases with no entity in their text (20–22% of cases) and entities that do
   not find the item. This is the code reading in docs/research/connectors.md, now measured.
2. **No variant wins everywhere.** `each-entity` is best on the six substring connectors and on Meilisearch, where
   the variant chosen moves reach from 10% to 64%. `terms` is best on mcpvault (OR matching, 83%) and on Basic
   Memory (63% against 60% for `each-entity`, within the intervals), and the raw question is best on Chroma (vector
   search, 91%). A fixed choice per connector *kind* would also be wrong: Basic Memory and mcpvault both search a
   folder of Markdown notes, and on mcpvault `terms` beats `each-entity` by 32 points.
3. **The empty rate separates the families cheaply.** For `terms`, substring connectors were 100% empty, ranked and
   OR ones 0–41%, and vector ones 0%. One probe query tells a planner which family it is talking to, except for
   vector search, which never returns empty (Chroma: 0% empty on every variant).
4. **Truncation, not matching, limits some connectors.** On Gitea, `each-entity` came back empty in 6% of the cases
   it applies to but reached only 33% of them. A name like the user's own matches hundreds of issues, and the
   needed one is not in the first 10. The deployment's indexer (database vs Bleve) made no measurable difference
   for these queries. Gitea also searches issue bodies, checked by a body-only word.
5. **Eden's `toItems` loses item identity on 8 of 10 configurations.** `toItems` reads a text block as JSON rows
   (an array or `{results: […]}`) and takes a row's ref from `id`, `ref` or `url`. The servers' shapes miss that:
   `{entities: […]}` (memory), an array of `{path…}` rows (mcpvault), `{results: [{permalink…}]}` (Basic Memory),
   `{messages: [{uid…}]}` (IMAP), events keyed by `uid` (CalDAV) and Chroma's columnar `{ids: [[…]]}`. Meilisearch
   puts a prose line ("Search results for '…':") before its JSON, and also returns MCP `structuredContent`, which
   `toItems` ignores. So every item got a positional ref (`block-0-3`); only Gitea, whose issues carry `id` and
   `html_url`, kept its identity. The partner's per-user cache is keyed by item id, so each lookup to such a
   connector overwrites the previous lookup's items, and the ledger can take a new item for one already delivered.
   This is a bug, to be fixed in its own change.
6. **Half of these servers do not annotate their search tool read-only.** The reference memory server, Basic Memory,
   Meilisearch and Gitea do; mcpvault, CalDAV, the IMAP server and Chroma do not. `McpSource` refused CalDAV until
   the lab's trust list named it (in a first run, not in the raw file: every call refused). Under D7 that refusal
   is right: an operator checks such a tool by hand and lists it. Two of the unannotated servers offer a read-only
   mode instead (mcpvault `--read-only`, IMAP `IMAP_MCP_READ_ONLY=1`), which the lab uses.
7. **Fresh installs break.** Two of eight servers failed on a clean install from their own pinned commit, because
   of dependency drift. The CalDAV server's unpinned `mcp>=1.3` resolved to mcp 2.3.0, which removed the API it
   uses. Chroma's pinned `mcp==1.6.0` imports a pydantic internal that newer pydantic removed. Pinning a server's
   commit is not enough: the lab holds back the two breaking packages (`mcp<2`, `pydantic<2.11`) but does not yet
   lock every resolved dependency, so a rebuild can drift. Tenants' connectors will fail this way in the wild, which
   `McpSource`'s retry-after-failure handles.
8. **Result size is unbounded on some servers.** The reference memory server has no limit argument and sent 39
   items per `each-entity` case on average; the lab keeps 10 per call, as a client would. A planner has to bound
   what it keeps per call, not trust the server.
9. **Indexing costs differ by orders of magnitude.** Basic Memory took 209 s to index 1,499 notes and had a 2.1 s
   p95 per search; Meilisearch indexed them in 1.3 s with a 7 ms p95.

## Caveats

- One world (seed 1000) and one case set. Intervals cover case sampling, not world variation. Reruns on other seeds
  are the next step before any number becomes a decision.
- Every connector except CalDAV and IMAP holds the whole world (mail, events, docs, CRM, chat), so connectors are
  compared on the same data. A real CRM or wiki would hold only its own kind.
- `each-entity` costs 1.26–1.37 calls per case where it applies, against 1 for the other variants.
- No combined variant was measured (for example `each-entity`, falling back to `terms` when the text names no
  entity); the lab does not keep per-case results yet, so its reach cannot be computed from these runs.
- The memory server's entity names carry the world key (`Dinner with Jamie Fox [calendar-event-0]`), because it
  merges entities by name. No case text contains a key, so this cannot cause a match.
- Basic Memory ran in `text` mode. Its default, hybrid search, needs an embedding model download, and the server has
  no network.

## Running it

```bash
bun run sim:lab:build                      # builds every image (needs Docker and network for the build)
bun run sim:lab --sessions 120             # all connectors, one JSON line each
bun run sim:lab --sessions 120 caldav      # one connector
```

## Next

- The `toItems` fix (finding 5), measured here before and after.
- Per-case results in the report, so combined variants can be scored without rerunning.
- More seeds; then the planner plan's phase 0 baselines come from this table, not from assumptions.
- More connectors: a CRM (Twenty or EspoCRM, archetype H), a wiki (BookStack or Wiki.js, including the unescaped
  GraphQL interpolation in docs/research/connectors.md), notmuch, Rocket.Chat (required channel), JMAP via Stalwart.
- Variants a planner would add: phrase-quoted entities where the probe finds quotes are supported, field mapping
  (from/to for people) on IMAP and JMAP, larger limits or pagination where truncation dominates (Gitea).
