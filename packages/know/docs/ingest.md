# Ingest

User-Agent: `Edenbot/0.1 (+https://github.com/KaiavN/eden-know; know-ingest)` (`src/ua.ts`).

## Allowed sources

- Newest Common Crawl WET over HTTPS (no key)
- Live frontier URLs after RFC 9309 `robots.txt`
- Catalog XML/JSON: RFC index, W3C, IETF related, IANA registries, SPDX, WHATWG, Unicode blocks/scripts, IANA language (2-letter)

JS-heavy pages use JSON-LD / Open Graph / `<noscript>` in the first HTML. There is no Playwright and no paid render API.

IANA catalog fetches may run in parallel over HTTP. SQLite `commitCatalog` is sequential.

## Explicitly out

- Wikipedia, Wikimedia, Wikidata, Wiktionary
- Listed paywall hosts (`src/extract.ts`)
- IANA ports (too many, low query value)
- Country/capital tables (Kenya and friends stay unknown unless a persistable page said so)

## Disk

Default dir `~/.eden/know`, overridable with `EDEN_KNOW_DIR` or `EDEN_HOME`. Auto-compact when `wal_nodes >= 1024`.
