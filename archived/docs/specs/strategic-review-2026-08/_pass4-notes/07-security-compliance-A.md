# Pass 4 notes — `features/07-security-compliance.md` (sole reviewer: A)

Scope: re-verify every non-trivial claim in the pass-3 doc against current source
(HEAD `6f2a09d3`, working tree otherwise clean for this subsystem — the only
uncommitted changes in `git status` are unrelated SDK/workflow deletions), check
`compliance/`, `governance/`, `redteam/probes.py`, `guardrails/` per
`KNOWN-SUBSYSTEMS.md`'s "not yet inspected" list, and draft the User Experience
& Value section. The doc under review does **not** get edited.

---

## VERIFIED

Spot-checked the doc's most load-bearing, line-cited claims directly against
source. All held up precisely — this is a well fact-checked document. Confirmed:

- **SSO callback unconditionally 503s.** `src/eden/api/routes/sso.py`
  `sso_callback` (decorator at `@router.post("/callback/{provider_id}")`)
  discards `code`/`saml_response`, consumes the CSRF state, then always raises
  `HTTPException(503, {"status": "sso_not_enabled", ...})`. Matches the doc's
  §1b claim and quoted snippet exactly.
- **`/api/v1/me` DELETE really is two-table-narrow.** `src/eden/api/routes/compliance.py`
  `delete_me` → `background_tasks.add_task(jobs.run_user_delete_job, ...)` →
  `compliance_jobs.py` deletes `org_members` and anonymizes `users` only, as
  quoted in the doc's §2a. Confirmed by direct read.
- **`rtbf_fanout_v1` flag defaults `False`.** `src/eden/config.py:1252` —
  `rtbf_fanout_v1: bool = False`, with an adjacent comment: "erasure erases
  almost nothing. Set RTBF_FANOUT_V1=true only once those are real." Matches §2b.
- **Typesense schema genuinely has no `user_id` field**, and `delete_by_user`
  (`src/eden/observability/typesense_client.py:588-591`) builds a filter on
  `user_id:={user_id}` anyway, via `delete_by_filter`, which reports
  `status: "ok", deleted: <n>"` regardless (`rtbf_fanout.py` `_fanout_typesense`,
  confirmed by direct read: `return {"store": store, "status": "ok", "deleted": deleted}`
  inside the `try` block, no schema-membership check). This is exactly the
  "falsely reports ok" claim in the doc's §2b table.
- **Redis fanout has the same silent-false-success shape** — confirmed
  `_fanout_redis` in `rtbf_fanout.py` also returns `status: "ok"` after a SCAN
  that structurally can't match anything (pattern embeds a user id; no key
  pattern in the codebase does).
- **§5a inventory line counts are exact**: `scim.py` 1294, `rbac.py` 715,
  `audit.py` 238, `services/governance_intel/compliance.py` 811 — all confirmed
  via `wc -l`.
- **§5b portal settings modes** — confirmed `settings-chrome.tsx:15`:
  `export type SettingsMode = "workspace" | "keys" | "members" | "audit"`, with
  `scim`/`pii` both aliased to `"workspace"` (lines 28, 30) and no dedicated
  screen — matches the doc precisely.
- **`compliance/evidence_generator.py` is confirmed to be exactly what
  `KNOWN-SUBSYSTEMS.md` flagged as unread**: it's a 39-line backwards-compat
  shim re-exporting `ComplianceEvidenceGenerator` et al. from
  `eden.services.governance_intel` and `eden.governance.compliance_pack`. Not
  a hidden gap — the doc is right to treat `services/governance_intel/compliance.py`
  as the real implementation.
- **01-competitor-matrix.md explicitly defers to this doc** for RBAC
  competitive framing (`01-competitor-matrix.md:496`: "Partial — see
  `07-security-compliance.md`"), so keeping the §5c competitor table here is
  not redundant with 01 — it's the canonical location 01 points to.

Web-sourced claims in §3 (EDPB Coordinated Enforcement Framework, SOC2 Type II
evidence-sampling practice) could **not** be re-verified this pass — WebSearch
budget for the session was exhausted before I could re-run the queries. I found
no internal evidence they're wrong; treat them at the same confidence pass 3
already assigned (§5f: "search-engine-sourced with direct citations," i.e. not
independently re-checked this pass either).

---

## CUT

Minor, precision-level issues only — this doc is unusually tight for a
pass-3-to-pass-4 handoff and I did not find material to prune as false,
speculative, or filler. Two small corrections:

1. > "Filing `DELETE /compliance/delete-me` — the only path a real customer can self-serve today —"

   **Reason:** Route-name inaccuracy, not just a label. The actual mounted
   path is `DELETE /api/v1/me` (`compliance.py:118`, router has no
   `/compliance` prefix — `app.py:239` mounts it as `/api/v1/me/* + dsar +
   subprocessors`). `/compliance/delete-me` doesn't exist anywhere in the
   codebase as a route string. Low risk of confusing a reader, but worth
   fixing before this doc is used to brief someone who'll go looking for the
   literal endpoint. Separately (see NEW FINDINGS below), "the only path a
   real customer can self-serve today" overstates reachability — it is not
   wired to any UI, so no real customer currently reaches it through the
   product at all.

2. > "`SPAN_SCHEMA` (`typesense_client.py:67-97`) lists 20 fields"

   **Reason:** Off-by-one — the current `SPAN_SCHEMA["fields"]` list has 21
   entries (`tenant_id` through `created_at`). Doesn't change the substance
   (still zero `user_id` field either way), so not worth a special mention on
   its own, but flagging since the doc is otherwise this precise.

---

## USER EXPERIENCE & VALUE

### Who is the user

Four distinct personas hit this feature area, and the doc (through pass 3)
mostly writes for the last one implicitly. Naming them explicitly matters
because their journeys are almost entirely disconnected from each other today:

1. **The data subject** — an end user of one of Eden's customers who wants
   their data deleted (GDPR Art. 17 / CCPA), or their org's **DPO/support
   engineer** acting on their behalf via a DSAR ticket.
2. **The compliance officer / security lead at a prospective enterprise
   customer** — running a vendor security questionnaire or gating a deal on
   "show me your SOC2 evidence for this control."
3. **A SOC2 Type II auditor** sampling actual deletion/audit events, not
   reading a policy doc.
4. **A security/AppSec engineer at Eden's customer** who wants to red-team
   their own agent (jailbreak/injection/PII-leak resistance) before shipping
   it, or as part of the same vendor security review.

### What the flow looks like today, concretely

**1. Data subject erasure.** There is no "Delete my account" or "Delete my
data" button anywhere in the portal. I searched the entire `clients/portal/src`
tree for any account-deletion UI and found none — the only UI hit for
`"delete...account"` is a static CCPA "Do Not Sell" marketing page, unrelated
to actual erasure. Worse than the doc's pass-3 framing suggests: there are
**three**, not two, non-communicating deletion code paths, and none is wired
to a UI button:
   - `DELETE /api/v1/me` (`compliance.py`) — anonymizes `users` row, deletes
     `org_members` row. Zero portal callers (grepped `resources.ts`/`portal.ts`
     for `api/v1/me` — no hits).
   - `DELETE /users/me` (`auth.py:2039`) — a *third*, even narrower path not
     mentioned anywhere in the doc: sets `deleted_at` and rotates
     `token_version` only, doesn't touch `org_members`, doesn't anonymize
     email/name/password. The portal's `resources.ts:455` `deleteAccount()`
     function calls exactly this route — but has **zero component callers**
     anywhere in the portal (grepped `clients/portal/src/app`, `src/lab`,
     `src/components` for `deleteAccount` — the only match is its own
     definition).
   - `RightToBeForgottenService.process_request` (`gdpr.py`) — the broad,
     well-engineered 6-table + cross-store fanout version, reachable only via
     `POST /governance/rtbf`, gated by the off-by-default `rtbf_fanout_v1` flag.

   So today, if a real data subject files a request, a support engineer must
   know to hand-call one of three inconsistent API endpoints (most likely the
   narrowest one, since it's literally in a file called `compliance.py`), with
   no confirmation of what was actually erased, no per-store report, and no
   re-verification that indexed content (Typesense) or vectors (Qdrant) are
   actually gone. This is worse than "self-serve, but narrow" — it isn't
   self-serve at all; it's "reachable only by someone with API access and
   endpoint knowledge," which for most orgs means an engineer, not the DPO.

**2. Compliance evidence for a buyer/auditor.** `ComplianceEvidenceGenerator`
(`services/governance_intel/compliance.py`, 811 lines, tested: 50+ SOC2
controls / 18 HIPAA safeguards / 10 GDPR controls / 14 ISO27001 families) is
real and reasonably deep. But getting a pack out of it today requires calling
`POST /orgs/{org_id}/intelligence/governance/compliance/generate` directly —
no portal button exists anywhere. The portal's one "Audit → packs" surface
(`settings/page.tsx`, `GET /orgs/{orgId}/portal/audit/packs`,
`src/eden/api/routes/portal.py:2692`) does **not** call
`ComplianceEvidenceGenerator` at all — it reads `AgentAuditLedgerWriter().query()`
directly against the `agent_audit_ledger` table (a hash-chained event log, see
NEW FINDINGS). So the one thing a compliance officer can click "load" on in
the product today is a raw ledger of audit events, not a framework-mapped
evidence pack — a materially different (and less useful) artifact than what
a SOC2 auditor or security questionnaire is actually asking for.

**3. Red-team probing.** Entirely absent from the doc, but squarely in its
domain. `src/eden/redteam/probes.py` (699 lines) ships 12 real, tested
adversarial probes across jailbreak / prompt-injection / PII / excessive-agency
families, with a working `ProbeRunner`, SSRF-hardened target-endpoint
validation (HTTPS-only, no private/loopback/link-local IPs, DNS-rebind
re-check at call time — genuinely careful engineering,
`src/eden/api/routes/redteam.py:127-206`), and four live, mounted API routes
(`GET/POST /orgs/{org_id}/redteam/{probes,probe,scan,findings}`, registered in
`app.py:241`). It's covered as a *competitive differentiator* in
`01-competitor-matrix.md:410-424,484` ("Have — new row this pass... closest
external analog is Patronus AI's Percival") — but that doc only checks
capability existence, not product reachability, which is this doc's job.
Reachability is bad: the portal's `/redteam` path is explicitly listed in
`STUB_PORTAL_PATH_PREFIXES` (`portal-routes.ts:13`) and gets rewritten to
`/unavailable` by middleware (`portal-hub-redirect.ts`) — a hard "page moved"
wall, not a partial page. And `guardrails-url.ts` shows this used to have a
home under the Guardrails hub: `tab=redteam` is explicitly normalized away to
`policies` (`guardrails-url.ts:3,70,100`) with no user-facing acknowledgment
that the tab is gone. `redteamApi` exists in `resources.ts:3724` with three
real methods but, like the other two, zero component consumers. A security
engineer wanting to red-team their agent today has to read the FastAPI route
file to discover this exists at all.

### Why it matters

A buyer's security team, a SOC2 auditor, and a data subject filing a DSAR do
not read `src/eden/services/governance_intel/`. They interact with a product
surface, and today that surface says "we don't have this" on all four
workflows above — SSO login, GDPR erasure, compliance evidence, red-teaming —
even though three of the four have substantial, tested backend implementations,
in some respects (the SSRF-hardened probe runner, the hash-chain audit ledger,
the 50+-control evidence generator) ahead of what many funded competitors ship.
The pattern repeats identically across every workflow in this doc: **build the
backend, ship it behind a route nobody calls from the UI.** That is a cheaper
problem to fix than "we don't have the capability," but from the outside — the
only vantage point that matters for a deal-gating security review — it is
indistinguishable from not having it, and in the GDPR case it's actively worse
than not having it: it creates a false impression of "self-serve" compliance
that isn't real for any actual user.

### What would make this trustworthy and usable

- **One erasure path, not three.** Retire two of the three `DELETE`
  implementations (or make the narrower ones call the RTBF service instead of
  duplicating logic), wire a single "Delete my data" flow into account
  settings, and have it call `RightToBeForgottenService` end to end. Fix the
  Typesense/Redis false-success bugs before flipping `rtbf_fanout_v1` on.
- **Report honestly, per store, every time.** `rtbf_fanout.py`'s existing
  pattern for Qdrant/S3 — explicit `status: "failed"` / `"unsupported"` rather
  than silent success — is exactly right and should be the UI contract too: a
  user or auditor should see "Postgres: erased. Qdrant: failed (no per-user
  index). Typesense: not yet supported," not a single green checkmark.
- **Technically verify, don't just trust the delete call.** The GDPR web
  research cited in §3 converges on re-querying stores post-deletion as the
  credible bar; that's a natural extension of the fail-closed pattern already
  in `gdpr.py`, and the kind of evidence a SOC2 Type II auditor samples for
  directly.
- **Surface the hash-chain ledger as a trust primitive, not a hidden detail.**
  `AgentAuditLedgerWriter.verify_chain` (tamper-evidence via recomputed SHA-256
  chain, tested in `tests/unit/ws4/test_enterprise_ws4.py`) is a genuinely
  strong, already-built answer to "how do we know this evidence wasn't
  edited after the fact" — exactly the question a SOC2 auditor or enterprise
  security reviewer asks. Today it's invisible; surfacing "chain verified: ✓"
  next to any exported compliance pack turns existing plumbing into a
  concrete trust signal.
- **Ship the cheapest UI win in this entire doc first.** The red-team probe
  suite is fully built, tested, and API-complete — a list-probes +
  run-scan + view-findings screen under the existing Guardrails hub (where a
  `redteam` tab already existed in the URL grammar before being aliased away)
  is close to pure frontend work against an API that needs no further backend
  changes, unlike SSO (login flow still doesn't work) or GDPR (two
  integrations still need fixing before the flag is honest).

---

## NEW FINDINGS

1. **A third, previously-undiscovered "delete my account" implementation
   exists and is even narrower than the two the doc analyzed.**
   `src/eden/api/routes/auth.py:2039`, `DELETE /users/me` — sets `deleted_at`
   + rotates `token_version` only; does not touch `org_members`, does not
   anonymize email/name/password_hash. The portal's `resources.ts:455`
   `deleteAccount()` calls exactly this route. Neither this nor `compliance.py`'s
   `/api/v1/me` has any UI caller anywhere in the portal (verified by grep
   across `clients/portal/src/app`, `src/lab`, `src/components`) — there is no
   "delete my account" button in the product at all. This sharpens (worsens)
   the doc's existing GDPR framing: describing `DELETE /compliance/delete-me`
   as "the only path a real customer can self-serve today" overstates
   reachability. No real customer currently reaches *any* deletion path
   through the product; all three require direct API knowledge.

2. **`src/eden/redteam/` (probes.py 699 lines, findings_store.py 125 lines)
   is a fully-built, tested, API-live adversarial red-team subsystem that
   this doc does not mention at all**, despite being squarely
   security-domain and despite `KNOWN-SUBSYSTEMS.md` explicitly flagging
   `redteam/probes.py` as "not yet inspected but plausibly relevant."
   12 named probes (jailbreak/prompt-injection/PII/excessive-agency), a
   `ProbeRunner` with SSRF-hardened `target_endpoint` validation
   (`api/routes/redteam.py:127-206`: HTTPS-only, rejects private/loopback/
   link-local/reserved IPs, re-validates at call time against DNS rebinding,
   optional allowlist via `EDEN_REDTEAM_ENDPOINT_ALLOWLIST`), four mounted
   routes (`app.py:241`), a dedicated `redteam_findings` table with its own
   migration (`db_migrations/versions/093_redteam_findings_org_scope.py`),
   and two test files (`tests/unit/test_redteam_probes.py` 395 lines,
   `tests/unit/api/test_redteam_target_endpoint.py` 83 lines). Covered as a
   *competitive differentiator* in `01-competitor-matrix.md` but that doc
   doesn't check product reachability — which is this doc's job and which is
   bad: `/redteam` is a hard portal stub (`portal-routes.ts:13` →
   `portal-hub-redirect.ts` rewrites to `/unavailable`), and a legacy
   `tab=redteam` param under the Guardrails hub is silently normalized to
   `policies` (`guardrails-url.ts:3,70,100`) — evidence a red-team UI surface
   existed at some point and was removed/aliased away without replacement.
   `redteamApi` in `resources.ts:3724` has zero component consumers.
   **Recommend this doc add a section on it** — it's the strongest
   "backend built, unreachable in product" case in the entire security/
   compliance area, and the cheapest to fix.

3. **`src/eden/governance/compliance_pack.py` (244 lines) + its API route
   `src/eden/api/routes/compliance_pack.py` (97 lines) — an agent-scoped
   SOC2/compliance evidence pack with hash-chain tamper-evidence — is
   also entirely unmentioned by this doc**, despite `governance/` being on
   `KNOWN-SUBSYSTEMS.md`'s "not yet inspected" list. `AgentAuditLedgerWriter`
   maintains an append-only, SHA-256 hash-chained ledger (`agent_audit_ledger`
   table, migration `092_market_ready_consolidated.py`) with a
   `verify_chain()` method that recomputes the chain and reports
   `broken_rows`/`ok_rows` — real tamper-evidence, unit-tested for empty,
   valid, and tampered-chain cases (`tests/unit/ws4/test_enterprise_ws4.py:70-124`).
   `CompliancePackGenerator.generate_agent_pack` combines this with
   `ComplianceEvidenceGenerator` to produce a per-agent pack (base SOC2/HIPAA/
   GDPR/ISO27001 evidence + agent-specific audit events + chain-verification
   attestation). It's exposed via three live routes gated by
   `compliance_pack_export_v1` — **which defaults `True`**
   (`config.py:1451`, unlike `rtbf_fanout_v1`'s `False`) and is mounted in
   `app.py:269`. Despite being on and enabled, it has **zero portal
   consumers** (grepped `resources.ts`/`portal.ts` for the route paths and
   flag name — no hits) and **zero API-route-level or end-to-end tests** (only
   the underlying `verify_chain()` unit tests exist; nothing tests
   `generate_agent_pack` or the FastAPI routes themselves). This is a real
   capability sitting fully enabled and completely undiscoverable.

4. **Corrects/sharpens the doc's §5b claim about the portal's "Audit →
   packs" UI.** The doc says this UI hits "a distinct endpoint, not connected
   to the `ComplianceEvidenceGenerator`" — directionally correct but doesn't
   say what it *is* connected to. Traced it: `GET /orgs/{orgId}/portal/audit/packs`
   (`api/routes/portal.py:2692`) calls `AgentAuditLedgerWriter().query()`
   directly — i.e., the portal's one live compliance-adjacent screen is
   backed by the same `agent_audit_ledger` table from finding #3 above, not
   by the 811-line SOC2/HIPAA/GDPR/ISO27001 generator the doc spends most of
   §5a describing. Worth stating explicitly: the thing a compliance officer
   can actually see in the product today is a raw hash-chained event ledger,
   not a framework-mapped evidence report.

5. **Web research in §3 could not be re-verified this pass** — WebSearch
   quota was exhausted mid-session. No evidence found that it's wrong; flag
   for a future pass to re-confirm the specific EDPB Coordinated Enforcement
   Framework claim and the SOC2 Type II evidence-sampling sourcing before
   this doc is used as a source of external, cited fact in a broader
   strategic-review rollup.
