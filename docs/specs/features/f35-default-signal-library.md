# F35: Default Signal Library

| Field | Value |
|---|---|
| **Feature ID** | F35 |
| **Slug** | `default-signal-library` |
| **Priority** | P1 |
| **Effort** | M |
| **Eden status** | **MISSING** |
| **Competitive source** | Raindrop |
| **Closes gap** | 3.6, 5.4 |
| **Dependencies** | F06 (investigator), F34 (optional classifiers) |

---

## 1. Summary

Ship 8 prebuilt signal templates on org create — Forgetting, Laziness, Wins, Jailbreak, Frustration, etc. Raindrop parity; zero-config semantic detection beyond F20 deterministic detectors.

---

## 2. Default library (seed)

| Signal ID | Description | Output schema |
|---|---|---|
| `forgetting` | Agent ignores earlier context | `{forgot: bool, step: int}` |
| `laziness` | Skips tool use when required | `{lazy: bool, skipped_tool: str}` |
| `win` | Task completed exceptionally well | `{win: bool, reason: str}` |
| `jailbreak_attempt` | User tries policy bypass | `{attempt: bool, quote: str}` |
| `user_frustration` | Negative sentiment/regen | `{frustrated: bool}` |
| `hallucination` | Claims without tool evidence | `{hallucinated: bool}` |
| `looping` | Repetitive tool/message pattern | `{loop: bool}` |
| `cost_spike` | Trace cost >3σ (deterministic) | `{spike: bool}` — no LLM |

---

## 3. Implementation

**`src/eden/signals/defaults.py`**

```python
DEFAULT_SIGNALS: list[SignalTemplate] = [...]

async def seed_org_signals(org_id: str, profile: str = "standard"):
    for tmpl in DEFAULT_SIGNALS:
        if tmpl.id in PROFILE_SIGNALS[profile]:
            await signal_service.create_from_template(org_id, tmpl)
```

Migration `081_seed_default_signals.sql` for template definitions (global, not per org).

---

## 4. Org onboarding

- New org → seed `standard` profile (6 LLM + 2 deterministic)
- `minimal` → deterministic only (cost_spike, looping via ETEC)
- `advanced` → all 8 + custom slot

Settings: `/orgs/{id}/settings/signals` toggles per signal.

---

## 5. API

| Method | Path |
|---|---|
| `GET` | `/orgs/{org_id}/signals/library` |
| `POST` | `/orgs/{org_id}/signals/library/{id}/enable` |
| `POST` | `/orgs/{org_id}/signals/library/{id}/disable` |

---

## 6. Performance & cost optimization

### Cost model (F06 investigator per signal)

| Profile | LLM signals | Est. $/1k traces |
|---|---|---|
| minimal | 0 | $0 |
| standard | 6 | $0.06–0.30 (SLM) |
| advanced | 8 | $0.08–0.40 |

### Controls

- `cost_spike` + `looping` use StatGate — $0
- LLM signals share single investigator pass with multi-schema output (1 call → 6 signals)
- Daily cap via F06 org budget

### Latency

- Seed on org create: async background <5s
- Enable signal: trigger F06 backfill async (user confirms cost)

---

## 7. Acceptance criteria

- [ ] New org has 6+ signals enabled without user action
- [ ] Frustration fires on fixture trace
- [ ] Multi-schema investigator ≤1 LLM call per trace
- [ ] Disable signal stops worker immediately

---

*Feeds F06; pairs with F34 for trained variants.*
