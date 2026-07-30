# Disabled features register

Things that are switched **off** rather than deleted, with the reason and
the exact condition for turning them back on.

The rule that put things on this list: **a feature that reports success
while doing nothing is worse than a feature that is absent.** An absent
feature costs a customer nothing. A lying one costs them their trust and
sends them debugging their own code.

Last reviewed: 2026-07-30.

---

## 1. Time-travel replay — `time_travel_replay_enabled = False`

**Endpoint:** `POST /orgs/{org_id}/intelligence/time-travel/replay`
**Now returns:** 503 with an explanation. Forks, recording and the
timeline views are unaffected.

**Why.** It never re-executed anything, and said it did.

The recorder stores no prompt content. Both call sites
(`llmops/ai_gateway.py:757`, `api/routes/gateway.py:485`) pass a request
dict holding only model / prompt_hash / temperature, which
`recorder.py:162` nests under `payload["request"]`. The replayer looks
for `payload["messages"]` (`replayer.py:321`) and falls back to
`payload["prompt"]` (`:336`) — both top-level, both absent. With an
empty prompt it returns early at `:338`, handing back the **recorded**
`response_hash`, and `:188` then records `re_executed=True`.

A second, independent bug produces the same outcome even with the
payload fixed: `_apply_edits_to_step` (`_common.py:207`) writes edits
onto the *step* dict, while `_re_execute_step` reads from
`step["payload"]`. User edits never reach the prompt.

So a customer edits a prompt, gets back a byte-identical response hash,
and concludes the edit made no difference to the model. `tokens_saved`
and `cost_saved_usd` are fabricated.

**Re-enable when:** the recorder persists real message content, AND
edits are applied into `payload`, AND a test asserts that a changed
prompt produces a changed `response_hash`.

**Recording stays ON** — it is harmless, and its data is what a proper
fix needs.

---

## 1b. SSO routes — `sso_enabled = False`

**Routes:** everything under `/sso` (11 handlers). Not mounted at all,
so they no longer appear in the OpenAPI surface.

**Why.** Every handler in `api/routes/sso.py` queries
`org_sso_providers`, which does not exist. The live schema has
`org_sso_settings` and `sso_configurations` — verified directly against
the database.

`PostgresClient.fetch` does not swallow, so `GET /sso/providers` was an
unhandled 500 and `POST /sso/providers` a 503. Endpoints that can only
fail should not be advertised.

**Re-enabling needs more than creating the table.** The SCIM token is
*written* to `org_sso_providers.scim_token_hash` but *read* from
`org_scim_config.scim_token_hash` (`scim.py:166`), and nothing in the
codebase ever writes the latter — so SCIM could never be enabled
either, and every SCIM request 401s "SCIM not configured".

**Re-enable when:** the queries are repointed at `org_sso_settings` /
`sso_configurations`, the SCIM token is written where it is read, and a
test exercises one full provider round-trip. Then set `SSO_ENABLED=1`.

No customer-facing loss today: SSO was never functional, so nothing
that used to work has stopped.

---

## 1c. Signup email verification — `email_verification_enabled = False`

**What changed for users:** the signup response no longer says "Check
your email to verify before signing in." It now says the account was
created and they can sign in — which is what actually happens.

**Why.** None of the verification flow exists, in three independent
ways:

- `email_verification_tokens` is not a table, so the INSERT raised
  `UndefinedTable` on **every** signup;
- `send_verification_email` is not defined in `email_service.py`;
- there is no `/auth/verify-email` route anywhere in `src/eden/` — only
  a string in `default_deny.py`'s allowlist.

All three were swallowed by one `except Exception`, so each signup
issued a doomed database write and then told the user to check an inbox
that would never receive anything.

Accounts were never actually blocked: `login` does not check
`email_verified`. So the only damage was the false instruction and a
failing write per signup — but "go check your email" with no email is a
dead end on a customer's first minute with the product.

The enumeration-safe "If that email is not already registered…" prefix
is unchanged; only the verification sentence is conditional.

**Re-enable when:** the table, the sender and the `/auth/verify-email`
route ship together, and a test walks one signup through to a verified
login.

---

## 2. Right-to-be-forgotten fanout — `rtbf_fanout_v1 = False` (unchanged)

Already off; left off, but the reason on record was misleading and has
been corrected.

The stated reason was that the cross-store fanout cannot yet erase from
Typesense / Redis / Qdrant / ClickHouse / S3. True, but it points an
implementer at `rtbf_fanout.py` — the wrong file.

The larger problem is in the **primary Postgres path**,
`services/governance_intel/gdpr.py:60-67`. Of six tables, three name
columns that do not exist, verified against live `information_schema`:

| table | fails on |
|---|---|
| `telemetry_events` | no `org_id`; no `payload_json` / `metadata_json` |
| `judge_scores` | no `org_id`; no `raw_input` / `raw_output` |
| `conversation_messages` | no `user_id` (keyed by `org_id` + `conversation_id`) |

The split falls exactly along the content line. The three that fail are
the three holding actual user content — prompts, completions, tool
calls, reasoning, judge rationales, chat message bodies. The three that
work hold a feedback comment, session counters and a conversation title.

It fails **silently**: `gdpr.py:222` catches and returns 0, so the
response reports `rows_matched: 0` and an overall success envelope.

**Do not enable** until the Postgres path is fixed. Enabling it as-is
issues an erasure certificate for data that was never erased.

Note: the two callers that bypass the route are both dead —
`rtbf_tracker.py:153` has no production callers, and
`promotion_hooks.py:678` calls `process_request` without its required
`org_id` and raises into a swallowed `except`.

---

## 3. `eden-worker` Northflank job — `EDEN_RUN_BACKGROUND_WORKERS=0`, now actually enforced

The variable was already set to `0`, but **nothing read it** —
`workers/main.py` mentioned it only in a docstring. The job started the
full fleet whenever it ran, and `runOnSourceChange: cd-promote` runs it
on **every deploy**.

Leader locks and the sidecar guard made that safe rather than correct:
the duplicate process still opened its own 15-connection Postgres pool
against a Neon instance billed for staying awake, still ran the anomaly
and evolution loops (which are *not* leader-gated), and still spent
Upstash commands contending for locks it could never win.

`workers/main.main()` now honours the flag and exits immediately when it
is off. `--once` is exempt (local dev / tests). Absent or empty means
enabled, so existing deployments are unchanged.

The job is kept as a break-glass host: set the variable to `1` and
trigger a run if the API service is ever unable to carry the fleet.

---

## Deliberately NOT disabled

**Background workers on `eden-api`.** Turning them off would take Neon
to ~2-5 compute-hours/month, but it also stops webhook delivery, EQL
alerts, the quality pipeline and the closed loop. Not a launch-day
trade.

**Neon scale-to-zero tuning.** The measured levers below would take Neon
from ~220 to ~20 compute-hours/month and put the Free tier in reach,
worth about **$19/month**:

| lever | now | proposed |
|---|---|---|
| `redis_leader_tick_seconds` | 120 | 600 |
| `idle_poll_period_seconds` | 600 | 3600 |
| PG-lease renewal cadence | raw sub-TTL interval | `next_grid_delay()` |

They are **not applied**, on purpose. Scale-to-zero means the first
request after an idle period pays a cold start, and during live demos a
warm database is worth more than $19/month. Revisit once the demo period
is over.

What *was* applied is the piece with no demo risk:
`self_obs_probe_interval_seconds` 600 → 3600. Self-observability was
**95.2% of all database writes** at zero users (19,576 of 20,553
inserts; everything else combined was 977 rows). That is now ~1,387
rows/day instead of ~8,321, at the cost of a degraded component paging
up to an hour later — which at launch scale you would notice from the
portal first anyway.
