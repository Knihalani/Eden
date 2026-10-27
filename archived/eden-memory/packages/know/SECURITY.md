# Security

This project has no API keys, cloud accounts, or paid crawl credentials.

- Do not open issues that include your local `~/.eden/know` database.
- Report vulnerabilities privately via GitHub Security Advisories on [KaiavN/Eden](https://github.com/KaiavN/Eden). Do not file them on the public data repo.
- Ingest honors RFC 9309 robots.txt. Do not send patches that disable robots or add a JS-rendering / paywalled fetch path.
- Know is not a sandbox. It fetches public URLs you enqueue and writes a local SQLite file plus a pack.
- Ingest and retrieval **source is closed**. Public artifacts are graph dumps: [KaiavN/eden-know-data](https://github.com/KaiavN/eden-know-data) (file) and [Knihalani/eden-know-data](https://github.com/Knihalani/eden-know-data) (robots contact).
