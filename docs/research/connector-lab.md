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
what any later stage (cache scoring, judge) can deliver from that connector; it is not end-to-end recall. Results are
capped at 10 where the tool takes a limit.

## Isolation

Third-party code is installed and built only inside `docker build` (`bun run sim:lab:build`), with the session's
HTTPS proxy and its CA, from the commits in `packages/sim/lab/servers.json`. At run time each server is
`docker run -i --rm` over stdio with no host environment (the transport passes only `PATH` to the Docker CLI), with
`--network none`, or with only the internal `lab-net` network where its backend lives (`docker network create
--internal`: no route out). Backends are official images from registry mirrors (Meilisearch, Dovecot, Gitea), or
Radicale installed from PyPI. Lab credentials are fixed test strings for those containers.

## Results

Reach by variant, with 95% Wilson intervals. n = cases with text / cases with an entity.

| Connector (search semantics) | n | question | terms (today) | entities | each-entity | entity+term |
|---|---|---|---|---|---|---|
| memory: reference server, whole query as one substring | 196/156 | 0% (0–2) | 0% (0–2) | 64% (56–71) | **93%** (88–96) | 0% (0–2) |
| caldav: whole query as one substring, date window | 73/57 | 0% (0–5) | 0% (0–5) | 74% (61–83) | **100%** (94–100) | 0% (0–6) |
| imap-body: IMAP BODY substring (Dovecot) | 154/120 | 0% (0–2) | 0% (0–2) | 30% (23–39) | **47%** (38–56) | 0% (0–3) |
| imap-subject: IMAP SUBJECT substring | 154/120 | 0% (0–2) | 0% (0–2) | 47% (38–56) | **65%** (56–73) | 0% (0–3) |
| gitea-db: issue search, database indexer | 196/156 | 0% (0–2) | 0% (0–2) | 16% (11–23) | **33%** (26–41) | 0% (0–2) |
| gitea-bleve: issue search, Bleve indexer | 196/156 | 0% (0–2) | 0% (0–2) | 17% (12–23) | **34%** (27–42) | 0% (0–2) |
| basic-memory: FTS5, AND of prefixes, OR fallback | 196/156 | 59% (52–66) | 63% (56–70) | 69% (61–75) | **76%** (68–82) | 44% (36–51) |
| meilisearch: ranked, typo-tolerant | 196/156 | 10% (6–15) | 30% (24–37) | 66% (58–73) | **80%** (73–86) | 70% (63–77) |
| mcpvault: any term (OR), then BM25-style rerank | 196/156 | 72% (65–78) | **83%** (77–87) | 67% (59–74) | 64% (56–71) | 64% (56–71) |
| chroma: vector, all-MiniLM-L6-v2 | 196/156 | **91%** (87–95) | 87% (82–91) | 74% (67–81) | 70% (63–77) | 69% (61–75) |

Cost and shape of results, for the `terms` variant (what Eden sends today) unless noted:

| Connector | Seeded | Seed + index | Empty (terms) | Empty (each-entity) | Calls per case (each-entity) | Items returned (terms) | Latency p50 / p95 |
|---|---|---|---|---|---|---|---|
| memory | 1,499 | 0.0 s | 100% | 6% | 1.37 | 0 | 21 / 26 ms |
| caldav | 85 events | 1.6 s | 100% | 0% | 1.26 | 0 | 89 / 125 ms |
| imap-body | 1,214 mails | 4.6 s | 100% | 8% | 1.32 | 0 | 43 / 55 ms |
| imap-subject | 1,214 mails | 4.4 s | 100% | 11% | 1.32 | 0 | 5 / 8 ms |
| gitea-db | 1,499 issues | 33.8 s | 100% | 6% | 1.37 | 0 | 31 / 42 ms |
| gitea-bleve | 1,499 issues | 40.6 s | 100% | 6% | 1.37 | 0 | 10 / 13 ms |
| basic-memory | 1,499 | 206.8 s | 15% | 4% | 1.37 | 6.8 | 55 / 2,076 ms |
| meilisearch | 1,499 | 1.3 s | 41% | 0% | 1.37 | 5.1 | 6 / 9 ms |
| mcpvault | 1,499 | 0.0 s | 0% | 3% | 1.37 | 9.2 | 247 / 340 ms |
| chroma | 1,499 | 45.3 s | 0% | 0% | 1.37 | 10 | 240 / 284 ms |

Latency is the server and backend on this machine with no network between them, not a hosted service.

## Findings

1. **What Eden sends today reaches nothing on 6 of 10 connectors.** Six of the ten configurations match the whole
   query as one string: the reference memory server, CalDAV, both IMAP fields and both Gitea indexers. On all six,
   `terms`, `question` and `entity+term` reach 0% and come back empty every time. The same cases reach 33–100%
   through `each-entity`. This is the code reading in docs/research/connectors.md, now measured.
2. **No variant wins everywhere.** `each-entity` is best on the six substring connectors and on Basic Memory and
   Meilisearch. `terms` is best on mcpvault (OR matching), and the raw question is best on Chroma (vector search).
   On Meilisearch, the variant chosen moves reach from 10% to 80%. A fixed choice per connector *kind* would also
   be wrong: Basic Memory and mcpvault both search a folder of Markdown notes and want different variants.
3. **The empty rate separates the families cheaply.** For `terms`, substring connectors were 100% empty, ranked and
   OR ones 0–41%, and vector ones 0%. One probe query tells a planner which family it is talking to, except for
   vector search, which never returns empty (Chroma: 0% empty on every variant).
4. **Truncation, not matching, limits some connectors.** On Gitea, `each-entity` came back empty in 6% of cases but
   reached only 33%. A name like the user's own matches hundreds of issues, and the needed one is not in the first
   10. The deployment's indexer (database vs Bleve) made no measurable difference for these queries. Gitea also
   searches issue bodies, checked by a body-only word.
5. **Eden's `toItems` loses item identity on 8 of 10 configurations.** `toItems` reads a text block as JSON rows
   (an array or `{results: […]}`) and takes a row's ref from `id`, `ref` or `url`. The servers' shapes miss that:
   `{entities: […]}` (memory), an array of `{path…}` rows (mcpvault), `{results: [{permalink…}]}` (Basic Memory),
   `{messages: [{uid…}]}` (IMAP), events keyed by `uid` (CalDAV) and Chroma's columnar `{ids: [[…]]}`. Meilisearch
   puts a prose line ("Search results for '…':") before its JSON, and also returns MCP `structuredContent`, which
   `toItems` ignores. So every item got a positional ref (`block-0-3`); only Gitea, whose issues carry `id` and
   `html_url`, kept its identity. The partner's per-user cache is keyed by item id, so each lookup to such a
   connector overwrites the previous lookup's items, and the ledger can take a new item for one already delivered.
   This is a bug, fixed separately.
6. **Half of these servers do not annotate their search tool read-only.** The reference memory server, Basic Memory,
   Meilisearch and Gitea do; mcpvault, CalDAV, the IMAP server and Chroma do not. `McpSource` refused CalDAV until
   the lab's trust list named it (the first CalDAV report in the raw file, all calls refused). Under D7 that refusal
   is right: an operator checks such a tool by hand and lists it. Two of the unannotated servers offer a read-only
   mode instead (mcpvault `--read-only`, IMAP `IMAP_MCP_READ_ONLY=1`), which the lab uses.
7. **Fresh installs break.** Two of eight servers failed on a clean install from their own pinned commit, because
   of dependency drift. The CalDAV server's unpinned `mcp>=1.3` resolved to mcp 2.3.0, which removed the API it
   uses. Chroma's pinned `mcp==1.6.0` imports a pydantic internal that newer pydantic removed. Pinning a server's
   commit is not enough: the lab holds back the two breaking packages (`mcp<2`, `pydantic<2.11`) but does not yet
   lock every resolved dependency, so a rebuild can drift. Tenants' connectors will fail this way in the wild, which
   `McpSource`'s retry-after-failure handles.
8. **Result size is unbounded on some servers.** The reference memory server has no limit argument and returned 38
   items per `each-entity` case on average. A planner has to bound what it keeps per call, not trust the server.
9. **Indexing costs differ by orders of magnitude.** Basic Memory took 207 s to index 1,499 notes and had a 2 s
   p95 per search; Meilisearch indexed them in 1.3 s with a 9 ms p95.

## Caveats

- One world (seed 1000) and one case set. Intervals cover case sampling, not world variation. Reruns on other seeds
  are the next step before any number becomes a decision.
- Every connector except CalDAV and IMAP holds the whole world (mail, events, docs, CRM, chat), so connectors are
  compared on the same data. A real CRM or wiki would hold only its own kind.
- `each-entity` costs 1.26–1.37 calls per case here, against 1 for the other variants.
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
- More seeds; then the planner plan's phase 0 baselines come from this table, not from assumptions.
- More connectors: a CRM (Twenty or EspoCRM, archetype H), a wiki (BookStack or Wiki.js, including the unescaped
  GraphQL interpolation in docs/research/connectors.md), notmuch, Rocket.Chat (required channel), JMAP via Stalwart.
- Variants a planner would add: phrase-quoted entities where the probe finds quotes are supported, field mapping
  (from/to for people) on IMAP and JMAP, larger limits or pagination where truncation dominates (Gitea).
