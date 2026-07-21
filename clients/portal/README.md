# Eden Portal

Next.js web platform for Eden observability and improvement.

## Local

```bash
cd clients/portal
bun install
bun run dev
```

Requires Clerk keys and `NEXT_PUBLIC_API_URL` (see `.env.example`). In production the browser talks to `/api/proxy`; set `API_INTERNAL_URL` to the Northflank API.

## Gates

```bash
bun run typecheck
bun run test
bun run lint:portal-clutter
bun run lint:portal-classes
bun run build
```

## Deploy

Vercel project `eden` → https://edenobservability.com

```bash
vercel deploy --prod
# or from repo root:
scripts/deploy-vercel.sh
```

Backend is Northflank (`eden-api`), not Fly.io. See `docs/deploy/cutover-checklist.md` and the root `README.md`.
