# Signed-in E2E auth (Option 2)

Clerk blocks **Playwright's bundled Chromium** on production with:

> "This browser is not supported and may be insecure"

Use one of these flows instead.

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

Then run the audit:

```bash
BASE=https://edenobservability.com node e2e/portal-audit.mjs
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

## C. Local dev — automated Clerk testing token

Only works when the portal uses **test** Clerk keys (`pk_test_…`), e.g. `bun dev` with `.env.local`:

```bash
BASE=http://127.0.0.1:3000 node e2e/wait-for-signin.mjs
# or full auto-fill:
node e2e/headed-signin.mjs
```

Requires `@clerk/testing` (optional devDependency).

## Why production is different

| | Local (`pk_test_`) | Production (`pk_live_`) |
|--|-------------------|-------------------------|
| `setupClerkTestingToken()` | Works | **Does not work** |
| Playwright Chromium | Works with token | **Blocked by Clerk** |
| Real Chrome (`PW_CHANNEL=chrome`) | Works | **Works** (manual sign-in) |

## Output

Both flows write `e2e/.auth-state.json` (gitignored). Do not commit it.
