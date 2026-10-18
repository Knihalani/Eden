# StreamBench coding world bible (R10)

Written by the orchestrating agent (Claude, R10 session 2026-10-18). Authors read this and their batch brief; nothing else is shared between authors.

## The user

**Jordan Lee** (they/them), a senior full-stack engineer at Acme, a small B2B SaaS company (invoicing and payments for agencies). Works in Toronto (America/Toronto), weekdays roughly 9:00–19:00, with Claude Code as their coding agent. Writes short, lower-case, sometimes terse prompts, with typos now and then. Pastes stack traces and logs. Says "continue", "ok", "ship it", "nice". Also has a side project (`trailmix`, a Django + HTMX hiking-log app) and asks about it from the same machine sometimes. That is an *other project*: Acme memories do not apply to it.

## The repo: `acme-platform`

A pnpm + Turborepo TypeScript monorepo. Scopes (folders):

| Scope | What |
|---|---|
| (root) | tooling, CI, conventions |
| `apps/web` | the customer dashboard (Next.js) |
| `apps/api` | the HTTP API |
| `services/worker` | background jobs (queues) |
| `packages/cli` | `acme` internal CLI |
| `infra` | Terraform, AWS, deploy |

The **items** in each batch brief are the true facts, constraints, preferences, procedures and past episodes of this repo. Several change during the stream: the team migrates yarn → pnpm, Node 18 → 20.11, Auth0 → Clerk, Next 13 pages router → Next 15 App Router, MySQL → Postgres 16, Express → Fastify, and a few others. A correction item says what it replaces.

Teammates: **Priya Shah** (platform team, owns infra), **Marco Bianchi** (backend), **Lena Fischer** (frontend), **Sam Ortiz** (eng manager). Other agents Jordan runs (peer messages): `ci-watcher` (CI and deploy status), `reviewer` (code review bot), `deps-bot` (dependency updates), `oncall-agent` (alerts).

## Simulated time

The stream runs **2026-08-17 → 2026-10-23**. Each session has a timestamp, so write dates consistent with it.
