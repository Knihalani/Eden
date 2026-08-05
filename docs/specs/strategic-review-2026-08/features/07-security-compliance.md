# Feature Area 07: Security & Compliance (deep pass 4 — 2026-08-05)

## Verdict: SHARPEN, DON'T SOFTEN — and the surface area is bigger than pass 3 knew. Pass 2 found SSO was pointed at a nonexistent table until 2026-08-02 and GDPR erasure was "Postgres-only, not fanned out." Both are still true but incomplete. Pass 3, reading the actual route bodies and the actual store-client code: (1) SSO's *database layer* fix is real and test-locked, but the *login flow* — the thing "SSO" means to a buyer — unconditionally 503s on every callback, by explicit tested design, and nothing in the portal even calls it; (2) the live, user-facing "delete my data" endpoint is narrower than "Postgres-only" implied — it touches exactly two tables (`users`, `org_members`), not the customer's actual content — while a separate, well-engineered six-table-plus-fanout implementation exists in code and is simply never called by it. Pass 4 adds two findings that don't change that severity call so much as generalize it: a third, still narrower, still UI-disconnected deletion route (`DELETE /users/me`), and two entire security-domain subsystems this doc previously missed altogether — a fully built, SSRF-hardened, tested red-team probe suite (§6) and an agent-scoped, hash-chain-attested compliance pack generator that's *enabled by default* (§7) — both with real backends and zero portal wiring. The through-line across all of it, detailed in §8: Eden's security/compliance engineering is consistently ahead of its product surface. This is a genuine, unconditional GDPR Art. 17 exposure today, independent of any audit or marketing claim, mitigated only by low current user count — not a compliance-marketing risk to be reworded away.

---

## 1. SSO — current state, verified end-to-end (pass 3, supersedes pass-2 summary)

**The 2026-08-02 fix repointed the database layer to live tables — verified, test-locked, real. It did not implement the login flow, which remains completely non-functional by explicit design, and the portal never calls the routes that would exercise it.**

### 1a. What was fixed, and how it's proven

`src/eden/api/routes/sso.py` (all 11 handlers) now reads/writes `org_sso_settings` × `sso_configurations` (+ `org_scim_config` for SCIM), not the nonexistent `org_sso_providers`. Two tests lock this in:

- `tests/unit/api/test_sso_live_schema.py::test_sso_py_has_no_org_sso_providers_reference` — parses `sso.py` with `ast` and asserts the dead table name appears nowhere, including inside string constants. This is a source-level regression lock, not just a runtime check — it would fail the build if anyone reintroduced the old table name even in a comment-adjacent string.
- `tests/unit/api/test_sso_live_schema.py::test_sso_provider_create_list_round_trip_uses_live_tables` — drives a full `POST /sso/providers` → `GET /sso/providers` cycle through a fake Postgres connection that records every SQL statement, and asserts `sso_configurations` / `org_sso_settings` appear while `org_sso_providers` does not.

Same commit (`49334952`, 2026-08-02) also fixed SCIM: token generate/revoke now upsert `org_scim_config`, which is the table `scim.py:157` actually reads — previously the token was written to a table nothing read from, so SCIM was permanently unconfigurable independent of the SSO bug.

CSRF is real and independently tested: `initiate_sso_login` mints a state nonce, persists it in Redis (`_persist_sso_state`, TTL 600s) *before* redirecting, and fails closed with a 503 if Redis is unreachable (`sso.py:581-588`) — "better to refuse the login than mint a nonce nobody can check." `sso_callback` validates and single-use-consumes the nonce (`_consume_sso_state`, `sso.py:513-536`). `tests/intelligence/test_sso_state_csrf.py` covers: correct TTL/key persistence, fail-closed on Redis-down, 400 on missing/unknown/wrong-provider state, and replay rejection after single use.

### 1b. What is still not there: no login can complete, by tested design

`POST /sso/callback/{provider_id}` (`sso.py:652-683`) validates the CSRF state, then **unconditionally raises `HTTPException(503, {"status": "sso_not_enabled", ...})`** — for every call, valid state or not:

```python
_ = code, saml_response
await _consume_sso_state(state or "", provider_id, org_id)
raise HTTPException(status_code=503, detail={"status": "sso_not_enabled", ...})
```

The docstring names the reason: "IdP token exchange (SAML assertion validation / OIDC code exchange) is not wired up in this deployment — doing so needs per-tenant IdP secrets we don't have a safe place to broker yet." `tests/intelligence/test_sso_state_csrf.py::test_callback_consumes_state_and_succeeds` confirms this is *intended, tested* behavior: even a correctly round-tripped state still yields 503 with `detail.status == "sso_not_enabled"`.

So: an org admin can create a provider, enable it, toggle `enforce_sso`, and mint SCIM tokens — all real, all persisted, all correctly writing live tables. But no end user can complete an SSO login through Eden's own `/sso/login` → IdP → `/sso/callback` path. `initiate_sso_login` builds a genuinely valid Okta/Google/OIDC authorize URL and sends the browser to the real IdP; the IdP authenticates the user and redirects back with a real code/assertion; Eden then discards it and 503s. Every attempt fails at the last step, *after* the user has already authenticated with their identity provider — arguably a worse failure mode for a buyer's IT team to witness than a clean "not available" message up front, since it looks like Eden's system broke mid-flow rather than declined to offer the feature.

### 1c. Two findings not in pass 2

1. **`enforce_sso` is inert, not a lockout risk.** `grep -rn "enforce_sso" src/` shows it is written by `POST /sso/providers/{id}/enforce` (`sso.py:379-405`) and read back only by `list_sso_providers`'s own response — nothing in `src/eden/api/routes/auth.py` (the password-login path) ever checks it. The docstring's claim that it "blocks password login for org members" is currently false. Net effect: an admin can't accidentally lock their org out by flipping the toggle (a small mercy), but the enforcement feature does literally nothing today — flipping it in the portal changes no login behavior for anyone.
2. **The portal never calls the broken half, and a second SSO story exists.** `docs/docs/how-to/sso.md` documents SSO as configured entirely via the Clerk dashboard ("Eden inherits the identity provider you connect there") — a mechanism separate from the `sso.py` OIDC/SAML flow. Consistent with that, `clients/portal/src/lib/api/resources.ts` wires only the admin-config functions (`listSSOProviders`, `createSSOProvider`, `enableSSOProvider`/`disableSSOProvider`, `enforceSSO`, `generateSCIMToken`/`revokeSCIMToken`) — grepped and confirmed it never calls `/sso/login/{provider_id}` or `/sso/callback/{provider_id}`. So the portal's SSO tab configures a login path the product never drives traffic through. Either Clerk is the real, working mechanism (in which case the portal lets admins configure a parallel dead code path with no warning that it's inert), or `sso.py` is meant to become authoritative later (in which case it can't complete a single login today regardless of what's configured through it). Either reading is a gap worth surfacing before this gets described to a buyer as "SSO support."

**Net:** "fixed 2 days before the last review" was accurate for the database layer and remains test-locked true. It was never a fix for the end-to-end login flow, which is non-functional by explicit design — materially different from, and worse than, an unqualified "SSO is fixed." The portal pricing page (`pricing/page.tsx:73`) lists "SSO / SCIM" as an Enterprise-tier feature against this backend; that claim cannot currently be honored for any org that isn't authenticating entirely outside Eden's own SSO routes (e.g., via Clerk directly).

---

## 2. GDPR erasure — the fanout gap, read at the code level (pass 3, supersedes pass-2 summary)

**Sharper than "Postgres-only." There are two non-communicating erasure implementations. The one that's live and user-facing today is narrower than "Postgres" broadly — it's two tables. The one that's broad and fanned-out is well-engineered and exists in code, gated off by a feature flag the self-service endpoint doesn't even check.**

### 2a. The live, user-facing path: `DELETE /api/v1/me`

`compliance.py:118-140` → `background_tasks.add_task(jobs.run_user_delete_job, ...)` → `src/eden/services/compliance_jobs.py:239-262`:

```python
await client.execute("DELETE FROM org_members WHERE user_id = $1", user_id)
await client.execute("""
    UPDATE users SET
        deleted_at = NOW(),
        email = CONCAT('deleted+', id, '@eden.invalid'),
        name = 'Deleted User',
        token_version = COALESCE(token_version, 0) + 1,
        password_hash = NULL
    WHERE id = $1 AND deleted_at IS NULL
""", user_id)
```

That's the whole operation: `org_members` (row deleted) and `users` (row anonymized). It does not touch `telemetry_events`, `conversation_messages`, `judge_scores`, `user_feedback`, `user_sessions`, or `conversations` — i.e. it doesn't cover "Postgres" broadly, only the account/membership rows. A user's actual trace content, conversation transcripts, feedback comments, and judge rationale text — all potentially containing their PII/free text — survive this call untouched, indefinitely, in the same database. The paired export (`_collect_user_export`, `compliance_jobs.py:154-160`) is symmetrically narrow: it selects `id, email, name, clerk_id, created_at, deleted_at` from `users` only, nothing else. Both self-service flows are much smaller in scope than a subject's actual data footprint.

Calling this "what a real user hits clicking 'delete my account' today" overstates it, though: no such button exists. A full grep of `clients/portal/src` for account-deletion UI turns up nothing but a static CCPA "Do Not Sell" marketing page — unrelated to actual erasure. `DELETE /api/v1/me` has zero portal callers (`resources.ts`/`portal.ts` grepped for `api/v1/me` — no hits). There is in fact a **third** deletion route, narrower still and previously undocumented: `DELETE /users/me` (`auth.py:2039`), which sets `deleted_at` and rotates `token_version` only — it doesn't touch `org_members`, doesn't anonymize email/name, and never nulls `password_hash`. This is the one the portal actually has a client function for — `resources.ts:455`'s `deleteAccount()` calls exactly this route — but that function has **zero component callers** anywhere in the portal (grepped `clients/portal/src/app`, `src/lab`, `src/components` for `deleteAccount`; the only match is the definition itself). So there are three non-communicating deletion implementations, of three different completenesses, and none is wired to a UI element. A real DSAR today means a support engineer hand-calling one of three inconsistent endpoints from a terminal — not "self-serve, but narrow." It isn't self-serve at all.

### 2b. The broad, fanned-out path exists — and is dark, disconnected from 2a

A second, considerably more complete implementation lives at `src/eden/services/governance_intel/gdpr.py` (`RightToBeForgottenService.process_request`, fixed the same day as SSO, 2026-08-02), reachable only via `POST /governance/rtbf` (`intelligence_governance.py:365-406`), gated by `Depends(require_feature_flag("rtbf_fanout_v1"))`. The flag defaults `False` (`config.py:1252`), and — critically — **nothing in `compliance.py`'s self-service delete-me path calls it.** The two implementations don't talk to each other. A user who clicks self-service delete, or files a DSAR ticket (`submit_dsar` just writes a `dsar_tickets` row for manual handling), never triggers the more complete implementation at all.

When it does run, the Postgres layer is genuinely solid engineering:
- anonymizes six live tables (`_RTBF_TABLES`, `gdpr.py:75-82`), deriving `trace_id`/`conversation_id` scope *before* any writes so anonymizing one table doesn't destroy the keys needed to scope the next (`gdpr.py:200-223`);
- scrubs `telemetry_events` content columns (`payload`, `request_body`, `response_body`, `reasoning`, `tool_calls_full`, `tool_results`) to `"***"` and nulls their zstd shadow copies plus media blobs (`gdpr.py:109-121`);
- fails closed: a SQL error on any table returns an `error` envelope naming the failed table(s), never a silent `rows_matched: 0` success (`gdpr.py:336-344`).

Then it calls the cross-store fanout (`rtbf_fanout.py::fanout_rtbf`) across Typesense, Redis, Qdrant, S3, ClickHouse, and the internal blob store — where the failure modes differ by store in ways that matter for severity:

| Store | Fanout attempt | What actually happens today | Evidence |
|---|---|---|---|
| **Typesense** | `delete_by_filter("tenant_id:={org} && user_id:={user}")` | **Falsely reports `status: "ok"`.** `SPAN_SCHEMA` (`typesense_client.py:67-97`) lists 21 fields — no `user_id`, and `build_span_doc` never sets one. The filter targets a field that doesn't exist in the schema; the call doesn't raise, so it reports success with `deleted: 0`. The indexed `input_text`/`output_text` — actual prompt/completion content — is never touched and stays fully searchable. | `typesense_client.py:588-591` vs. schema `:67-97` |
| **Redis** | `SCAN eden:*:{org}:*:{user}*`, then `DEL` | **Falsely reports `status: "ok"`.** No key pattern anywhere in `src/eden/` embeds a user id (`eden:cost:{org}:...`, `eden:dedup:{digest}`, `eden:maint:{key}`, etc. are org- or hash-keyed only). SCAN matches nothing, `deleted: 0`, reported `"ok"`. Lower actual PII risk here (mostly cost/dedup caches) but still a false-positive report. | `rtbf_fanout.py:77-108`; grepped key patterns across `src/eden/` |
| **Qdrant** | `client.delete_by_user(...)` if present | **Honestly reports `status: "failed"`.** `QdrantClientWrapper` (`storage/qdrant.py`) has no `delete_by_user` method at all. At least this one doesn't lie — vector embeddings persist and the gap is visible. | `rtbf_fanout.py:111-147`; full method list in `storage/qdrant.py` |
| **S3** | N/A | **Explicitly `status: "unsupported"`**, self-documented: "There is no per-user object index for the S3/Impossible Cloud archive, so scoped erasure is genuinely unimplemented." The docstring records the bug this replaced: the handler used to call the tenant-wide `delete_tenant_data` (formerly misnamed `delete_user_data`), silently discarding `user_id` and deleting an *entire org's* data — including billing (`usage_events`) — while reporting success. The fix was to remove the destructive action, not scope it. | `rtbf_fanout.py:150-181` |
| **ClickHouse** | `sink.delete_tenant_rows(org_id)` | Tenant-scoped, not user-scoped — `telemetry_events_ch` has no `user_id` column, and the code says so. A single user's RTBF, if this ran, would purge the **entire org's** analytics — over-broad in the opposite direction from under-erasure. | `rtbf_fanout.py:184-250` |
| **Blob store** | `store_obj.release_org(org_id)` | Org-level refcount decrement, not user-scoped — a blob shared with other org members' spans won't be released, and there's no per-user attribution of which blobs are whose. | `rtbf_fanout.py:253-276` |

`docs/ops/disabled-features.md` §2 corroborates this independently, in the team's own words — the flag "stays OFF" because "secondary-store erasure must be proven real," which matches exactly what the client code shows. `tests/unit/platform/test_w9_platform.py::test_rtbf_fanout_unavailable_visible` and `tests/security/test_rtbf_user_scope.py` pin "never silently do tenant-wide deletion for a per-user request" as an invariant — good, honest engineering. But it doesn't change what a customer experiences: **even fully enabled, 2 of 6 non-Postgres stores (Typesense, Redis) would falsely report success while erasing nothing relevant, 1 (Qdrant) fails outright, 1 (S3) is admittedly unimplemented, and 2 (ClickHouse, blob store) operate at tenant granularity, not user granularity.** And it isn't enabled — the flag is off, and the live self-service endpoint doesn't reach any of this machinery regardless of the flag.

### 2c. What a real "delete my data" request leaves behind today, concretely

Filing `DELETE /api/v1/me` — the only one of three deletion routes that meaningfully anonymizes the account, and still reachable only by someone with direct API access, since no UI calls it — leaves, indefinitely and in full:

- **Postgres**: every `telemetry_events` row (full request/response bodies, tool calls, reasoning, image/audio references), every `conversation_messages.content`, `judge_scores.rationale`, `user_feedback.comment`, and `user_sessions` row tied to the user — none of the six tables `gdpr.py` knows how to scrub are touched by the live delete path.
- **Typesense**: full `input_text`/`output_text` span content, searchable, with no code path that can currently remove it per-user even if the dark feature were enabled (schema has no `user_id`).
- **Qdrant**: vector embeddings derived from the user's content.
- **S3**: cold-archived trace/media blobs — self-admitted as unaddressable per-user.
- **ClickHouse**: aggregated analytics rows tied to identifiable trace IDs (lower PII density, not zero).
- **Redis**: low residual risk specifically (no user-keyed caches exist today) — but incidental, not by design.

Only `users` and `org_members` rows are actually touched.

---

## 3. Web research — SOC2/audit reality for polyglot-store erasure (new, pass 3; unverified-external-claim, not re-checked in pass 4)

**SOC2 Type II.** Type II tests operating effectiveness over a period, not design intent — auditors sample *actual deletion events* and expect corroborating logs from each relevant system (primary DB, backups, logs, caches, third-party processors), not a policy document alone. Guidance repeatedly names "automate deletion across every data store" and "retain sub-processor disposal attestations" as the concrete bar: an auditor asking "show me the Typesense/Qdrant deletion evidence for this sampled erasure request" is a standard question, and "we don't have that" is the finding it's designed to surface. Eden currently makes no SOC2 claims anywhere in the portal marketing (grepped, zero hits) — so no live audit is at risk today — but this is exactly the gap a first Type II audit, or any serious enterprise security questionnaire gating a mid-five-figure-plus ACV deal, would surface immediately, against a live delete-me path that's even narrower than pass 2 assumed.

**GDPR enforcement specifically — not hypothetical, not Eden-specific.** The EDPB published findings from its 2025 Coordinated Enforcement Framework action on Article 17 (right to erasure) in February 2026, examining recurring database-layer failures across organizations broadly: the complexity of executing erasure across relational schemas, backup retention silently undoing compliant deletions, and audit-log retention conflicting with erasure obligations. Independent guidance names the exact failure modes present in Eden's code as *recognized, common* weak points, not edge cases: "incomplete cascading deletion across systems" (an erasure coordinator must track per-subsystem confirmation and treat an unconfirmed store as incomplete, not silently succeed — precisely what `rtbf_fanout.py`'s `fanout_incomplete` list is built to do, correctly, when the feature is even on) and "vector/search-index de-indexing" as a specifically named weak point. Remediation guidance converges on: track per-subsystem confirmation, treat unconfirmed as incomplete, and *technically verify* by re-searching for the erased data rather than trusting a delete call's return code. Eden's dark `rtbf_fanout.py` implements this pattern correctly for Qdrant and S3 (fails/flags honestly); it fails the "technically verify" step for exactly Typesense and Redis — the two stores that would report success on a re-search that should return zero results and currently wouldn't.

**Verification status:** these regulatory/audit-practice claims (EDPB Coordinated Enforcement Framework findings, SOC2 Type II evidence-sampling practice) are search-engine-sourced with direct citations and have not been independently re-verified against primary regulator/auditor sources in either pass 3 or pass 4 (WebSearch budget was exhausted before re-checking in pass 4). Treat as directionally credible, unverified-external-claim — not to be cited as confirmed fact in a broader rollup without a dedicated verification pass.

Sources:
- [SOC 2 Data Retention Guide: Key Requirements, Steps, and Templates (2026) — Konfirmity](https://www.konfirmity.com/blog/soc-2-data-retention-guide)
- [SOC 2 Evidence Storage Best Practices: A Walkthrough (2026) — Konfirmity](https://www.konfirmity.com/blog/soc-2-evidence-storage-best-practices)
- [SOC 2 Data Security and Retention Requirements — Bytebase](https://www.bytebase.com/blog/soc2-data-security-and-retention-requirements/)
- [Does SOC 2 demand deletion of your old data? — OpusGuard](https://www.opusguard.com/post/does-soc-2-mandate-data-retention-demand-deletion-of-your-old-data)
- [It's 2026. Why are databases still failing GDPR compliance audits? — Redgate Simple Talk](https://www.red-gate.com/simple-talk/databases/its-2026-why-are-databases-still-failing-gdpr-compliance-audits/)
- [GDPR Right to Erasure Low-Level Design: Anonymization, Legal Holds, and Audit Trail — techinterview](https://www.techinterview.org/post/3233468502/lld-gdpr-deletion/)
- [GDPR Article 17: Data Erasure (Right to be Forgotten) Requests — WatchDog Security](https://watchdogsecurity.io/gdpr/data-erasure-request-handling)

---

## 4. Sharpened severity call (pass 3)

**Genuine regulatory exposure, not compliance-marketing risk — and a notch worse than pass 2's framing, because the live self-service path is narrower than "Postgres-only" implied.**

1. **GDPR Article 17 doesn't care whether you market compliance.** The obligation to actually erase personal data on request applies to any org processing EU personal data, regardless of whether Eden claims SOC2 or GDPR-readiness anywhere. If a real EU data subject files a `delete-me` request today, the response is success while their conversation content, trace payloads, and feedback text remain live in Postgres and fully searchable in Typesense. That's a false representation of erasure made directly to the data subject, independent of any audit — closer to "we told a regulator-covered user their data was erased when it wasn't" than to "our compliance page oversells a feature."
2. **The team already built the right fix — it's just not wired up.** `gdpr.py`/`rtbf_fanout.py` are competent, tested, fail-closed engineering dated the same day as the SSO fix (2026-08-02). This isn't "nobody thought about it" — the thorough implementation sits behind a disabled flag and an unrelated endpoint while the endpoint real users hit still runs the old two-table version. A wiring/prioritization gap is more fixable than a design gap, but it reads worse under a security review: "we built the right thing and didn't ship it" is a harder conversation than "we hadn't gotten to it."
3. **Current exposure is small — which buys time, not compliance.** Per `docs/ops/disabled-features.md`'s "Deliberately NOT disabled" section, the org is pre-launch/early (self-observability was ~95% of all DB writes at zero users). The number of real DSARs filed against this gap today is plausibly zero. That's the mitigating fact for urgency, not a defense of the underlying state: the non-compliance is unconditional; only the probability of it being tested today is low.
4. **This will fail the first serious review, specifically and predictably.** Both the SOC2 evidence-sampling model ("show me the Typesense deletion log for this erasure event") and a standard enterprise vendor security questionnaire ("describe erasure fanout across your data stores; provide evidence") hit this exact gap, and today's honest answer is "we have a feature that does that, it's off, and two of its five secondary-store integrations don't actually work if turned on." That's an engineering backlog item with a known shape — two of six integrations already correct (Qdrant, S3), two concrete bugs to close (Typesense schema, Redis key pattern) before the flag can honestly flip on — not a copy-editing fix.

**Recommended framing for the strategic review:** treat this as a regulatory/audit-readiness item currently masked by low usage, not a compliance-copy cleanup. Scoped fix: consolidate the three deletion routes (`/api/v1/me`, `/users/me`, `RightToBeForgottenService`) into one, wire it to `RightToBeForgottenService` end to end, and wire *that* to an actual UI element; add `user_id` to the Typesense span schema and reindex, or explicitly document Typesense as a bounded-residual-window exception; fix or drop the dead Redis key pattern; leave Qdrant/S3/ClickHouse as documented partial scope until they're real. Do not describe current erasure as "GDPR-compliant" externally until the live path covers more than `users`/`org_members` and is actually reachable by a real user.

---

## 5. Everything below is carried forward unchanged from pass 2 (not re-verified this pass — see §1/§2/§4 above for what *was* re-verified)

### 5a. What exists in eden

- **SCIM 2.0**: `src/eden/api/routes/scim.py` (1294 lines) — Users CRUD + PATCH-op semantics, `ServiceProviderConfig`/discovery endpoints, Clerk IdP sync. Mounted at `/orgs/{org_id}/scim/v2`. Tested: `tests/unit/test_scim_patch.py`, `tests/api/test_scim_clerk_sync.py`, `tests/unit/api/test_scim_path_org_uuid_jul19.py`.
- **RBAC (custom roles + permission catalogue)**: `src/eden/api/routes/rbac.py` (715 lines) — role CRUD, permission catalogue, direct user↔permission assignment, gated by `_require_rbac_admin` (`rbac.py:156`). Mounted at `/orgs/{org_id}/roles` and `/orgs/{org_id}/permissions`. Tested across 4 files. No disabled-features.md entry — unlike SSO, nothing suggests this path was ever broken.
- **PII redaction/policy**: ingestion-time, not gateway-only — `src/eden/observability/ingestion/pii.py`, `pii_policy.py`, `src/eden/data_platform/pii.py`, `pii_intl.py`, `src/eden/api/routes/pii_policy.py`, plus `src/eden/llmops/filters/pii.py` for gateway-path filtering too. 35 files under `tests/` match `*pii*`.
- **Audit log**: `src/eden/api/routes/audit.py` (238 lines) — event query, streaming export, `verify_audit_chain` (hash-chain tamper detection). Tested. **This is the one area with real, live-wired portal UI.**
- **Row-level tenant isolation**: `src/eden/db_migrations/versions/015_regions_and_rls.py` — Postgres RLS policies on observability tables keyed on `current_setting('app.current_org_id', true)`, set via `SET LOCAL` by request middleware. Defense-in-depth multi-tenancy independent of the RBAC/SSO gap.
- **SOC2/HIPAA/GDPR/ISO27001 evidence packs**: `src/eden/services/governance_intel/compliance.py` (811 lines) — `ComplianceEvidenceGenerator`, exposed via `intelligence_governance.py:262`/`:283`. Tests confirm 50+ SOC2 controls, 18 HIPAA safeguards, 10 GDPR controls, 14 ISO27001 families are generated.
- **Agent-scoped compliance packs with tamper-evidence**: `src/eden/governance/compliance_pack.py` (244 lines) + `src/eden/api/routes/compliance_pack.py` (97 lines, mounted at `/orgs/{org_id}/compliance` in `app.py`). `AgentAuditLedgerWriter` maintains an append-only, SHA-256 hash-chained `agent_audit_ledger` table (migration `092_market_ready_consolidated.py`); `verify_chain()` recomputes the chain and reports `ok_rows`/`broken_rows` — real tamper-evidence, unit-tested for empty, valid, and deliberately-tampered chains (`tests/unit/ws4/test_enterprise_ws4.py:70-124`). `CompliancePackGenerator.generate_agent_pack` combines this with `ComplianceEvidenceGenerator` to produce a per-agent pack: base framework evidence plus agent-specific audit events plus a chain-verification attestation. Gated by `compliance_pack_export_v1`, which **defaults `True`** (`config.py:1451` — the opposite posture from `rtbf_fanout_v1`'s off-by-default). Despite being live by default, it has zero portal consumers (grepped `resources.ts`/`portal.ts` for the route paths and flag name — no hits) and zero API-route-level or end-to-end tests — only the underlying `verify_chain()` unit tests exist; nothing exercises `generate_agent_pack` or the FastAPI routes themselves. Full detail in §7.
- **Red-team probe suite**: `src/eden/redteam/probes.py` (699 lines) + `findings_store.py` (125 lines) — 12 named, tested adversarial probes (jailbreak / prompt-injection / PII-leak / excessive-agency), a `ProbeRunner`, SSRF-hardened target-endpoint validation (HTTPS-only, rejects private/loopback/link-local/reserved IPs, re-validates at call time against DNS rebinding, optional allowlist via `EDEN_REDTEAM_ENDPOINT_ALLOWLIST` — `api/routes/redteam.py:127-206`), four mounted routes at `/orgs/{org_id}/redteam/{probes,probe,scan,findings}` (`app.py:241`), a dedicated `redteam_findings` table with its own migration (`093_redteam_findings_org_scope.py`), and two test files (`tests/unit/test_redteam_probes.py` 395 lines, `tests/unit/api/test_redteam_target_endpoint.py` 83 lines). Full detail in §6.
- **Data residency**: `organizations.region` column exists (migration 015) but its own docstring says routing is a separate unbuilt project — unused, storage-only metadata, no enforcement.

### 5b. Portal admin UI gap

`clients/portal/src/lab/settings/settings-chrome.tsx` exposes only four modes (`workspace`/`keys`/`members`/`audit`); legacy `scim`/`pii` tab params alias to `workspace` with no dedicated screen. No `settings/roles`, `settings/sso`, `settings/scim`, or `settings/pii` sub-routes exist. Every SSO/RBAC/SCIM/PII-policy function in `resources.ts` has zero external consumers except `listSSOProviders`, called once by a health-check hook (`use-integration-status.ts`) that itself has zero consumers anywhere in the portal's rendered tree. A stale code comment at `resources.ts:1531-1534` describes a planned `/settings/roles` page that was never built — direct internal evidence the gap was known and deprioritized, not merely inferred from absence. The one genuinely live, wired area is Audit (`settings/page.tsx:143-168`, hitting `GET /orgs/{orgId}/audit/events` and `/audit/packs`) — but tracing that "packs" call (`GET /orgs/{orgId}/portal/audit/packs` → `src/eden/api/routes/portal.py:2692`) shows it calls `AgentAuditLedgerWriter().query()` directly, not the `ComplianceEvidenceGenerator`. So the one compliance-adjacent screen a user can actually load in the product today shows a raw hash-chained audit-event ledger — not a framework-mapped SOC2/HIPAA/GDPR/ISO27001 evidence pack. Neither the 811-line evidence generator (§5a) nor the newer agent-scoped `compliance_pack.py` (§5a, §6) has any portal surface at all, live-by-default flag notwithstanding.

### 5c. Industry table stakes, 2026 (LangSmith / Braintrust / Datadog / Lemma)

| Capability | LangSmith | Braintrust | Datadog (LLM Obs) | Lemma (seed-stage) |
|---|---|---|---|---|
| SOC 2 | Type II, certified | Type II + HIPAA + GDPR | Type II + ISO 27001 | Type II, homepage badge |
| SSO/SAML | Self-service SAML (cloud) + OIDC (self-host), Okta OIN/SCIM | Okta/Entra/Google SAML + OIDC | Platform-wide account feature | Not documented |
| RBAC | Self-service, full admin UI, custom roles, anti-privilege-escalation | Org/project/object-level | Data Access Control by team/role | Not documented |
| PII/secrets redaction | Gateway redaction (disclosed gap: doesn't cover responses/streaming/bypass traces) | Global masking pre-log | Sensitive Data Scanner + SDK redaction | Isolation/encryption framing, not content redaction |
| Data residency | Flagged as unmet by gateway redaction alone | VPC peering, air-gap self-host | HIPAA BAA available | Not documented |

LangSmith is UI-complete as well as backend-complete on SSO/RBAC — eden is behind LangSmith on both fronts, not just UI, and ahead only on ingestion-path PII coverage breadth versus Braintrust/Datadog/Lemma.

### 5d. Procurement-blocker framing

No internal sales/procurement evidence (deal notes, lost-deal writeups) exists in-repo tying this to a specific blocked deal — the "P0" ranking is a reasoned inference from category-uniform competitor behavior plus eden's own deprioritized `/settings/roles` comment, not a documented fact. Better framed as "adds friction and signals immaturity to a self-serve security reviewer" than "proven deal-killer," since eden's backend can be configured manually by sales/SE during a pilot.

### 5e. Gap-ranked recommendation

1. P0 — Ship an SSO/SAML self-service admin screen, and be honest that both the config layer (since 2026-08-02) and the login flow itself (not yet functional per §1 above) are recent/incomplete respectively.
2. P1 — Ship an RBAC role/permission management screen (backend never flagged as broken, lower build risk than SSO).
3. P1 — Ship a PII policy configuration screen (eden's strongest technical story, currently invisible to buyers).
4. P2 — Market the compliance evidence-pack generator(s) by wiring at least one — the 811-line `ComplianceEvidenceGenerator` or the newer agent-scoped `compliance_pack.py` (§6) — into the product, rather than leaving the one live "Audit → packs" screen pointed at a raw ledger query.
5. **P0/P1 (upgraded again this pass) — Consolidate to one erasure path.** Retire two of the three `DELETE` account/erasure routes (`/api/v1/me`, `/users/me`, and the dark `RightToBeForgottenService`) or make the narrow ones call the broad one; wire the survivor to a real "Delete my data" UI element; fix the two silently-false secondary-store integrations (Typesense schema, Redis key pattern) before any external "GDPR-compliant erasure" claim. See §4 — this is no longer just "unverified fanout," it's an active gap in the only paths real users (via a support engineer) can invoke, and none of the three is reachable through the product UI at all today.
6. **P0/P1 (new this pass, cheapest fix in this doc) — Ship a minimal red-team UI** (list probes, run a scan, view findings) against the already-complete, already-tested `redteam/probes.py` API. No backend work required; a `redteam` tab already exists in the URL grammar under Guardrails and is currently aliased away to `policies` with no user-facing explanation. See §6.
7. P3 — Data residency / regional hosting: metadata column exists, no enforcement, no self-hosted/air-gapped story. Lowest urgency absent a specific deal requirement.

### 5f. Confidence / caveats

Pass-2 material in §5 was not re-verified this pass (line numbers/counts may drift) — treat §1/§2/§4 above as the current source of truth for SSO and GDPR RTBF specifically; treat §5 as background context carried forward. No internal sales/procurement evidence exists in-repo for the "top blocker" claim. Web research in §3 is search-engine-sourced with direct citations, not independently re-verified in pass 3 or pass 4 — treat as unverified-external-claim. §6 (red-team) and §7 (compliance packs) and the third deletion route in §2/§4 are new in pass 4 and were verified by direct source read against HEAD `6f2a09d3`.

---

## 6. Red-team probing — a fully built subsystem this doc previously missed entirely (new, pass 4)

`src/eden/redteam/probes.py` (699 lines) is a real, tested, API-live adversarial red-team subsystem, squarely in this doc's domain, that no prior pass covered — despite `KNOWN-SUBSYSTEMS.md` explicitly flagging `redteam/probes.py` as "not yet inspected but plausibly relevant."

**What exists:** 12 named probes spanning jailbreak, prompt-injection, PII-leak, and excessive-agency attack families, driven by a `ProbeRunner`. Target-endpoint validation is genuinely careful engineering — HTTPS-only, rejects private/loopback/link-local/reserved IP ranges, and re-validates at call time against DNS rebinding, with an optional allowlist via `EDEN_REDTEAM_ENDPOINT_ALLOWLIST` (`src/eden/api/routes/redteam.py:127-206`) — an SSRF-hardening pattern this doc doesn't see elsewhere in the security surface. Four routes are mounted and live: `GET/POST /orgs/{org_id}/redteam/{probes,probe,scan,findings}` (prefix registered in `app.py`). Findings persist to a dedicated `redteam_findings` table with its own migration (`093_redteam_findings_org_scope.py`). Two test files cover it: `tests/unit/test_redteam_probes.py` (395 lines) and `tests/unit/api/test_redteam_target_endpoint.py` (83 lines, specifically exercising the SSRF-hardening logic).

`01-competitor-matrix.md:410-424,484` already covers this as a competitive differentiator ("Have — new row this pass... closest external analog is Patronus AI's Percival") — but that doc only checks capability existence, not product reachability, which is this doc's job. And reachability is bad, in a specific and telling way: the portal's `/redteam` path is explicitly listed in `STUB_PORTAL_PATH_PREFIXES` (`portal-routes.ts:13`) and gets rewritten to `/unavailable` by middleware (`portal-hub-redirect.ts`) — a hard "page moved" wall, not a partial or in-progress page. `guardrails-url.ts` shows this used to have a home under the Guardrails hub: a legacy `tab=redteam` query param is explicitly normalized away to `policies` (`guardrails-url.ts:3,70,100`), with no user-facing acknowledgment that the tab is gone — evidence a red-team UI surface existed at some point and was removed or aliased away without replacement. `redteamApi` exists in `resources.ts:3724` with three real client methods but, like the other subsystems in this section, zero component consumers. A security engineer at a customer who wants to red-team their own agent today has to read the FastAPI route file to discover the capability exists at all.

This is the strongest "backend built, unreachable in product" case in the entire security/compliance area — and, per §8 below, also the cheapest to fix, since it requires no further backend work.

---

## 7. Compliance packs & the hash-chain audit ledger — a second missed subsystem, live by default (new, pass 4)

`src/eden/governance/compliance_pack.py` (244 lines) + `src/eden/api/routes/compliance_pack.py` (97 lines, mounted at `/orgs/{org_id}/compliance` in `app.py`) is an agent-scoped compliance evidence pack with tamper-evidence, also entirely unmentioned by prior passes despite `governance/` being on `KNOWN-SUBSYSTEMS.md`'s "not yet inspected" list.

**What exists:** `AgentAuditLedgerWriter` maintains an append-only, SHA-256 hash-chained ledger (`agent_audit_ledger` table, migration `092_market_ready_consolidated.py`). Its `verify_chain()` method recomputes the chain and reports `ok_rows`/`broken_rows` — real tamper-evidence, not just an append-only convention, and it's unit-tested for empty, valid, and deliberately-tampered chains (`tests/unit/ws4/test_enterprise_ws4.py:70-124`). `CompliancePackGenerator.generate_agent_pack` combines this ledger with the existing `ComplianceEvidenceGenerator` (§5a) to produce a per-agent pack: base SOC2/HIPAA/GDPR/ISO27001 evidence, agent-specific audit events, and a chain-verification attestation, exposed via three routes (`verify`, `ledger`, `agents/{agent_id}/export`).

Two things make this a sharper finding than the red-team gap, not a milder one:

- **It's on by default.** `compliance_pack_export_v1` defaults `True` (`config.py:1451`) — the opposite posture from `rtbf_fanout_v1`'s off-by-default in §2. This is a live, enabled capability, not a dark one behind a flag.
- **It has zero portal consumers and zero route-level tests.** Grepped `resources.ts`/`portal.ts` for the route paths and the flag name — no hits. Only the underlying `verify_chain()` unit tests exist; nothing tests `generate_agent_pack` or the FastAPI routes themselves end to end. So this is a capability that is fully enabled in production configuration and completely undiscoverable — from both the buyer's side (no UI) and, to a lesser extent, the team's own regression-safety side (no route-level tests to catch a break).

This also sharpens the §5b correction above: the portal's one live "Audit → packs" screen reads `AgentAuditLedgerWriter().query()` directly, not through `CompliancePackGenerator` or `ComplianceEvidenceGenerator` — so the raw ledger data this section describes is, in fact, the same data source backing that screen, just accessed through a narrower, non-attested path than `compliance_pack.py` offers.

---

## 8. User Experience & Value

### Who is the user

Four distinct personas hit this feature area, and this doc has, through pass 3, mostly written for the last of them implicitly. Naming them explicitly matters because their journeys are almost entirely disconnected from each other today, and from the product:

1. **The data subject** — an end user of one of Eden's customers who wants their data deleted (GDPR Art. 17 / CCPA), or their org's **DPO/support engineer** acting on their behalf via a DSAR ticket.
2. **The compliance officer / security lead at a prospective enterprise customer** — running a vendor security questionnaire or gating a deal on "show me your SOC2 evidence for this control."
3. **A SOC2 Type II auditor** sampling actual deletion/audit events, not reading a policy document.
4. **A security/AppSec engineer at Eden's customer** who wants to red-team their own agent (jailbreak/injection/PII-leak resistance) before shipping it, or as part of the same vendor security review.

### What the flow looks like today, concretely

**1. Data subject erasure.** There is no "Delete my account" or "Delete my data" button anywhere in the portal — confirmed by a full search of `clients/portal/src`; the only UI hit for "delete...account" is a static CCPA "Do Not Sell" marketing page, unrelated to actual erasure. Three non-communicating deletion code paths exist (§2a, §4), none wired to a UI element: `DELETE /api/v1/me` (anonymizes `users`, deletes `org_members`, zero portal callers), `DELETE /users/me` (narrower still — sets `deleted_at` and rotates `token_version` only; the portal's `deleteAccount()` client function calls exactly this route, but has zero component callers anywhere in the rendered tree), and `RightToBeForgottenService.process_request` (the broad, well-engineered six-table-plus-fanout version, reachable only via a feature-flagged internal API). A real data-subject request today means a support engineer hand-calling one of three inconsistent endpoints — most likely the narrowest one, since it's the one named for the purpose — with no confirmation of what was actually erased, no per-store report, and no re-verification that indexed content (Typesense) or vectors (Qdrant) are actually gone.

**2. Compliance evidence for a buyer/auditor.** `ComplianceEvidenceGenerator` (811 lines, 50+ SOC2 controls / 18 HIPAA safeguards / 10 GDPR controls / 14 ISO27001 families, tested) is real and reasonably deep. Getting a pack out of it today requires calling `POST /orgs/{org_id}/intelligence/governance/compliance/generate` directly — no portal button exists. The one thing a compliance officer can click "load" on in the product today, the Audit → packs screen, shows a raw hash-chained event ledger (§7), not a framework-mapped evidence report — a materially different, and less useful, artifact than what a SOC2 auditor or security questionnaire is actually asking for.

**3. Red-team probing.** Fully built, tested, and API-live (§6) — and entirely unreachable through the product. `/redteam` is a hard portal stub that redirects to `/unavailable`; a legacy Guardrails-hub tab for it was aliased away with no user-facing explanation. A security engineer wanting to red-team their agent today has to read the FastAPI route file to discover this exists at all.

### Why it matters

A buyer's security team, a SOC2 auditor, and a data subject filing a DSAR do not read `src/eden/services/governance_intel/` or `src/eden/redteam/`. They interact with a product surface, and today that surface says "we don't have this" on all four workflows above — SSO login, GDPR erasure, compliance evidence, red-teaming — even though three of the four have substantial, tested backend implementations, in some respects (the SSRF-hardened probe runner, the hash-chain audit ledger, the 50+-control evidence generator) ahead of what many funded competitors ship. The pattern repeats identically across every workflow in this doc: **build the backend, ship it behind a route nobody calls from the UI.** That's a cheaper problem to fix than "we don't have the capability" — but from the outside, the only vantage point that matters for a deal-gating security review, it's indistinguishable from not having it. In the GDPR case it's actively worse than not having it: it creates a false impression of "self-serve" compliance that isn't real for any actual user.

### What would make this trustworthy and usable

- **One erasure path, not three.** Retire two of the three `DELETE` implementations (or make the narrower ones call the RTBF service instead of duplicating logic), wire a single "Delete my data" flow into account settings, and have it call `RightToBeForgottenService` end to end. Fix the Typesense/Redis false-success bugs before flipping `rtbf_fanout_v1` on.
- **Report honestly, per store, every time.** `rtbf_fanout.py`'s existing pattern for Qdrant/S3 — explicit `status: "failed"` / `"unsupported"` rather than silent success — is exactly right and should be the UI contract too: a user or auditor should see "Postgres: erased. Qdrant: failed (no per-user index). Typesense: not yet supported," not a single green checkmark.
- **Technically verify, don't just trust the delete call.** The GDPR web research cited in §3 converges on re-querying stores post-deletion as the credible bar; that's a natural extension of the fail-closed pattern already in `gdpr.py`, and the kind of evidence a SOC2 Type II auditor samples for directly.
- **Surface the hash-chain ledger as a trust primitive, not a hidden detail.** `AgentAuditLedgerWriter.verify_chain` (tamper-evidence via recomputed SHA-256 chain, tested in `tests/unit/ws4/test_enterprise_ws4.py`) is a genuinely strong, already-built answer to "how do we know this evidence wasn't edited after the fact" — exactly the question a SOC2 auditor or enterprise security reviewer asks. Today it's invisible; surfacing "chain verified: ✓" next to any exported compliance pack turns existing plumbing into a concrete trust signal.
- **Ship the cheapest UI win in this entire doc first.** The red-team probe suite is fully built, tested, and API-complete — a list-probes + run-scan + view-findings screen under the existing Guardrails hub (where a `redteam` tab already existed in the URL grammar before being aliased away) is close to pure frontend work against an API that needs no further backend changes, unlike SSO (login flow still doesn't work) or GDPR (two integrations still need fixing before the flag is honest).
