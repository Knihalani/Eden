# W2 Wave2 — Public portal route probe
- **Base**: `https://edenobservability.com` (local down)
- **When**: `2026-07-20T05:02:18.110185+00:00`
- **Pass/Fail**: **23/0** of 23
- **Unintentional 5xx**: 0
- **Crash hits**: 0

## Focus
- `/contact` → 200 final=`https://edenobservability.com/contact` title=`Eden — Observability + improvement for AI agents` crash=`none` **PASS** (i18n-false-positive-ok)
- `/status` → 200 final=`https://edenobservability.com/status` title=`Eden — Observability + improvement for AI agents` crash=`none` **PASS** (i18n-false-positive-ok)
- `/health` → 200 final=`https://edenobservability.com/health` title=`Eden — Observability + improvement for AI agents` crash=`none` **PASS** (i18n-false-positive-ok)
- `/api/health` → 503 final=`https://edenobservability.com/api/health` title=`json:status=degraded` crash=`none` **PASS** (intentional soft-degraded 503 JSON; health=degraded; postgres=connected; qdrant=error: [Errno 99] Cannot assign requested address)

## All routes
| route | code | final | title | crash | verdict |
|-------|------|-------|-------|-------|--------|
| `/` | 200 | / | Eden — Observability + improvement for AI agents | — | PASS |
| `/about` | 200 | /about | About · Eden | — | PASS |
| `/pricing` | 200 | /pricing | Pricing · Eden | — | PASS |
| `/contact` | 200 | /contact | Eden — Observability + improvement for AI agents | — | PASS |
| `/changelog` | 200 | /changelog | Changelog · Eden | — | PASS |
| `/privacy` | 200 | /privacy | Privacy · Eden | — | PASS |
| `/terms` | 200 | /terms | Terms of Service · Eden | — | PASS |
| `/dpa` | 200 | /dpa | Data Processing Addendum · Eden | — | PASS |
| `/security` | 200 | /security | Security · Eden | — | PASS |
| `/subprocessors` | 200 | /subprocessors | Eden — Observability + improvement for AI agents | — | PASS |
| `/do-not-sell` | 200 | /do-not-sell | Eden — Observability + improvement for AI agents | — | PASS |
| `/sign-in` | 200 | /sign-in | Eden — Observability + improvement for AI agents | — | PASS |
| `/sign-up` | 200 | /sign-up | Eden — Observability + improvement for AI agents | — | PASS |
| `/login` | 200 | /sign-in | Eden — Observability + improvement for AI agents | — | PASS |
| `/signup` | 200 | /sign-up | Eden — Observability + improvement for AI agents | — | PASS |
| `/forgot-password` | 200 | /forgot-password | Eden — Observability + improvement for AI agents | — | PASS |
| `/reset-password` | 200 | /reset-password | Eden — Observability + improvement for AI agents | — | PASS |
| `/invite/probe-token-w2` | 200 | /invite/probe-token-w2 | Eden — Observability + improvement for AI agents | — | PASS |
| `/status` | 200 | /status | Eden — Observability + improvement for AI agents | — | PASS |
| `/health` | 200 | /health | Eden — Observability + improvement for AI agents | — | PASS |
| `/api/health` | 503 | /api/health | json:status=degraded | — | PASS |
| `/robots.txt` | 200 | /robots.txt | User-Agent: * | — | PASS |
| `/sitemap.xml` | 200 | /sitemap.xml |  | — | PASS |

## Focus detail
- `/contact` — **200** live marketing form (Get in touch + name/email/message + mailto). No crash.
- `/status` — **200** portal soft-404 shell (`NEXT_HTTP_ERROR_FALLBACK;404`), not a status page. No 5xx / Application error.
- `/health` — **200** same soft-404 shell. JSON health is `/api/health` only.
- `/api/health` — **503** intentional soft-degraded JSON (`status=degraded`, postgres connected, qdrant Errno 99). Not an unintentional portal crash.

## Verdict
**PASS 23 / FAIL 0**. Unintentional 5xx: **0**. Crash hits (Application error / Unhandled Runtime): **0**.
