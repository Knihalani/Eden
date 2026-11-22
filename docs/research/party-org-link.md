# D2101: one-hop party → organisation candidates

Trial, default **off** (`pushPartyOrgLink`), based on `origin/main` `1eaa51b1d`.
This is a candidate-retrieval change, not employer/employee alias equivalence.

## Bounds and provenance

- Opt-in cache indexing reads each stored item's bounded text once per index update.
  Explicit `Contact:` + `Company:` fields support a contact edge. A mail signature
  must name the `From:` person, with either the same signature email address or a
  full first+last-name sender local part. Quoted/forwarded history is excluded.
  This is provenance from source text, not verification of employment or sender authenticity.
- At most two organisations per person and 512 evidence records per tenant/user.
  Evidence retains source/item/ref and is removed with its item; expired evidence
  cannot be used. Thaws/rebuilds reconstruct it from the scope's own cached items.
  A full index ignores further evidence until space is freed; stale employment
  and ambiguous names remain reasons for checker caution.
- Only request-named people (existing person aliases or whole known names) are
  looked up. There is no role expansion or traversal from an organisation to its
  own affiliation. At most eight names/four distinct organisations per request;
  retrieval reads 48 hits per org and requires all org terms on the candidate.
- Existing constraint/card detection filters candidates. Existing conflict
  assessment, tied locally to the retrieved organisation, puts blockers before
  weak constraint wording. It does not modify request aliases or ordinary ranking.
  At most two extra check-only seats enter the existing capped pool. Absent,
  failed or late checks retain the original unchecked pool through the existing
  supplemental-seat machinery.

## Shadow check ($0)

Seed 41, noise 995, actual legal-hold push: cached `gmail:mail-1225` supports
**Ahmed Hassan → Umbrella Health** from its own sender-matched signature.
`slack:hidden-3` (`#legal`, no delivery commitment until the MSA is countersigned)
is absent from the normal pool and present in the shadow pool's two seats.
Both observed legal-hold passes include it. The fake checker was supplied only
while constructing the shadow pool, then restored; no model judgement or actual
delivery improvement is claimed.

The first shadow exposed pricing threads taking both seats under pure lexical
order. Prioritising existing conflict assessments fixed that; regression tests
include stronger legal blockers competing with weak pricing constraints.

## Offline safety measurements ($0): off → on

Direct hidden funnel, seeds 41–44, noise 995, serial, instant sources, no card or
intent replay and no explicit ask. No ledger rows written.

| hiddenDelivered | decoyDelivered | calls/task |
| --- | --- | --- |
| 32/40 → 32/40 | 12/40 → 12/40 | 7.1875 → 7.1875 |

Quality, four users × ten sessions, `--judge local --brief`:

| Seed | Recall | Precision | falseFireRate |
| --- | --- | --- | --- |
| 13 | .826 → .826 | .532 → .532 | .071 → .071 |
| 7 | .753 → .753 | .513 → .513 | .067 → .067 |

These harnesses do not wire a push checker. Flat numbers are an unchecked-path
safety screen, not active-check accuracy evidence. D2101 stays trial/default off.
No paid calls, new oracle checker or live uptake evaluation.

Reproduction (repeat with the flag false/true, quality seeds 13 and 7):

```sh
bun packages/sim/src/lab/hidden-funnel.ts --suite hidden --seeds 41,42,43,44 \
  --noise-sources 995 --serial --time 0 --config '{"pushPartyOrgLink":true}' \
  --label diag-1122-org --no-record --json /path/to/result.json
bun packages/sim/src/quality-cli.ts --users 4 --sessions 10 --seed 13 \
  --judge local --brief --config '{"pushPartyOrgLink":true}'
```

Artifacts: `/home/ubuntu/diag-1122/org-995-{false,true}.json`,
`org-quality-{13,7}-{false,true}.json`, and `org-shadow.{ts,log,json}`.
Tests cover derivation, rejected quotes/forwards and other senders, evidence/org
bounds, expiry/replacement/revocation, freeze/thaw, tenant/user isolation, one-hop
and two-seat bounds, checked delivery and unchanged absent/failed-check fallback.
Mutation falsification raised the seat limit from two to twenty: the bound test
failed (expected 2, received 3). The source was restored with a Python patch.
