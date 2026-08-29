# CLI

Binary: `eden-know` (this repo). In the private Eden monorepo the same function is `eden know`.

```
eden-know run [--once] [--interval 45] [--cc 30] [--live 5]
eden-know status
eden-know compact
eden-know query <text>
```

| Flag | Default | Meaning |
|---|---|---|
| `--once` | off | One ingest tick, then exit |
| `--interval` | 45 | Seconds between ticks (`0` still waits at least 5s) |
| `--cc` | 30 | Common Crawl WET records per tick |
| `--live` | 5 | Live frontier fetches per tick |

`status` prints JSON: dir, crawl id, schema version, sqlite+pack bytes, node counts.

`query` prints a fact card JSON or `{ "unknown": true }`. Empty text is unknown and exit 1.

## Env

| Variable | Effect |
|---|---|
| `EDEN_KNOW_DIR` | Graph directory (default `~/.eden/know`) |
| `EDEN_HOME` | Parent of `know/` if `EDEN_KNOW_DIR` is unset |

Do not point this at wrap’s data dir.
