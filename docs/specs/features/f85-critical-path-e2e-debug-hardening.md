# F85: Critical-Path E2E & Debug Hardening

| Field | Value |
|---|---|
| **Feature ID** | F85 |
| **Priority** | P0 |
| **Effort** | L |
| **Eden status** | MISSING as coordinated program |
| **Competitive source** | Internal QA; Playwright CI |
| **UI spec** | — |
| **Dependencies** | Waves 11–13; F82; fixtures |
| **Roadmap** | [EDEN-MASTER-ROADMAP.md](../EDEN-MASTER-ROADMAP.md) Wave 14 |

---

## 1. Summary

Automate golden user journeys and debug playbooks so portal overhaul and optimization cannot silently break the product.

---

## 2. Eden current state

Scattered tests; no locked 8-path suite; flake unknown; fixtures incomplete.

---

## 3. Target behavior

Golden paths:
1. Sign-in → Home
2. Traces filter → transcript → span → dataset
3. Issue → create shadow artifact
4. Artifact evidence → promote or visible gate fail
5. Playground from-span → run → save prompt
6. Alert NL compile → save → ack
7. Experiment compare view
8. Debugger session / prefix rerun
Plus: seed org, redacted fixtures, CI screenshots, debug query param (dev).

---

## 4. Architecture

```
clients/portal/e2e/golden/*.spec.ts
fixtures/traces/*.json
docs/runbooks/golden-paths.md
```

---

## 5. Data model

CI seed org; no prod schema change required.

---

## 6. API specification

Test-only seed endpoints behind CI secret.

---

## 7. Implementation plan

1. Fixtures + seed
2. Implement 8 paths
3. Stabilize flake
4. Wire required CI check
5. Write playbooks

---

## 8. SDK / MCP / Portal

Portal instrumentation and CI gates are first-class. MCP health tools where noted. No customer-facing marketing surface required.

---

## 9. Feature flags & rollout

`features.f85` — enable per env; kill switch for probes/enforcement that could page falsely.

---

## 10. Test plan

- Unit tests for budget math / probe logic
- Staging soak with synthetic load
- CI gate self-test (fail then fix)
- Cross-org isolation for any status APIs

---

## 11. Acceptance criteria

- [ ] All 8 paths green on main
- [ ] Flake <2% over 50 runs
- [ ] Playbooks documented
- [ ] U18 shell breakage fails CI

---

## 12. Performance & cost optimization

Parallel CI; fixtures avoid live paid LLM where possible.

### Monitoring

```
eden_f85_duration_seconds
eden_f85_errors_total
```

---

## 13. Dependencies

Waves 11–13; F82; fixtures
