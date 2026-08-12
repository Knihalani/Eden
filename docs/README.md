# Eden Docs site

Docusaurus app for https://docs.edenobservability.com (Vercel project rooted here).

## Commands

```bash
bun install --frozen-lockfile   # or: npm ci
bun run start                   # local preview
bun run build                   # output → build/
```

## Raw markdown endpoints

Published HTML pages also ship as static `.md` files for agent-friendly
discovery (alongside `static/llms.txt`).

Convention (see `plugins/markdown-endpoints.js`):

| HTML route | Markdown URL |
|---|---|
| `/quickstart` | `/quickstart.md` |
| `/how-to/deploy` | `/how-to/deploy.md` |
| `/how-to` (section index) | `/how-to.md` |
| `/` (docs home) | `/index.md` |

Source is copied from `docs/**/*.{md,mdx}` after build, using the same
`exclude` list as the docs preset (internal trees like `observability/`
are not published). Frontmatter is kept. Vercel sets
`Content-Type: text/markdown; charset=utf-8` for `*.md` via `vercel.json`.
