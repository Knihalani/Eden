# Security

This project has no API keys, cloud accounts, or paid crawl credentials.

- Do not open issues that include your local `~/.eden/know` database.
- Report vulnerabilities privately via GitHub Security Advisories on [KaiavN/eden-know](https://github.com/KaiavN/eden-know).
- Ingest honors RFC 9309 robots.txt. Do not send patches that disable robots, add Wikipedia ingest, or add a JS-rendering / paywalled fetch path.
- Know is not a sandbox. It fetches public URLs you enqueue and writes a local SQLite file plus a pack.
