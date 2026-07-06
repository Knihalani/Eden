# CLI Deploy & Status

**Audience:** anyone who needs to (re)deploy Eden to Vercel or Northflank from their laptop instead of waiting for the GitHub integration.

**One-shot commands:**

```bash
# Status: which commit is currently deployed?
scripts/deploy-status.sh

# Vercel (Next.js portal)
scripts/deploy-vercel.sh                  # production deploy
scripts/deploy-vercel.sh --preview        # preview URL
VERCEL_TOKEN=... scripts/deploy-vercel.sh # non-interactive / CI

# Northflank (FastAPI + worker + cron + Postgres)
scripts/deploy-northflank.sh                    # apply manifest + follow logs
scripts/deploy-northflank.sh --no-logs          # apply manifest, exit
scripts/deploy-northflank.sh --project eden-prod
NF_API_TOKEN=... scripts/deploy-northflank.sh   # non-interactive / CI
```

All three scripts are shellcheck-clean (run `bash -n` to verify) and update
`.deploy-sha` after a successful deploy so `deploy-status.sh` can report
up-to-date-ness.

## Why these scripts exist

- **The Vercel GitHub App integration is the "normal" path** — pushes to
  `main` trigger a build automatically. We've had multi-week stales where
  `.deploy-sha` is hundreds of commits behind HEAD, so a manual CLI escape
  hatch is essential.
- **`vercel deploy` from CLI requires `vercel login`** (token persisted to
  `~/.vercel/auth.json`) or a `VERCEL_TOKEN` env var. The script supports
  both.
- **Northflank has no GitHub auto-deploy.** `northflank combine --path ./northflank.yml`
  is the canonical reconciliation step. It's idempotent and safe to re-run.

## Vercel: what changed (2026-07-06)

Two config fixes that should make the next `vercel deploy --prod` succeed
even on this two-weeks-stale tree:

1. **`clients/portal/next.config.ts`** now pins `turbopack.root` and
   `outputFileTracingRoot` to the portal directory. Without this, Next.js 16
   walks upward looking for lockfiles and emits:

   > We detected multiple lockfiles and selected the directory of
   > /Users/kaiavnihalani/pnpm-lock.yaml as the root directory.

   On Vercel's build machine, the same heuristic can pick the wrong lockfile
   and fail the install step.

2. **`vercel.json`** install command now wraps the install with a fallback:

   ```
   bun install --frozen-lockfile || (echo ...warning && bun install)
   ```

   `--frozen-lockfile` exits 1 when `bun.lock` has drifted even slightly
   from the manifest. The fallback logs the drift so it's visible in build
   output, then re-installs without the flag.

See `.vercel/output/diagnostics/cli_traces.json` for the last failed build
trace (Jul 2, 2026 21:25 UTC — `vc.builder.install` exited 1).
