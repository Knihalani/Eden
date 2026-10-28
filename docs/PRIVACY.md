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
