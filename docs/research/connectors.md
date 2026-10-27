# What real MCP connectors do with a query

Status: research for the query planner (docs/plans/query-planner.md), 2026-10-27. Source-level reading only: none of
these servers was run (see [Running them](#running-them)).

## Why

The simulation showed that a connector's search semantics decide most of recall (docs/research/simulation.md). The
planner plan assumed connectors take one free-text string and differ only in how they match it. This survey checks
that assumption against the code of real, open-source MCP servers that tenants could plausibly connect.

## Method

115 open-source MCP server repositories were cloned (mail, calendar, contacts, notes and wikis, CRMs, ticketing,
chat, search engines, vector stores, databases, memory products). A script listed the tools each declares and flagged
search-like names; it found search tools in 67 repositories. It found none in 38, which says more about the script
(tools registered through decorators or generated tables) than about the servers. For the servers below, the search
tool's schema and the code path down to the backend call were read by hand; `file:line` points into each clone at the
commit cloned on 2026-10-27. Backend behaviour that was not read in code or docs is marked *unverified*.

## Findings

### Call archetypes

A planner that only builds a query string covers one of eight shapes of call:

| | Archetype | Examples (file:line) | What the planner must produce |
|---|---|---|---|
| A | one free-text string | Meilisearch `search` (`meilisearch_meilisearch-mcp/src/meilisearch_mcp/server.py:179`), mem0 `search_memories` (`mem0ai_mem0-mcp/src/mem0_mcp_server/server.py:260`), HubSpot `hubspot_search_data`, notmuch `mail_search`, Wiki.js `search_pages`, mcpvault `search_notes`, Basic Memory | a string, in the backend's syntax |
| B | structured field criteria, no free text | IMAP `imap_search_emails` (`nikolausm_imap-mcp-server/src/tools/email-tools.ts:269-300`): `from`, `subject`, `body`, dates | cue parts assigned to fields (an entity that is a person to `from`, a topic to `subject` or `body`) |
| B+A | free text plus field filters | JMAP `search_emails` (`wyattjoh_jmap-mcp/packages/jmap-mcp/src/tools/email.ts:167-271`): `query` → `filter.text`, plus `from`/`to`/`subject`, ANDed; Slack `conversations_search_messages` (`korotovsky_slack-mcp-server/pkg/server/server.go:254-296`) | a string and, optionally, filters; every filter added narrows |
| C | text plus *required* context | CalDAV `caldav_search_events` needs `start_date`/`end_date` (madbonez); Typesense `typesense_search` needs `collection` and `query_by` (`suhail-ak-s_mcp-typesense-server/src/index.ts:266`); Rocket.Chat `search_messages` needs `channel` (`rc-enyonee/main.go:828-844`); Chroma needs `collection_name` | values for required arguments that are not text: a time window, a collection, a field list, a channel. Without them the call fails or searches nothing |
| D | a query DSL object | Elasticsearch `search_documents(index, body)` (cr7258) | a structured query (for example a `multi_match`) built by Eden, never from input text |
| E | SQL only | postgres-mcp `execute_sql`, `mysql_query` (benborla) | out of scope for free-text lookups (see [Implications](#implications)) |
| F | path glob, not content | reference filesystem `search_files` (`modelcontextprotocol_servers/src/filesystem/lib.ts:663-689`, minimatch over paths); dbhub `search_objects` (`bytebase_dbhub/src/tools/search-objects.ts:30-34`, a LIKE pattern over table and column *names*) | a filename or object-name pattern; content is reached by a second, read tool |
| G | an array of queries | Chroma `chroma_query_documents(query_texts: List[str])` (`chroma-core_chroma-mcp/src/chroma_mcp/server.py:398`) | several shapes in one call |
| H | one search tool per entity type | EspoMCP `search_contacts`, `search_accounts`, `search_leads`, … (`cauldr0nx_EspoMCP/src/tools/index.ts:879-918`); SuiteCRM `search_contacts`/`search_leads`; Krayin; Asana `search_projects`/`search_tasks`; Linear (tacticlaunch) issues/documents/releases | a choice of tool per cue, or several calls |

### Match semantics, as read in code

| Semantics | Where | Effect on a multi-word cue |
|---|---|---|
| whole string as one substring | CalDAV (`madbonez_caldav-mcp/src/mcp_caldav/client.py:845-880`), reference memory `search_nodes` (`modelcontextprotocol_servers/src/memory/index.ts:660-665`), Twenty `search_records` (`mhenry3164_twenty-crm-mcp-server/index.js:28-44`, `ilike %q%` per field), each IMAP field | fails unless the words are contiguous in the item; a full name works, `Globex call` does not |
| every term, as prefixes, AND | Basic Memory (`basicmachines-co_basic-memory/src/basic_memory/repository/sqlite_search_query.py:155`) | narrows with each term; falls back to OR when the strict query finds nothing (lines 232-237) |
| any term, OR, then a BM25-style rerank | mcpvault (`bitbonsai_mcpvault/src/search.ts:54`, `:121`) | broad; ranking decides |
| ranked, typo-tolerant | Meilisearch (backend docs) | broad; ranking decides |
| vector similarity | mem0, Chroma, HubSpot (FAISS over a local cache, `peakmojo_mcp-hubspot/src/mcp_server_hubspot/handlers/search_handler.py:63`), Qdrant | always returns *something*; an empty result never signals a miss |
| raw provider syntax passed through | Gmail (`GongRzhe_Gmail-MCP-Server/src/index.ts:677`), notmuch (query documented as `notmuch-search-terms(7)`), GitHub (`github_github-mcp-server/pkg/github/issues.go:1973-1984`, lexical and semantic modes), Zulip `search` narrow (`zulip-akougkas/src/zulipchat_mcp/tools/search.py:154`) | AND by default; operators in the cue become syntax |
| deployment-dependent | Gitea `search_issues` (database LIKE or a Bleve/Elastic indexer, chosen by the Gitea admin; *unverified* which); Redmine `search_entire_redmine` ("case sensitivity controlled by server DB config", `redmine-jztan/src/redmine_mcp_server/tools/search.py:106`) | the same server behaves differently per tenant |

### Injection surfaces found

Cue terms come from untrusted text. These servers turn query text into syntax:

- **Gmail, notmuch, GitHub, Zulip**: operators (`from:`, `in:trash`, `OR`, `-`, `date:`) are honoured, by design.
- **Basic Memory**: caller `AND`/`OR`/`NOT` are kept (`sqlite_search_query.py:191-214`).
- **Wiki.js** (heAdz0r): the query is interpolated into a GraphQL document unescaped:
  `search (query: "${query}", limit: ${limit})` (`heAdz0r_wikijs-mcp-server/src/api.ts:101-115`). A `"` in a cue
  breaks the request, and a crafted cue can add GraphQL fields to the read. It stays a read, but the planner must not
  send quotes to a connector it has not probed.
- **Elasticsearch**: the DSL is whatever Eden builds; a `query_string` query would parse Lucene syntax from the cue,
  so only `multi_match`/`match` may be used.
- **SQL servers**: never send cue text to `execute_sql`.

### Read-only annotations

Many servers now mark tools: Meilisearch (`READ_ONLY`), notmuch (`annotations=READ_ONLY`), Slack
(`WithReadOnlyHintAnnotation(true)`), Gitea (ReadOnly), dbhub (`search_objects` passes `readonly`). Many do not.
Several of the same servers ship destructive tools next to search: IMAP `imap_bulk_delete_by_search`, Elasticsearch
`delete_by_query`, the archived reference SQLite server's `write_query`. D7's rule, that Eden calls only the configured
read-only search tool and `McpSource` checks it, is load-bearing; a hint annotation is a claim by the server, not a
guarantee, so it may inform defaults but never replace the operator's choice.

## Implications

1. **Schema-driven arguments are the core of the planner, not an add-on.** Building strings covers archetype A. B, C,
   D, G and H need a mapping from the cue to a tool's arguments, and C fails without one. The mapper must:
   - fill required non-text arguments from operator config (collection, index, channel, `query_by`) or from the cue's
     own context (a time window for calendars: the event's date ± a range), and refuse the call when it cannot;
   - assign typed entities to field arguments (person → `from`/`to`/attendee, organisation → company/name,
     id → id field), and treat every extra field as a narrowing AND;
   - build DSL objects from a fixed template per backend, never from text.
2. **Archetype H stretches D7.** D7 assumes one configured search tool per connector. A CRM exposing one tool per
   entity type needs either one Eden source per tool (works today, costs a call per tool per lookup) or a connector
   with a small, operator-listed set of read-only tools and a router. The second needs a new decision; until then the
   lab configures one source per tool.
3. **Whole-string substring is common** (four of the servers read) and defeats every multi-term shape. `each-entity`
   and `phrase` matter more than the simulation suggested; the probe must detect "two co-occurring terms return
   nothing" and switch to single-term shapes.
4. **Vector connectors never return empty**, so "empty result" cannot be the miss signal. The immediate reward
   (cue entity present as whole terms) is the only cheap signal there, and a score threshold per connector is needed.
5. **Deployment-dependent servers** (Gitea, Redmine) mean priors cannot be per *server* kind alone; the probe result
   per (user, connector) has to win over any kind-level prior.
6. **SQL and path-glob connectors** are not lookup targets for free-text cues. They stay usable through
   operator-written templates (a fixed parameterised query, a path prefix), never generated queries.

## Running them

The plan's tier 3 needs these servers running against seeded backends. In this session:

- Backends run: official images pulled from mirrors (Docker Hub's anonymous pulls are rate limited here):
  `mirror.gcr.io/library/postgres:16-alpine`, `mirror.gcr.io/getmeili/meilisearch:v1.12`, `docker.gitea.com/gitea:1.22`.
  Meilisearch was started and answered its health check.
- The MCP servers themselves were **not** run: installing a cloned third-party repository was refused by this
  session's safety policy, because it executes code from outside the repository. Running them needs the owner's
  explicit permission (for example a permission rule for the lab's install commands), or pinned, published packages
  run in containers with no access to secrets. Containers here also lack the proxy's CA, so they cannot install
  packages from the network without it being mounted.

## Next

- A schema corpus: every search tool's `inputSchema` from these clones, with the hand-labelled correct argument
  mapping, as the test set for the schema mapper (plan phase 0).
- The lab, once running servers is allowed: seed one simulated world per backend through its write API and measure
  each query shape's reachability, empty rate and latency per connector (plan tier 3).
