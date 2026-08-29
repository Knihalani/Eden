# @eden/know

MIT. Public-web ingest onto a compact knowledge graph. Agents get a fact card or `{ "unknown": true }`.

This repository is **only Know**. It does not contain Eden wrap/compile, control, or the product website.

```
bun add github:KaiavN/eden-know
# or clone and:
bun test
bun src/cli.ts status
bun src/cli.ts query "RFC 3986"
bun src/cli.ts run --once
bun src/cli.ts compact
```

Binary: `eden-know`.

## Docs

| | |
|---|---|
| [Architecture](docs/architecture.md) | WAL vs pack, query contract |
| [Ingest](docs/ingest.md) | Robots, catalogs, what is out |
| [CLI](docs/cli.md) | Commands, flags, env |
| [Contributing](CONTRIBUTING.md) | How to send a patch |
| [Security](SECURITY.md) | Advisories, robots, no local DB in issues |

## What this is

Know crawls **allowed** public pages (RFC 9309 robots, User-Agent `Edenbot/0.1`), plus catalog feeds (RFC index, W3C, IANA, SPDX, Unicode, Common Crawl WET over HTTPS). It stores entities and relations in SQLite while ingesting, then freezes them into a small pack (`graph.kpk`). Query time writes **one grounded card** (≤48 tokens) or unknown. Sources stay off the wire.

Paywalled and Wikipedia-family hosts are skipped. There is no search UI.

## Data on disk

Default dir: `~/.eden/know` (`EDEN_KNOW_DIR` or `EDEN_HOME` override). That directory is yours; it is not this repo. Do not commit `*.sqlite` or `*.kpk`.

## License

MIT. See `LICENSE`.
