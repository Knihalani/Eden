# F84: Eden Dogfood Debugging & Self-Observability

| Field | Value |
|---|---|
| **Feature ID** | F84 |
| **Priority** | P0 |
| **Effort** | L |
| **Eden status** | PARTIAL — metrics exist; no coordinated dogfood debug program |
| **Competitive source** | Status pages; dogfooding observability products |
| **UI spec** | Settings admin status |
| **Dependencies** | F01, F04, F46, F82, F47/F81 |
| **Roadmap** | [EDEN-MASTER-ROADMAP.md](../EDEN-MASTER-ROADMAP.md) Wave 14 |

---

## 1. Summary

Instrument and debug Eden itself: worker health, gateway errors, portal API failures, flag exposure, synthetics, MCP health.

---

## 2. Eden current state

Prometheus metrics partial; no unified admin status; 5xx lack consistent request ids; synthetics ad hoc.

---

## 3. Target behavior

1. Admin status: ingest lag, heartbeats, queue depths, error budgets.
2. Portal 5xx include request id correlated to logs/traces.
3. Feature-flag debugger for org/user.
4. Synthetic probes: gateway → detect → issue path.
5. MCP `eden_health`.
6. Runbook links per subsystem.
7. Playwright failure artifacts on CI.

---

## 4. Architecture

```
src/eden/self_obs/
  heartbeats.py
  synthetics.py
  status_api.py
clients/portal/.../settings/(tabs)/status/
F04 MCP tool eden_health
```

---

## 5. Data model

```sql
CREATE TABLE eden_component_heartbeats (
  component TEXT NOT NULL, org_id UUID, status TEXT, meta JSONB,
  checked_at TIMESTAMPTZ NOT NULL);
CREATE TABLE eden_synthetic_runs (
  id UUID PRIMARY KEY, probe TEXT, status TEXT, detail JSONB,
  created_at TIMESTAMPTZ DEFAULT now());
```

---

## 6. API specification

```
GET /orgs/{org}/admin/eden-status
GET /orgs/{org}/admin/flags
POST /internal/synthetics/run
```

---

## 7. Implementation plan

1. Heartbeat writers on workers
2. Status API + Settings UI
3. Request id middleware
4. Synthetics + alert hook
5. MCP health tool

---

## 8. SDK / MCP / Portal

Portal instrumentation and CI gates are first-class. MCP health tools where noted. No customer-facing marketing surface required.

---

## 9. Feature flags & rollout

`features.f84` — enable per env; kill switch for probes/enforcement that could page falsely.

---

## 10. Test plan

- Unit tests for budget math / probe logic
- Staging soak with synthetic load
- CI gate self-test (fail then fix)
- Cross-org isolation for any status APIs

---

## 11. Acceptance criteria

- [ ] Admin sees ingest lag + workers without infra SSH
- [ ] Every portal 5xx has request id
- [ ] Synthetic fail → alert
- [ ] MCP health returns components
- [ ] Dogfood org continuous probes

---

## 12. Performance & cost optimization

Probes mostly deterministic; LLM probes sampled. Metrics: `eden_self_health_up`, `eden_synthetic_probe_success`.

### Monitoring

```
eden_f84_duration_seconds
eden_f84_errors_total
```

---

## 13. Dependencies

F01, F04, F46, F82, F47/F81
