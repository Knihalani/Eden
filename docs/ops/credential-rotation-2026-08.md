# Credential rotation runbook — 2026-08 committed-.env incident

| Field | Value |
|---|---|
| **Incident** | `.env` containing live credentials was committed to git history (first seen in the pre-batch land commits; last touched by "Update .env"). History purged with `git filter-repo --invert-paths --path .env` on 2026-08-04. |
| **Blast radius** | Anyone with a clone of the repo (or access to the GitHub remote before the purged history was force-pushed) has every value listed below. **Rotation is the actual control — the purge is hygiene.** |
| **Status** | History purged locally across all 150 branches; force-push to `origin` pending operator approval. Rotation: ☐ not started (tick each row as done). |

## What leaked and where to rotate it

Work top-to-bottom; the order minimizes downtime.

| ☐ | Credential | Where to rotate | Notes |
|---|---|---|---|
| ☐ | `OPENROUTER_API_KEY` | openrouter.ai → Keys → revoke + re-issue | Update Northflank `eden-required` secret group. Internal LLM calls fail closed while stale. |
| ☐ | `POSTGRES_PASSWORD` / `DATABASE_URL` | Neon console → role password reset | Update Northflank secrets + any local `.env`. PgBouncer picks up on reconnect. |
| ☐ | `TYPESENSE_API_KEY` | Typesense server config (self-hosted: rotate `api-key` and restart; cloud: console) | Search returns errors while stale — deploy new key to API + workers together. |
| ☐ | `JWT_SECRET` | Generate new 256-bit value; update deployment secrets | **Invalidates all active sessions/tokens.** Do in a low-traffic window; users re-authenticate via Clerk. |
| ☐ | `ENCRYPTION_KEY` | Generate new value — **but audit first** | Anything encrypted at rest with the old key (e.g. per-org gateway upstream keys in `org_gateway_models`) must be re-encrypted. Audit `src/eden` usages of the setting, write a re-encryption migration, then rotate. Do NOT rotate blind — data becomes unreadable. |
| ☐ | `EDEN_STORAGE_SECRET_KEY` (+ access key) | S3-compatible provider console | Update deployment secrets; bronze sink / media store / cold archive all use it. |
| ☐ | Upstash Redis URL/token (if present in any committed `.env` version) | Upstash console → reset token | Cheap to rotate; do it as belt-and-braces. |
| ☐ | GitHub App private key (`eden-observability.2026-07-31.private-key.pem`) | GitHub → App settings → generate new private key, revoke old | The key was **never committed** (gitignored) but sat loose in a synced Downloads folder; it has been moved to `~/eden-secrets-offrepo/`. Rotate as belt-and-braces, then store only in the deployment secret store (`github_app_private_key` setting takes PEM content, not a path — `src/eden/config.py:881`). |

## Post-purge steps (operator)

1. Approve/perform the force-push of rewritten history:
   `git push --force --all origin && git push --force --tags origin`
2. Ask any collaborators to re-clone (their local clones still contain the secret history and will re-introduce it if they push).
3. GitHub support can be asked to clear cached views/PR diffs of the old commits if desired.
4. Verify: `git log --all --oneline -- .env` → empty; weekly `secret-scan.yml` full-history job → green.
5. Keep the pre-purge safety bundle (`../eden-pre-purge-backup.bundle`) somewhere private until rotation is complete, then delete it (it contains the secret history).

## Guards now in place

- `.github/workflows/secret-scan.yml` — gitleaks on every PR/push + weekly full-history scan (config: `.gitleaks.toml`).
- `tests/security/test_secret_hygiene.py` — `.env` / `*.pem` / `*.rdb` / `.tmp-*` can never be tracked; `.gitignore` must keep covering them.
- `tests/security/test_no_tracked_secrets.py` — pre-existing broader guard.
