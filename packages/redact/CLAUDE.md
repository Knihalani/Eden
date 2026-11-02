# @eden/redact

The secret gate (salvaged from the memory era, D16): vendored gitleaks v8.30.1 rules plus Eden's own rules,
prefiltered by one Aho–Corasick pass (D21), with the rules that backtrack in JavaScript and every allowlist on RE2
via `re2js` (pinned 2.9.0, D24). Every text Eden stores, indexes, logs or sends to a model passes `sanitizeForStore`
first (D10). See [README.md](README.md).

## Files

| File | Owns |
|---|---|
| `src/secrets.ts` | The rule set (`secretRules`, `RE2_RULES`, `GATE_ENGINES`), Go-to-JS/RE2 regex translation (`goRegex`, `re2Source`, `linearEngine`, `backtrackingEngine`), the gate (`gateOf`), `secretHits`, `sanitizeForStore`; Eden's extra rules (URL userinfo, `eden-aws-secret` D86) |
| `src/redact.ts` | Structural redaction of JSON (`redact`, `redactString`, `isSecretKey`, PEM blocks), `REDACTED`/`CYCLE`/`TRUNCATED` markers |
| `src/vendor/gitleaks/` | `gitleaks.toml` byte for byte, its LICENSE and pinned hash ([upgrade steps](src/vendor/gitleaks/README.md)) |

## Rules that apply here

- **The prefilter may only add candidates, never drop them (D21);** `prefilter.test.ts` enforces it.
- **Linear time (D24).** Any rule that backtracks on crafted input moves to `RE2_RULES`. `redos.test.ts` fails when
  a gitleaks update adds one (rules left on JavaScript must stay under 40 ms on 8 KB crafted runs, best of three) and
  checks 128 KB attacks stay under 1 s. `linear.test.ts` checks RE2 finds exactly the spans JavaScript finds.
- **Never weaken the gate to fix a false positive in a test**: make the test text not secret-shaped. Secret-shaped
  test values are assembled from parts (`"AK" + "IA" + …`) so no literal in the repo is one.
- **Dependencies (D15, D24):** `re2js` is the one justified exception; a new one needs its own decision.
- The engine and sources call this on every item: a slower gate is a slower fast path. Measure with
  `packages/primitives/bench/gate*.bench.ts` before and after.

## Test

```bash
bun run test:pkg redact          # ~10 s CPU over 7 files; redos.test.ts (~6.5 s) and linear.test.ts (~4 s) dominate
```

## Pitfalls

- The timing tests use wall-clock ceilings. Under heavy parallel load they have headroom (best of three, 40 ms vs
  13 ms measured), but if one flakes, investigate before raising a ceiling: that ceiling is the ReDoS guard.
- The vendored README mentions memory-era file names (`memory-secrets.ts`); today's equivalents are `secrets.ts` and
  its tests.

## Where next

`docs/research/architecture-alternatives.md` (ReDoS and RE2), `docs/research/edge-secret.md` (D86),
`docs/PRIVACY.md`, `packages/engine/src/gate.ts` (gating off the event loop, D25/D26).
