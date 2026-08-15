---
title: "33 — PII anonymization upgrades (Phase K)"
status: IMPLEMENTED v1
last_updated: 2026-06-17
version: 1.0
---

# 33 — PII anonymization upgrades (Phase K)

> **Status:** ✅ **IMPLEMENTED v1** (shipped 2026-06-17).
> Closes the RagaAI "PII vault + multi-language + lifecycle
> tracking" gap. Three surfaces:
>  1. **FakerVault** — deterministic real→fake PII mapping
>     (7 locales, 1,500+ curated names).
>  2. **MultiLangPIIMasker** — 19 international PII patterns
>     (EU, CJK, LatAm, South Asia, Middle East, Africa)
>     wrapping the existing 14-pattern English masker.
>  3. **RtbfRequestTracker** — lifecycle table for GDPR
>     Art. 17 requests (status enum, affected_rows, error,
>     timestamps).
> ~1,200 LOC backend + 63 unit tests.

## Goal & motivation

The existing PII infrastructure (Phase 7.3a) ships with 14
English-centric patterns and a per-tenant override policy.
For real-world production:

1. **The user base is global.** The same PII masking
   pipeline needs to recognise Spanish NIE, German
   Steuer-ID, Chinese ID, Indian Aadhaar, Brazilian CPF.
2. **Synthetic datasets need synthetic PII.** The
   `SyntheticDataEngine` generates paraphrases but pulls
   names from a public list — which can collide with real
   users' names in the same dataset.
3. **GDPR Art. 17 needs an audit trail.** The current
   in-place redaction is a "***" replacement; there's no
   per-request lifecycle row showing when it ran, who
   triggered it, and how many rows it touched.

Phase K closes all three.

## What's in Eden

### 1. FakerVault

**File:** `src/eden/data_platform/faker_vault.py`

A deterministic real→fake PII mapper. Any input always
produces the same output (so a dataset rebuild doesn't
surprise users with new "Sarah Johnson"s in the same
column), and the output is drawn from a curated pool of
plausible fakes.

```python
from eden.data_platform.faker_vault import FakerVault

vault = FakerVault(salt=b"\x00" * 16)
vault.fake_name("John Smith")          # → "Margaret Williams"
vault.fake_email("john@example.com")   # → "asmith42@example.com"
vault.fake_phone("555-123-4567")       # → "(322) 555-0341"
vault.fake_ssn("123-45-6789")          # → "412-08-7234"
vault.fake_credit_card("4111111111111111")  # → "4XXX-XXXX-XXXX-XXXX (Luhn-valid)"
vault.fake_address("123 Main St")      # → "4521 Pine Rd, Madison, WI"
vault.fake_person("alice")             # → {name, email, phone, address, ssn, username}
```

**Locales:** `en`, `es`, `ar`, `ja`, `fr`, `de`, `zh`. Each
locale has 60+ first names + 60+ surnames (1,500+ names
total). Default is English.

**Salt:** every vault has a per-instance salt. Different
salts → different outputs for the same input, so two orgs
running the same dataset get different fakes. Use an org
UUID as the salt to scope the vault.

**Determinism guarantee:** `vault.fake_name(x) ==
vault.fake_name(x)` for the same vault. Across vaults with
different salts, the same input may produce different
outputs (that's the point).

**Use case:** call `fake_person(real_name)` in the
`SyntheticDataEngine` when generating Q/A pairs from
real telemetry. The dataset ships with consistent
identities per real person, but those identities are
plausible fakes — no real PII leaks to the customer.

### 2. MultiLangPIIMasker

**File:** `src/eden/data_platform/pii_intl.py`

A sibling module that adds 19 international PII patterns
on top of the existing 14-pattern base `PIIMasker`. The
base masker is unchanged (zero-risk upgrade — drop-in,
additive).

```python
from eden.data_platform.pii_intl import MultiLangPIIMasker

masker = MultiLangPIIMasker()
masker.scan_intl("My CPF is 529.982.247-25.")
# → [IntlMaskResult(pattern='cpf_br', match='529.982.247-25', ...)]

masker.mask({"metadata": "VAT: DE123456789"})
# → {"metadata": "VAT: [REDACTED:vat_eu]"}
```

**19 international patterns** (grouped by region):

| Region | Patterns |
|---|---|
| EU | `nie_es`, `insee_fr`, `steuer_id_de`, `vat_eu`, `nino_uk` |
| CJK | `id_cn`, `id_hk`, `id_tw`, `mynumber_jp` |
| LatAm | `cpf_br`, `cnpj_br`, `rfc_mx`, `dni_ar`, `rut_cl` |
| South Asia | `aadhaar_in`, `pan_in` |
| Middle East | `national_id_sa`, `emirates_id_ae` |
| Africa | `id_za` |

**Checksum-validated patterns** (3):
- `cpf_br` — Brazilian CPF with two check digits
- `cnpj_br` — Brazilian CNPJ with two check digits
- `id_za` — South African ID 13-digit with Luhn

Invalid matches (e.g. `111.111.111-11` for CPF) are NOT
flagged.

**Policy integration:** the existing `PIIPolicy` (`enabled`
/ `disabled_categories`) covers the intl patterns too. By
default, all 19 intl patterns are enabled when you create
`MultiLangPIIMasker()`; pass a `PIIPolicy` to override.

**Masking output:** `[REDACTED:<pattern>]` placeholders,
e.g. `VAT: DE123456789` → `VAT: [REDACTED:vat_eu]`. The
masker walks nested dicts and lists, so the existing
gateway filter pipeline is unchanged.

### 3. RtbfRequestTracker

**File:** `src/eden/services/governance_intel/rtbf_tracker.py`

A thin wrapper around `RightToBeForgottenService` that
writes a lifecycle row to the new `rtbf_requests` table
(migration 033) per call. Status flow:

```
pending → in_progress → completed
                    └→ failed (error captured)
```

```python
from eden.services.governance_intel import RtbfRequestTracker

tracker = RtbfRequestTracker(pg_client)
result = await tracker.track(
    org_id="org-42",
    target_user_id="user-123",
    requester_user_id="user-123",   # self-serve
    reason="GDPR Art. 17 right to erasure",
)
# result["rtbf_request_id"] = "uuid-of-lifecycle-row"
# result["rtbf_status"] = "completed"
# result["total_rows_anonymised"] = 42
```

**Operator dashboard queries:**

```sql
-- In-flight requests (pending + in_progress)
SELECT * FROM rtbf_requests
WHERE org_id = $1
  AND status IN ('pending', 'in_progress')
ORDER BY created_at DESC;

-- Recent requests for an org
SELECT * FROM rtbf_requests
WHERE org_id = $1
ORDER BY created_at DESC
LIMIT 50;

-- All requests for one data subject
SELECT * FROM rtbf_requests
WHERE target_user_id = $1
ORDER BY created_at DESC;
```

**Failure handling:** if the redaction raises, the wrapper
sets `status='failed'` + captures the exception text in
`error`. The exception is then re-raised so the API
returns 5xx. The redaction itself is **not** rolled back
(Postgres UPDATEs are committed as they happen); the
lifecycle row is the audit trail that says "started,
partially complete, errored at Y".

## RagaAI parity matrix

| RagaAI feature | Eden Phase K | Notes |
|---|---|---|
| Multi-language PII | ✅ 19 patterns | EU, CJK, LatAm, SA, ME, Africa |
| ONNX NER (person names, addresses) | ❌ deferred | Phase K deferral: requires ~500MB of model weights. We use deterministic name pools instead. |
| Faker vault (synthetic PII) | ✅ FakerVault | 7 locales, deterministic, Luhn-valid cards |
| Hidden names / allowed names lists | 🟡 partial | Per-tenant `enabled_categories` / `disabled_categories` covers "what to mask" but not "what to never mask". Add `hidden_names` / `allowed_names` to `PIIPolicy` later. |
| Per-request RTBF audit | ✅ RtbfRequestTracker | Migration 033, lifecycle status, affected_rows |
| Alternate-response failover | 🟡 existing | Cat 10 governance has this |

## What's NOT in this phase (deferred)

- **ONNX NER** — the highest-ROI RagaAI feature we don't
  ship. A 500MB model would let us detect person names,
  street addresses, and org names in any language. Defer
  to a future phase that bundles the model weights.
- **Hidden names / allowed names lists** — per-tenant
  allow/deny lists. The existing `PIIPolicy` has the
  structure (`enabled_categories` / `disabled_categories`)
  but not the "never flag 'MyCompany Inc.'" UX. Add
  `hidden_names: list[str]` + `allowed_names: list[str]`
  to the policy in a later phase.
- **Synthetic test data with FakerVault** — the vault
  is built, but the `SyntheticDataEngine` (Phase J) is
  what would consume it. Phase J wires the two together.
- **Per-pattern redaction strategies** — every intl
  pattern currently redacts to `[REDACTED:<pattern>]`.
  Some patterns (e.g. NINO, RUT) might want format-
  preserving masking (FFM) so the output is still
  structurally valid. Defer to Phase K.1.

## Tests

63 unit tests in `tests/unit/data_platform/test_faker_vault.py`:

**FakerVault (27 tests):**
- `TestFakerVaultDeterminism` (4) — same-input-same-output,
  different-input-different-output, salt scoping, default
  singleton.
- `TestFakerVaultShape` (7) — name/email/phone/SSN/CC/address
  shapes, `fake_person` returns all 6 fields.
- `TestFakerVaultLocales` (5) — en/es/ar/ja + unknown-fallback
  to English.
- `TestFakerVaultEdgeCases` (4) — empty input, very long
  input, non-ASCII input, NFKC normalisation.
- `TestFakerVaultPoolDiversity` (1) — 50 distinct inputs give
  50 distinct emails.
- `TestFakerVaultDefaultSingleton` (1) — `get_default_vault()`
  is process-wide.
- `TestMultiLangPatternsDetected` (19) — one test per
  international pattern, each with a known-good sample
  input.
- `TestMultiLangPIIMaskerChecksums` (4) — CPF, CNPJ, ZA
  Luhn validators reject invalid + reject wrong length;
  `MultiLangPIIMasker` doesn't mask invalid CPFs.
- `TestMultiLangPIIMaskerPolicy` (2) — disable suppresses
  match, enable-only subset works.
- `TestMultiLangPIIMaskerMask` (4) — replace with
  `[REDACTED:<pattern>]`, walks dicts, walks lists, has_pii
  check, categories list.
- `TestRtbfRequestTracker` (9) — lifecycle row created,
  failure path, dry-run, no-pg, list_for_org,
  list_in_flight, get_by_id round-trip, get_by_id
  unknown returns None, all_statuses sanity.
- `TestIntlPatternCatalogue` (2) — 19 patterns, all compile.

All 63 pass; 0 regressions in the existing
`tests/unit/data_platform/` suite (70/70 total).

## Migration

**Migration 033:** `rtbf_requests` table — 11 columns
(id, org_id, requester_user_id, target_user_id, reason,
status enum, affected_rows, error, started_at,
completed_at, created_at, updated_at), 3 indexes (org
recent, in-flight, target), 1 trigger (touch updated_at).

## Files added / modified

| File | Change |
|---|---|
| `src/eden/data_platform/faker_vault.py` | new (~600 LOC) |
| `src/eden/data_platform/pii_intl.py` | new (~370 LOC) |
| `src/eden/services/governance_intel/rtbf_tracker.py` | new (~250 LOC) |
| `src/eden/services/governance_intel/__init__.py` | +5 exports |
| `migrations/033_rtbf_requests.sql` | new |
| `tests/unit/data_platform/test_faker_vault.py` | new (63 tests) |
| `docs/docs/observability/33-pii-anonymization-upgrades.md` | this file |

## Cross-references

- [Cat 10 — Governance Intelligence](10-governance-intelligence.md)
  — the existing PII surface that Phase K extends.
- [Phase 7.3a — per-tenant PII policy](10-governance-intelligence.md)
  — the existing policy that the intl patterns plug into.
- [Phase J — Synthetic Q/A generation](synthetic-qa-generation.md)
  — the consumer of `FakerVault` (sibling phase).
- [Cat 15 — Runtime Protection](15-runtime-protection-guardrails.md)
  — the sibling PII surface (input/output guardrails).
