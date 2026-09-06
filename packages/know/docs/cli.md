# CLI

Private binary / `eden know` in the monorepo.

```
eden know run [--once] [--interval 20] [--cc 120] [--live 96] [--news 16]
eden know status
eden know compact
eden know dump
eden know query <text>
```

| Flag | Default | Meaning |
|---|---|---|
| `--once` | off | One ingest tick, then exit |
| `--interval` | 20 | Seconds between ticks |
| `--cc` | 120 | Common Crawl WET records kept per tick |
| `--live` | 96 | Live frontier fetches per tick |
| `--news` | 16 | CC-NEWS WARC records per tick |

`query` is operator debug against **`graph.kpk` only**. It is not wrap inject. WAL ingest does not show up until `compact`. Empty query → `{ "unknown": true }`, exit 1.

`compact` fetches the published pack (if credentials), merges WAL, rewrites the whole file in RAM, uploads with If-Match. `dump` does that and prints path, bytes, SHA-256, public URL.

Agents get facts via wrap inject (system note) or `Eden.know`.

## Env

| Variable | Effect |
|---|---|
| `EDEN_KNOW_DIR` | Graph directory (default `~/.eden/know`) |
| `EDEN_HOME` | Parent of `know/` if `EDEN_KNOW_DIR` is unset |
| `EDEN_KNOW=0` | Disable wrap inject |
| `EDEN_KNOW_S3=0` | Compact/dump stay local (no fetch/upload) |
| `AWS_ACCESS_KEY_ID` / `AWS_SECRET_ACCESS_KEY` | Impossible Cloud (see [data.md](data.md)) |
| `EDEN_KNOW_INTERVAL` / `EDEN_KNOW_CC` / `EDEN_KNOW_LIVE` / `EDEN_KNOW_NEWS` | Worker (`src/worker.ts`) tick caps |
| `EDEN_KNOW_CC_SLICES` | Consecutive latest-crawl WET files per tick (default 2) |
| `EDEN_KNOW_LIVE_CONC` | Parallel live fetches (default 64; worker 12 on 512 MB) |
| `PORT` | Health HTTP for the always-on worker (default 8080) |
