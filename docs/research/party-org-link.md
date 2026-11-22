# D2101: one-hop party → organisation candidates

Trial, default **off** (`pushPartyOrgLink`), based on `origin/main` `1eaa51b1d`.
This is a candidate-retrieval change, not employer/employee alias equivalence.

After rebasing onto `5e77a20c4` (D2100), stem seats run first (at most two);
org seats then exclude those items and add at most two more, within the same
pool cap. `pushPartyOrgLink` now requires the checker dependency at config
validation, like `pushConstraintStemSeats`.

## Bounds and provenance

- Opt-in cache indexing reads each stored item's bounded text once per index update.
  Explicit `Contact:` + `Company:` fields support a contact edge. A mail signature
  must name the folded `From:` display name or match the folded first+last-name
  sender local part. Any nearby explicit signature email must match the sender.
  Name comparisons and lookups use NFKD/combining-mark removal plus common Latin
  folds (`ß→ss`, `ø→o`, `ł→l`, `đ/ð→d`, `þ→th`, `æ→ae`, `œ→oe`, `ı→i`).
  Quoted/forwarded history is excluded.
  This is provenance from source text, not verification of employment or sender authenticity.
- Signature company tails stop at phone-like numbers, email/URL, a subsequent
  spaced pipe, or common phone/email/disclaimer/mobile-footer markers, before
  enforcing the existing 100-character company bound. Input remains capped at
  16,000 characters. Flattened footers do not enlarge the company bound.
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

| hiddenDelivered | decoyDelivered | calls/task      |
| --------------- | -------------- | --------------- |
| 32/40 → 32/40   | 12/40 → 12/40  | 7.1875 → 7.1875 |

Quality, four users × ten sessions, `--judge local --brief`:

| Seed | Recall      | Precision   | falseFireRate |
| ---- | ----------- | ----------- | ------------- |
| 13   | .826 → .826 | .532 → .532 | .071 → .071   |
| 7    | .753 → .753 | .513 → .513 | .067 → .067   |

These harnesses do not wire a push checker. Flat numbers are an unchecked-path
safety screen, not active-check accuracy evidence. D2101 stays trial/default off.
Those historical runs used no paid calls, oracle checker or live uptake evaluation.

Historical measurement commands (before checker-dependency enforcement; repeat
with the flag false/true, quality seeds 13 and 7). The current no-checker CLI
correctly rejects flag-on rather than silently measuring an inactive feature:

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

## Signature identity follow-up ($0)

Engine-only change from main `d997514da`, still under the existing default-off
`pushPartyOrgLink`; no world, contact-generation or harness behavior change.
Seed 43's own signature used a nickname address (`becky.stone` versus Rebecca
Stone); seed 44's accented name differed from its ASCII address, and snippet
flattening made its company/footer tail 148 characters. Display-name identity
now admits the former without inventing a nickname alias; footer cutting and
name folding admit the latter. Explicit mismatched email, unrelated signature
names, quotes/forwards and overlong post-cut companies still fail closed.
No role expansion or change to the two-seat/512-evidence bounds.

Anonymised regression cases cover both shapes, NFC/NFD names, common Latin
folds, sender-local identity, footer markers, mismatched/quoted/forwarded names,
company bounds and generic-role non-expansion. Forcing the display-name predicate
true made the unrelated-name negative test fail (0 pass, 1 fail). Restored using
a targeted patch; the source SHA-256 matched before/after restoration.

### Active-check funnel

PR #534 was not yet on main at branch creation. Measurements therefore used a
separate worktree at its lab-only commit `ef3fdd5ce`, with dependencies resolving
to this branch's engine (verified at runtime), rather than copying harness changes
onto this branch. Worlds and source profiles are unchanged. Seeds 41–44, direct
hidden suite, serial, instant source latency, `--no-record`, no ledger labels.
Noisy rates explicitly TP=.85 / FP=.05. All counts below are out of 40.

| Noise | Checker | Seats   | Hidden pool | Hidden delivered | Decoy delivered |
| ----: | ------- | ------- | ----------: | ---------------: | --------------: |
|   995 | oracle  | default |          32 |               32 |               0 |
|   995 | oracle  | both    |          40 |               40 |               0 |
|   995 | noisy   | default |          32 |               27 |               1 |
|   995 | noisy   | both    |          40 |               33 |               1 |
|  3000 | oracle  | default |          32 |               32 |               0 |
|  3000 | oracle  | both    |          40 |               40 |               0 |
|  3000 | noisy   | default |          32 |               27 |               1 |
|  3000 | noisy   | both    |          40 |               33 |               1 |

Both means `pushConstraintStemSeats=true,pushPartyOrgLink=true`; default leaves
both off. Relative to the unchanged-engine measurements, combined hidden pool
improves 38→40, oracle delivery 38→40 and noisy delivery 31→33 at either noise.
Both formerly missing legal-hold cases now enter the pool and reach the packet.
All eight runs made active checks, with zero failures and $0 model cost.
These are synthetic retrieval/applicability measurements, not real-checker
accuracy, explanation quality or agent uptake evidence. No defaults changed.

```sh
# In the PR #534 measurement worktree; CONFIG is {} or both seat flags true.
bun packages/sim/src/lab/hidden-funnel.ts --suite hidden --seeds 41,42,43,44 \
  --noise-sources "$N" --serial --time 0 --no-record --check "$MODE" \
  --config "$CONFIG" --json "$OUT.json" --check-dump "$OUT-checks.jsonl"
# N=995/3000; MODE=oracle/noisy; noisy adds --check-tp .85 --check-fp .05.
```

### Quality safety screen: before → after

Four users × ten sessions, seeds 13/7, realistic sources, time/wait 0, no model
or judge, `pushPartyOrgLink=true` on both sides. Quality does not wire a push
checker, and its CLI correctly rejects this checker-dependent flag. The
comparison therefore uses the existing `runQuality` API, not a weakened CLI
guard. Indexing is enabled; org seats remain inactive. This tests unchecked-path
safety only, **not active-check precision/false-fire behavior**.

| Seed | Precision   | falseFireRate | Recall      |
| ---: | ----------- | ------------- | ----------- |
|   13 | .394 → .394 | .000 → .000   | .674 → .674 |
|    7 | .398 → .398 | .067 → .067   | .573 → .573 |

The earlier historical table used a different judge configuration; these are
paired before/after runs, not a claimed reproduction of those absolute numbers.

Artifacts: `~/diag-1122/signature-{995,3000}-{oracle,noisy}-{default,both}.{json,log}`
and check dumps; `signature-quality-{before,after}.jsonl`, `signature-quality.ts`
and `signature-mutation.txt`. No paid calls or ledger writes.
