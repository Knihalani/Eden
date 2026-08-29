# Contributing

Know is a standalone MIT package. PRs go to [KaiavN/eden-know](https://github.com/KaiavN/eden-know), not the private Eden wrap repo.

## Setup

- Bun ≥ 1.1
- `bun test` from this directory (or `bun test packages/know` in the monorepo)

## Rules that will get a patch rejected

- Do not import wrap, compile, control, or the product site
- Do not ingest Wikipedia / Wikimedia / Wikidata
- Do not add Playwright, a paid HTML renderer, or a robots bypass
- Do not commit `*.sqlite`, `*.kpk`, `.env`, or `~/.eden/know`
- Do not add ISO 3166 / country-capital catalogs (ungrounded geo stays `{ "unknown": true }`)

## Where to change things

| Change | Files |
|---|---|
| New IANA/SPDX/Unicode parser | `src/names.ts` (subject shape) + the catalog module + a test |
| Query card text | `src/query.ts` only. Keep facts ≤48 tokens, or unknown |
| On-disk graph | `src/pack.ts` (KPK5 encode). Decode must still read KPK1–KPK4 |
| WAL / compact | `src/store.ts`. Compact must verify decode before wiping nodes |
| User-Agent | `src/ua.ts` — keep the public repo URL |

## PR checklist

- [ ] `bun test` green
- [ ] New catalog aliases are lean (do not alias every media subtype)
- [ ] Docs stay in `docs/` here. Product-1 wrap docs do not belong in this repo
