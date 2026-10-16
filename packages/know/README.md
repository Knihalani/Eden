# @eden/know (private)

> **Retired side line.** Eden Know belongs to the compile era. Its code still builds and its tests still run, but Eden is now passive memory for coding agents ([README](../../README.md)); the Know product document is in [archived/compile-era/](../../archived/compile-era/README.md).

Ingest and retrieval **source is closed**. The **graph dumps** are open — see [docs/data.md](docs/data.md). This tree **encodes KPK9/KG12** as **one file**: 8,299 facts (hot RFC titles, IETF area column, edges, catalogs, capitals) inside `graph.kpk`. The public Get on GitHub is still the **KPK8 15,317 B** freeze until operators compact. Impossible Cloud holds the operator replica (no anonymous GetObject).

Know crawls **robots-ok** public pages (RFC 9309, `Edenbot/0.1`), including Wikipedia, plus catalogs and Common Crawl WET. Listed paywalls are skipped. The live frontier starts from known seeds and expands to every allowed URL it finds.

The agent SDK does not bundle the graph. Wrap looks at the prompt / chain-of-thought and injects **one** grounded fact card (≤48 tokens) as a system note, or stays silent. `Eden.know(q)` is the explicit, fail-open call. Query does not open SQLite.

```
bun packages/know/src/cli.ts run --once
bun packages/know/src/cli.ts dump
bun packages/know/src/cli.ts query "RFC 3986"
```

`query` reads `graph.kpk` only. Ingest is invisible until `compact`.

Default dir: `~/.eden/know`. Do not commit `*.sqlite` / `*.kpk`.
