# W3 — Public portal route probe (post-W2 re-probe)
- **Base**: `https://edenobservability.com` (local: `down (127.0.0.1:3000 and :3001)`)
- **When**: `2026-07-20T05:28:53.829Z`
- **Pass/Fail (crash/5xx rubric)**: **23/0** of 23 → **PASS**
- **Unintentional 5xx**: 0
- **Crash hits**: 0
- **/status still soft-404 on prod?**: **YES**
- **/health still soft-404 on prod?**: **YES**

## Prod vs expect (W2 status/health)
| route | expect (repo) | prod | match |
|-------|---------------|------|-------|
| `/status` | Real `Status · Eden` page | soft-404 shell (HTTP 200, `NEXT_HTTP_ERROR_FALLBACK;404`, 21570B) | **NO — undeployed** |
| `/health` | redirect → `/status` | soft-404 shell (HTTP 200, no redirect, 21570B) | **NO — undeployed** |
| `/api/health` | JSON 200 or intentional 503 degraded | 503 `json:status=degraded` (postgres connected, qdrant Errno 99) | YES |
| `/contact` | Live marketing form | 200 Get in touch + form | YES |

## Focus
- `/contact` → 200 final=`https://edenobservability.com/contact` title=`Eden — Observability + improvement for AI agents` soft404=`false` crash=`none` **PASS** (i18n-false-positive-ok)
- `/status` → 200 final=`https://edenobservability.com/status` title=`Eden — Observability + improvement for AI agents` soft404=`true` crash=`none` **PASS** (i18n-false-positive-ok; PROD_SOFT_404_vs_EXPECT_REAL_STATUS (W2 status undeployed); http200_soft404_shell)
- `/health` → 200 final=`https://edenobservability.com/health` title=`Eden — Observability + improvement for AI agents` soft404=`true` crash=`none` **PASS** (i18n-false-positive-ok; PROD_SOFT_404_vs_EXPECT_REAL_STATUS (W2 status undeployed); http200_soft404_shell)
- `/api/health` → 503 final=`https://edenobservability.com/api/health` title=`json:status=degraded` soft404=`false` crash=`none` **PASS** (intentional soft-degraded 503 JSON; health=degraded; postgres=connected; qdrant=error: [Errno 99] Cannot assign requested address)

## All routes
| route | code | soft404 | title | crash | verdict |
|-------|------|---------|-------|-------|---------|
| `/` | 200 | false | Eden — Observability + improvement for AI agents | — | PASS |
| `/about` | 200 | false | About · Eden | — | PASS |
| `/pricing` | 200 | false | Pricing · Eden | — | PASS |
| `/contact` | 200 | false | Eden — Observability + improvement for AI agents | — | PASS |
| `/changelog` | 200 | false | Changelog · Eden | — | PASS |
| `/privacy` | 200 | false | Privacy · Eden | — | PASS |
| `/terms` | 200 | false | Terms of Service · Eden | — | PASS |
| `/dpa` | 200 | false | Data Processing Addendum · Eden | — | PASS |
| `/security` | 200 | false | Security · Eden | — | PASS |
| `/subprocessors` | 200 | false | Eden — Observability + improvement for AI agents | — | PASS |
| `/do-not-sell` | 200 | false | Eden — Observability + improvement for AI agents | — | PASS |
| `/sign-in` | 200 | false | Eden — Observability + improvement for AI agents | — | PASS |
| `/sign-up` | 200 | false | Eden — Observability + improvement for AI agents | — | PASS |
| `/login` | 200 | false | Eden — Observability + improvement for AI agents | — | PASS |
| `/signup` | 200 | false | Eden — Observability + improvement for AI agents | — | PASS |
| `/forgot-password` | 200 | false | Eden — Observability + improvement for AI agents | — | PASS |
| `/reset-password` | 200 | false | Eden — Observability + improvement for AI agents | — | PASS |
| `/invite/probe-token-w3` | 200 | false | Eden — Observability + improvement for AI agents | — | PASS |
| `/status` | 200 | true | Eden — Observability + improvement for AI agents | — | PASS |
| `/health` | 200 | true | Eden — Observability + improvement for AI agents | — | PASS |
| `/api/health` | 503 | false | json:status=degraded | — | PASS |
| `/robots.txt` | 200 | false | User-Agent: * | — | PASS |
| `/sitemap.xml` | 200 | false |  | — | PASS |

## Focus detail
- `/contact` — **200** live marketing form (Get in touch + name/email/message + mailto). No crash.
- `/status` — **200** portal soft-404 shell (`NEXT_HTTP_ERROR_FALLBACK;404`), not a status page. **Still soft-404 after W2** (undeployed).
- `/health` — **200** same soft-404 shell (no redirect to `/status`). JSON health is `/api/health` only.
- `/api/health` — **503** intentional soft-degraded JSON (`status=degraded`, postgres connected, qdrant Errno 99). Not an unintentional portal crash.

## Comparison to W2 probe
- `/status` soft-404: **unchanged** (still YES)
- `/health` soft-404: **unchanged** (still YES)
- Byte sizes for soft-404 shells: **21570** both waves
- Crash/5xx rubric: **PASS 23/23** both waves

## Verdict
**PASS 23 / FAIL 0** under crash/unintentional-5xx rubric.
**Deploy gap:** `/status` and `/health` still soft-404 on prod — W2 status page + health alias are in the repo but **not deployed**.
