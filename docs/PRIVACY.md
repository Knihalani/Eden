# Privacy, security and subprocessors

Eden reads the most sensitive data a person has (mail, calendar, documents) on behalf of a tenant's agent. The
tenant's end users must be told Eden processes their data, and Eden in turn uses a model provider. This document
is the engineering side of that story. It is not legal advice and not a certification. Never claim "Eden is ZDR".

## Data flow

| Data | Where it goes | Retention in Eden |
|---|---|---|
| Session events (messages, tool calls) | Eden server memory: a 12-event window per session, redacted | Until session end, idle timeout (2 h), eviction, `forget`, or restart |
| Source items (mail, events, docs) | Per-user in-memory cache, all fields redacted, text capped at 8,000 chars | 24 h TTL, 2,000 items per user, 10,000 users per process, never written to disk (D8) |
| Entity names (names, handles, ids only), source ids, counts | SQLite source map | Until `forget` (user deletion or connector revocation) |
| Query-planner learning: per connector, query-shape names and two numbers each (`planner_arm`; no query text) | SQLite source map, on by default (D33) | Until `forget` |
| Probe economy (`probeFresh`, `probeYield`, off by default; D50): per user, the probe queries sent (names and topics from the redacted request), hashes of each query's last answer, item ids, call and hit counts | Eden server memory | 512 queries and 2,048 finds per user, 1,000 users per tenant; dropped on `forget`, eviction or restart |
| Who takes part in cached items (`ItemCache` counts per name, to find the user's own name; D48) | Eden server memory, with the item cache | As the cached items: counts fall as items expire or are evicted; dropped on `forget` |
| Consequence probe (`consequenceProbe`, off by default; D54): per user, which source answers which class query and how each source searches several words (counts and query forms of fixed class vocabulary; no user text is sent or kept) | Eden server memory, with the probe economy | 256 class records and 64 search forms per user; dropped on `forget`, eviction or restart |
| Synced source items (`sync`, off by default; D57): each active user's sources read through their read-only list tools, redacted as lookups' items are | The same per-user in-memory cache, under their own cap | 5,000 synced items per user (`maxSyncedPerUser`), 7 days per item (`syncTtlMs`, renewed when re-listed), dropped when two daily sweeps in a row do not list them (so within about 48 h of a delete at the source, D63), all of a user's dropped after 7 days idle (`syncDropMs`), 1,000 synced users per tenant; never written to disk; dropped on `forget`, and pages arriving after a `forget` are not stored. More content, held longer than D8's 24 h: a departure D57 records. With `syncPush` (off by default, D66) a pushed source's change notices carry no content, only, for deletes, the ids to drop, which go at once; its sweeps run every 3 days, so a delete a notice does not name is dropped when two sweeps in a row miss it (about 6 days) or the item's 7-day TTL lapses unrenewed, whichever comes first **The names synced items mention are recorded in the source map** (the entity-names row above) as looked-up items' are, for up to 5,000 items per user: they stay there until `forget`, beyond the items' own 7 days, their deletion at the source and the idle drop (D63) |
| Knowledge graph (`graph`, off by default; D58): per user, names, addresses, organisations, identifiers, roles, channels and days read from the first 4,000 characters of each cached (already redacted) item, with typed links and learned edge weights | Inside the user's in-memory cache entry | Built and dropped with the items it was read from (expiry, eviction, `forget`); 48 nodes per item, 64 links per node, 120,000 nodes per user; never written to disk |
| Implication cards (`cards`, off by default, and only with a `CardEnricher`; D59): per user, a small structured card per item (constraint kind, actions, entities, dates, limit, a redacted one-line statement), keyed by a content hash | Eden server memory. **Item text (redacted, fenced as data) is sent to the model provider to make them**, in the background, ten items per call (twenty with `cardsEconomy`, D66, which also sends fewer items: footers and a reply's subject are not read, and items saying the same constraint sentences share one card, by a per-user hash of those sentences held with the cards), under a per-user-day budget | 4,000 cards per user, 10,000 users per tenant, 200 items queued per user; a card goes when no cached item has its content any more (expiry, eviction, deletion at the source, the sync's idle drop), at the latest 7 days after an item last carried it, and a revoked source's cards go with its `forget` (D63); dropped on `forget` (in-flight results discarded); never written to disk. The card's statement never reaches the agent |
| Anticipation (`anticipate`, off by default; D60): per user, which names followed which action intents (`IntentPatterns`); per session, which names, days and classes were prefetched | Eden server memory | 16 intents × 8 names per user, 10,000 users per tenant, each name kept 7 days after a delivery last taught it (D63); session state ends with the session; dropped on `forget`. A draft (`user_message` with `draft: true`) is handled as any event: redacted, windowed, never stored beyond the session |
| Engine spans (`spans`/`onSpan`, off by default; D56) | The embedder's sink | Content-free: phase names, timings, counts, connector ids, statuses, the session id (D19) |
| Planner call latency per connector (numbers only) | Eden server memory | 10–20 min rolling window, `forget`, eviction or restart |
| Model inputs (window + ≤ 6 candidates, redacted) | OpenRouter → a provider endpoint | Eden keeps nothing. Provider retention depends on routing; see below |
| Traces | Operator logs, if `EDEN_TRACE=1` | Content-free: ids, a hashed cue id, decisions, latency, cost, and the planner's connector ids, shape names and call and item counts (D19) |

## Subprocessors (current design)

1. **OpenRouter**, routing to a model provider for GLM 5.3 Flash. Requests set `provider.data_collection: "deny"` and
   `provider.zdr: true`. **To verify before launch:** that these fields are honoured as named on OpenRouter's current
   API (the smoke test on 2026-10-27 shows the API accepted the request, not that routing was restricted), which
   providers serve the model under ZDR, and OpenRouter's own retention terms.
2. **Hosting provider** (not chosen).
3. The user's **source providers** are not Eden's subprocessors: the user connected them, and Eden only reads.

Tenants will need: a subprocessor list, a DPA, a data-flow diagram (this file is the start), regional hosting options,
and a statement on training (none).

## Controls in code

- **Isolation:** tenant from the API key; per-user partitioning of every cache, map row and budget (D9).
- **Redaction:** `sanitizeForStore` on all stored, indexed, logged or model-bound text (D10).
- **Read-only sources:** `McpSource` calls only its configured search tool, and refuses it unless the server declares
  it read-only or an operator trusts it (D7). Annotations are self-declared, so only trusted servers are connected.
  A list tool for the sync (`listTool`, D57) passes the same check, or the connection fails.
- **Model-bound background work:** with `cards` (D59), item text leaves Eden for the model provider even when no
  request is made; tenants who turn it on must disclose it, and the budget caps how much.
- **Prompt injection:** source text is wrapped and labelled as data; model prompts say item text is never
  instructions; the judge returns indexes only and its free text never reaches the agent, and ask answers are wrapped
  in the same data envelope, so a malicious item cannot add words of its own beyond being picked (D11, D19).
  The agent still receives the item text: tenants should treat injections as untrusted input.
- **Deletion:** `POST /v1/forget` drops a user's (or one source's) cache and map rows and the user's live sessions,
  aborting in-flight lookups so nothing is re-cached afterwards (D17).
- **Fail-open client:** an Eden outage never blocks the tenant's agent.

## Open items

Encryption at rest for the source map; audit log of reads per user; per-tenant key rotation; regional deployment;
retention configuration per tenant; a pen test before the first real tenant.
