# Feature flags + rollback runbook

## Kill switches (org / env)

| Flag | Effect when OFF | Rollback |
|------|-----------------|----------|
| `auto_issue_detection_v1` | F20 scanners idle | Set false in org features; issues remain, no new auto-detect |
| `artifacts_v1` | No Artifact inject / API returns disabled | Set `false` in org features **or** env `ARTIFACTS_V1=false` (Settings). GA default is **on**. |
| `ledger_v1` | No Ledger inject / API returns disabled | Set `false` in org features **or** env `LEDGER_V1=false`. GA default is **on**. |
| `improvement_agent_v1` | N23 weekly plans stop | Cron skips org |
| `evolution_loop_enabled` | N18 canary loop stops | Leader worker skips evolution task |
| `features.f82` | Disable Web Vitals CI enforcement | Remove workflow or set `continue-on-error` |
| `features.f84` | Hide Platform status tab | Portal-only; API remains for staff |

## Customer feature kill matrix (FinOps / W7)

Org owners toggle via `POST /orgs/{org_id}/finops/kill-switches`.
Unknown feature keys are **fail-closed** (disabled).

| `feature_key` | When disabled |
|---------------|---------------|
| `chat_sidebar` | ChatService preflight refuses turns |
| `triage` | Triage LLM path should check before spend |
| `evolution` | Evolution loop skips JudgeScorePromptEvolver |
| `online_slm` / `online_llm` | Online scorer cascade tiers |
| `judges` / `gateway` / `patches` / `embeddings` / `nudge_author` | Tagged LLM exits |

Trace-quality action classes: unknown `action_class` defaults **fail-closed**
(`Settings.get_action_default` → False).

## Global env rollback

1. Set `EDEN_WIRING_INSTALL=0` to skip `install_all` on new pods (emergency only).
2. Scale leader worker deployment to 0 — stops quality worker + evolution (ingest continues).
3. Revert portal deploy via Vercel promotion rollback.

## Verification after rollback

- `GET /health` — postgres up
- `GET /v1/internal/health` — component breakdown
- Settings → Platform status — ingest lag &lt; 60s
- `GET /orgs/{org}/finops/kill-switches` — matrix reflects kills

## Contact

See `docs/runbooks/oncall-handoff.md` for paging.
