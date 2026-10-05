# gitleaks default rules (vendored)

D13's secret gate starts from the gitleaks default rule set. `gitleaks.toml` is that file, byte for byte:

| | |
|---|---|
| Source | https://github.com/gitleaks/gitleaks/blob/v8.30.1/config/gitleaks.toml |
| Release | v8.30.1 (commit `83d9cd684c87d95d656c1458ef04895a7f1cbd8e`) |
| sha256 | `e163e53b9e7e8a8511e77271e2b323ed057759542a6d988258afe3a1fa329caf` |
| License | MIT, `LICENSE` in this directory |

`src/memory-secrets.ts` reads it (Bun imports TOML, and bundles it into the CLI) and translates its Go regular
expressions to JavaScript. To upgrade, replace the file with a newer release's, update this table and the pinned
hash in `src/memory-secrets.test.ts`, and run that test: it compiles every rule and checks the secret shapes.
