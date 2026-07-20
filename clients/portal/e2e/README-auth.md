# Signed-in E2E auth (Option 2)

Clerk blocks **Playwright's bundled Chromium** on production with:

> "This browser is not supported and may be insecure"

Use one of these flows instead.

## Required environment variables

| Variable | When | Purpose |
|----------|------|---------|
| `CLERK_SECRET_KEY` | Local seed + CI | Clerk Backend API / `@clerk/testing` ticket sign-in (`sk_test_…`) |
| `NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY` | Local seed + CI | Must match the secret's Clerk instance (`pk_test_…`); baked at **build** time |
| `BASE` / `BASE_URL` | All e2e | Portal origin (default `http://127.0.0.1:3000`). Auth cookies must match this host |
| `CLERK_TEST_EMAIL` | Optional local seed | Test user for `seed-auth.mjs` ticket strategy |
| `CLERK_TEST_KEY_FALLBACK=1` | CI / local convenience | Allow committed `pk_test`/`sk_test` fallback when secrets are unset |
| `GOLDEN_CI=1` | CI golden job | Missing / domain-mismatched `e2e/.auth-state.json` → **exit 1** |
| `GOLDEN_ALLOW_FAIL=1` | Local exploratory only | Soft-exit 0 after path failures — **never set in CI** |

Do **not** commit `e2e/.auth-state.json`, live `sk_live_` / `pk_live_` keys, or production passwords.

## A. Production (`edenobservability.com`) — real Chrome

```bash
cd clients/portal
BASE=https://edenobservability.com node e2e/wait-for-signin.mjs
```

This launches **your installed Google Chrome** (not Playwright Chromium). Sign in manually in that window.

If Chrome is not installed, try Edge:

```bash
PW_CHANNEL=msedge BASE=https://edenobservability.com node e2e/wait-for-signin.mjs
```

Then run the audit / golden paths against the **same** BASE:

```bash
BASE=https://edenobservability.com node e2e/portal-audit.mjs
BASE=https://edenobservability.com node e2e/golden/golden-paths.spec.mjs
```

## B. Production — Playwright codegen (alternative)

Opens an inspector-linked browser; sign in, then close to save cookies:

```bash
cd clients/portal
npx playwright codegen \
  --channel=chrome \
  --save-storage=e2e/.auth-state.json \
  https://edenobservability.com/sign-in
```

Navigate to `/dashboard`, confirm you're signed in, close the window.

## C. Local / CI — automated Clerk testing token

Only works when the portal uses **test** Clerk keys (`pk_test_…`) on localhost:

```bash
# Required: CLERK_SECRET_KEY + NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY in .env.local
# (or export them). Rebuild if you changed NEXT_PUBLIC_* keys.
cd clients/portal
node e2e/golden/seed-auth.mjs
GOLDEN_CI=1 node e2e/golden/golden-paths.spec.mjs
```

`seed-auth.mjs` **refuses non-local BASE** (use wait-for-signin for real domains).

Manual local sign-in alternative:

```bash
BASE=http://127.0.0.1:3000 node e2e/wait-for-signin.mjs
# or full auto-fill:
node e2e/headed-signin.mjs
```

Requires `@clerk/testing` (devDependency).

## D. Golden paths exit honesty

| Situation | Exit code |
|-----------|-----------|
| Path assertion failures (default) | **1** |
| `GOLDEN_ALLOW_FAIL=1` (local soft report only) | 0 (with warnings) |
| `GOLDEN_CI=1` + missing auth state | **1** |
| `GOLDEN_CI=1` + localhost auth against prod BASE | **1** (domain mismatch) |
| `seed-auth.mjs` failure / missing Clerk env | **1** (CI job fails before golden) |

W2-07 evidence: 8/8 paths failed on prod with localhost cookies but the runner still printed `EXIT:0` when `GOLDEN_CI` was unset. That soft-pass is fixed — failures exit 1 unless you explicitly set `GOLDEN_ALLOW_FAIL=1`.

## Why production is different

| | Local (`pk_test_`) | Production (`pk_live_`) |
|--|-------------------|-------------------------|
| `setupClerkTestingToken()` | Works | **Does not work** |
| Playwright Chromium | Works with token | **Blocked by Clerk** |
| Real Chrome (`PW_CHANNEL=chrome`) | Works | **Works** (manual sign-in) |
| `seed-auth.mjs` | Supported | **Refused** — use wait-for-signin |

## Output

Both flows write `e2e/.auth-state.json` (gitignored). Do not commit it.
