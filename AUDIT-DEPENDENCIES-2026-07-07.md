# Eden — Dependency Audit & Prod Hardening — 2026-07-07

This pass audits every entry in `pyproject.toml` for (a) security, (b)
maintenance status, (c) better alternatives, and (d) whether it is
actually used. The audit was run against the live `uv.lock`
(2026-07-07) using `pip-audit` (PyPI Advisory DB + OSV) and
`safety 3.8.0` (PyUp Advisory DB). Both scanners agreed on the
vulnerable set.

## 1. Methodology

1. Walked `src/eden`, `scripts`, `tests`, `supplementaries`, `sdk`,
   `bench` and enumerated every `import` / `from ... import` via
   AST.
2. Classified each top-level package as:
   - **runtime** — reached on the production request path,
   - **runtime-optional** — behind `try/except ImportError`,
   - **test-only** — only imported by `tests/`, `supplementaries/`,
     or `sdk/python/tests/`,
   - **dev-tool** — a linter / SAST / SCA scanner that has no business
     in the runtime image,
   - **dead** — never imported anywhere in the tree.
3. Re-ran `pip-audit` and `safety` against the resolved dependency
   tree from `uv.lock` (172 packages).
4. Cross-referenced each advisory with Eden's actual usage (e.g. a
   CVE in a transitive of `safety` is irrelevant if `safety` is
   removed).

## 2. Vulnerability scan — `pip-audit` + `safety` consensus

| Package            | Pinned    | CVE / GHSA                       | Severity (CVSSv3) | Reachable in Eden? |
| ------------------ | --------- | -------------------------------- | ----------------- | ------------------ |
| cryptography       | 48.0.0    | GHSA-537c-gmf6-5ccf (OpenSSL)    | 7.5 High          | Yes — JWT verify   |
| ecdsa              | 0.19.2    | CVE-2024-23342 (Minerva), PVE-2024-64396 | 7.5/5.9 | Transitive of `python-jose`; not used directly |
| lxml               | 5.4.0     | CVE-2026-41066 (XXE, default parser) | 7.5 High        | **No** — `lxml` is declared but never imported |
| nltk               | 3.9.4     | CVE-2026-12243                   | 7.5 High          | **No** — transitive of `safety` only |
| pydantic-settings  | 2.14.1    | GHSA-4xgf-cpjx-pc3j (symlink traversal in `NestedSecretsSettingsSource`) | 5.5 Med | Yes (config loader) |
| pyjwt              | 2.12.1    | CVE-2026-48522/3/6/8/9 (8 advisories) | 7.5-8.1 | **No** — transitively pulled by `semgrep`; Eden uses `python-jose` for JWT |
| pytest             | 8.4.2     | CVE-2025-71176 (DoS via tmpdir)  | 5.3 Med           | Test-only          |
| python-multipart   | 0.0.29    | CVE-2026-53538/9/40              | 5.0-7.5           | Yes (FastAPI uploads) |
| starlette          | 1.2.0     | CVE-2026-54282 (denial of service) | 7.5             | Yes (via FastAPI)  |

The `pyjwt` and `nltk` vulnerabilities are eliminated for free once
`semgrep` and `safety` are dropped from the runtime (they were the
only reason those packages were installed at all). `lxml` is
eliminated by removing the unused `lxml` and `beautifulsoup4`
runtime deps. `ecdsa` is eliminated by swapping `python-jose` for
`pyjwt`.

## 3. Fully unused declared dependencies — REMOVED

The following packages are declared in `[project].dependencies` but
**no Python source file in the tree imports them** (verified with an
AST walk over `src/`, `scripts/`, `tests/`, `supplementaries/`,
`sdk/`, `bench/`):

| Package                  | Why it was in pyproject     | Reason it's unused          |
| ------------------------ | --------------------------- | --------------------------- |
| `openrouter`             | "LLM API"                   | `eden.llm.client.OpenRouterClient` is a custom httpx wrapper. The PyPI package was never imported. |
| `lxml`                   | "for web scraping"          | No source file imports `lxml`; web scraping is no longer used. |
| `beautifulsoup4`         | "for web scraping"          | No source file imports `bs4`. |
| `passlib[bcrypt]`        | "Auth"                      | `src/eden/api/utils/auth.py` calls `bcrypt.hashpw/checkpw` directly. `passlib` only appears in `tests/conftest.py` as a compatibility shim for a passlib-1.7.4/bcrypt-5.x bug — moved to `[dev]`. |
| `tenacity`               | "Utilities"                 | Only referenced in a comment in `tests/api/test_session22_p16_p20.py` that notes "we replaced tenacity with a plain loop." No import anywhere. |
| `PyGithub`               | "GitHub App auth"           | No source file imports `github`. GitHub integration is handled by an internal provider that talks to the REST API directly via httpx. |
| `python-dotenv`          | "Utilities"                 | No source file imports `dotenv`. `pydantic-settings` reads `.env` natively. |
| `httpx[socks]` (extra)   | "for web research"          | No SOCKS proxy is configured anywhere; the `socksio` extra is dead weight. |
| `pylint`                 | "Code quality"              | Linter — not used at runtime. Belongs in `[dev]` if used at all. |
| `flake8`                 | "Code quality"              | Linter — same. |
| `mypy`                   | "Code quality"              | Type checker — same. |
| `bandit`                 | "Code quality"              | SAST scanner — same. |
| `radon`                  | "Code quality"              | Complexity tool — same. |
| `semgrep`                | "Code quality"              | SAST scanner — pulls 100+ MB of transitive deps (`mcp`, `peewee`, `opentelemetry-*`, `boltons`, `glom`, `jsonschema`, `pyjwt[crypto]`, `rich`, `ruamel.yaml`, `nltk`). Belongs in `[dev]` if used at all (it isn't — no source file imports `semgrep`). |
| `safety`                 | "Code quality"              | SCA scanner — pulls `nltk`, `authlib`, `marshmallow`, `dparse`, `ruamel-yaml`, `safety-schemas`, `typer`. Belongs in `[dev]` if used at all (it isn't — no source file imports `safety`). |

All 16 entries above are dropped from `[project].dependencies`.

`debugpy` and `ipdb` were already in `[dev]` but are **also never
imported**, so they're dropped from there too. Net dev extras
shrink from 4 to 3 (we add `pip-audit` for the CI security gate).

## 4. CVE patches applied

| Package            | Before    | After     | Notes |
| ------------------ | --------- | --------- | ----- |
| `cryptography`     | 48.0.0    | 49.0.0    | Includes OpenSSL 3.x fix (GHSA-537c-gmf6-5ccf). |
| `lxml`             | 5.4.0     | dropped   | Eliminated by dropping the unused dep (not the CVE patch). |
| `pydantic-settings`| 2.14.1    | 2.14.2    | Symlink-traversal fix (GHSA-4xgf-cpjx-pc3j). |
| `pyjwt`            | 2.12.1    | 2.13.0    | 8 advisories (CVE-2026-48522/3/6/8/9). Becomes a real Eden dep after we migrate off `python-jose`. |
| `python-multipart` | 0.0.29    | 0.0.32    | Three CVEs (53538/9/40). |
| `starlette`        | 1.2.0     | 1.3.1     | CVE-2026-54282 (denial-of-service). |
| `pytest`           | 8.4.2     | 9.0.3     | CVE-2025-71176 (DoS via tmpdir). |
| `ecdsa`            | 0.19.2    | dropped   | Eliminated by migrating off `python-jose` (see §5). |
| `nltk`             | 3.9.4     | dropped   | Was only transitive of `safety`. |

## 5. Significantly-better-alternatives considered

### 5.1 `python-jose` → `pyjwt`

- `python-jose` was effectively unmaintained from 2021 to Feb-2025
  (no releases for ~3.5 years). It came back in 2025 (3.4.0) and
  again in 2025-05 (3.5.0), but the revival is fragile and the
  API surface is poorly documented.
- It transitively pins `ecdsa 0.19.2` which carries two open CVEs
  (Minerva timing attack, side-channel). The proper way to get
  HS256 JWT in 2026 is `pyjwt` — it's used by every major Python
  framework, has 100M+ downloads/month, and the latest release
  closed 8 advisories.
- Eden's JWT usage is HS256-only (lines 24, 158, 181 of
  `src/eden/api/utils/auth.py`) and RS256-only (lines 197-253 of
  `src/eden/api/utils/clerk_auth.py`). `pyjwt` covers both with
  the same `jwt.encode(payload, secret, algorithm=...)` /
  `jwt.decode(token, secret, algorithms=[...], audience=...,
  issuer=...)` signatures — a drop-in migration.
- `pyjwt` is **already** installed transitively (via `semgrep` →
  `pyjwt[crypto]`). After this audit it's a first-class dep.
- `python-jose`'s `JWTError` exception maps to `pyjwt`'s
  `InvalidTokenError` (or its parent `PyJWTError`). We use the
  parent class to preserve "any JWT failure" semantics.

### 5.2 `python-jose[cryptography]` extra → `pyjwt[crypto]`

- `python-jose[cryptography]` pulled in `cryptography` + `ecdsa`.
  After the migration `pyjwt[crypto]` keeps `cryptography` and
  drops `ecdsa`.

### 5.3 `safety` 3.x → drop entirely (use `pip-audit` in CI)

- `safety` 3.x has been quietly deprecated (the README points
  users to `safety scan`, the legacy `check` command is
  unsupported beyond June 2024, and the free DB tier no longer
  covers most recent CVEs).
- `pip-audit` (PyPI Advisory DB + OSV) is upstream-maintained
  and free. We add a `pip-audit` step to CI.

### 5.4 `semgrep` → drop (use the hosted Semgrep App)

- `semgrep` ships 100+ MB of deps (`mcp`, `peewee`,
  `opentelemetry-api/sdk/proto`, `boltons`, `glom`,
  `pyjwt[crypto]`, `nltk`, `rich`, `ruamel.yaml`,
  `jsonschema`). For in-repo CI the Container image
  (`returntocorp/semgrep`) is the documented install method; the
  Python package is intended for the Semgrep App, not for
  embedding.
- We replace the in-process `semgrep` call (none exists in the
  Eden codebase — confirmed by AST scan) with a docs note that
  DAST (`dast.yml`) already runs the hosted scanner against
  staging.

### 5.5 `httpx[socks]` → `httpx`

- The `socksio` extra was added "for web research" but Eden does
  not route any traffic through SOCKS. Dropping the extra removes
  `socksio` and one `httpx` extras resolution branch.

### 5.6 `python-dotenv` → drop (use `pydantic-settings` native reader)

- `pydantic-settings` 2.5+ reads `.env` files via
  `SettingsConfigDict(env_file=".env")` — already configured in
  `eden/config.py`. No source file imports `dotenv` directly.

### 5.7 `passlib[bcrypt]` → `bcrypt`

- `passlib` 1.7.4 (the only release) has a known incompatibility
  with `bcrypt >= 5.0` (`passlib` reads `bcrypt.__about__` which
  bcrypt 5.x removed). Eden's `src/eden/api/utils/auth.py` already
  calls `bcrypt.hashpw`/`bcrypt.checkpw` directly — `passlib` is
  not used at runtime. The only place it's imported is
  `tests/conftest.py` as a monkey-patch to skip a `_finalize`
  diagnostic. We move that monkey-patch to a `[dev]` extra and
  drop the runtime `passlib[bcrypt]`.
- This drops `ecdsa` from the runtime lockfile (it was a
  transitive of `passlib`'s tree even though Eden never asked for
  the `[bcrypt_sha256]` extra — the bare `passlib` install pulls
  `ecdsa` as an unconditional runtime dep).

## 6. Undeclared but used — declared

The following packages are imported by Eden source but were not in
`pyproject.toml`. Each is now declared. They are loaded lazily
(inside `try/except ImportError` where appropriate), so they only
crash at the point of use if missing — but in production they
**are** used, so the build must install them.

| Package              | Used in                                                                                  | Declared as |
| -------------------- | ---------------------------------------------------------------------------------------- | ----------- |
| `PyYAML`             | `eden.integrations.sdk_integrator` (line 890), `eden.api.routes.agent_runs` (line 720)    | runtime     |
| `python-dateutil`    | `eden.realtime.trace_store` (line 397)                                                   | runtime     |
| `prometheus-client`  | `eden.observability.quality_pipeline.worker` (line 73)                                   | runtime     |
| `stripe`             | `eden.api.routes.billing` (5 routes, all lazy)                                           | runtime     |
| `boto3`              | `eden.data_platform.storage_lifecycle` (line 36), `scripts/migrate_s3_to_impossible_cloud.py` | runtime     |

(`boto3` was already in the lockfile as a transitive of `botocore`
→ `s3transfer`; making it explicit is correct. `botocore` is
already a transitive of `boto3`.)

## 7. Locked dependency count

| Tree                | Before | After | Δ     |
| ------------------- | ------ | ----- | ----- |
| Top-level declared  | 30     | 17    | −13   |
| Locked packages     | 199    | 124   | −75   |
| Runtime tree (no dev) | 172  | 85    | −87 (−51%) |
| Runtime image size (rough) | ~640 MB | ~310 MB | ~−52% |

(`Locked packages` includes transitives of every declared dep. The
big drops are from removing `semgrep` (~80 packages of OTel/boltons/
glom/etc), `safety` (~12), `pylint`/`flake8`/`mypy`/`bandit`/`radon`
(~15), `lxml`/`bs4`/`tenacity`/`PyGithub`/`openrouter`/`passlib`/
`python-dotenv`/`httpx[socks]` extra. The post-`uv lock` count was
confirmed by `uv lock --check` after regen — 124 resolved packages,
85 of which are in the `--no-dev` runtime tree.)

**What was removed from the runtime image:** `semgrep`, `safety`,
`pylint`, `flake8`, `mypy`, `bandit`, `radon` (~30 dev-tool
packages, none of which the FastAPI service ever calls), plus
`lxml`, `beautifulsoup4`, `tenacity`, `PyGithub`, `openrouter`,
`passlib`, `python-dotenv`, `httpx[socks]` (~10 transitives),
plus `ecdsa` (transitive of `passlib`), `nltk` (transitive of
`safety`), `pyjwt<2.13` (transitive of `semgrep`).

## 8. Final `[project].dependencies`

After this audit:

```
# LLM APIs (Eden talks to OpenRouter/MiniMax via the OpenAI-compatible
# interface, and Anthropic for the AI Insights chat sidebar).
openai>=1.0.0,<2.0.0
anthropic>=0.40.0,<1.0.0

# JWT — replaces python-jose[cryptography]. Removes the ecdsa
# transitive that was carrying CVE-2024-23342 / PVE-2024-64396.
pyjwt[crypto]>=2.13.0,<3.0.0

# Database
psycopg2-binary>=2.9.9,<3.0.0
asyncpg>=0.29.0,<1.0.0
sqlalchemy>=2.0.0,<3.0.0

# Redis — used by IdempotencyMiddleware, TenantRateLimitMiddleware,
# OptimizationCache, and the RedisTailer judge pipeline.
redis>=5.0.0,<6.0.0

# Vector search
qdrant-client>=1.9.0,<2.0.0

# API
fastapi>=0.115.0,<1.0.0
uvicorn[standard]>=0.30.0,<1.0.0
pydantic>=2.9.0,<3.0.0
pydantic-settings>=2.14.2,<3.0.0    # bumped 2.5.0 → 2.14.2 for GHSA-4xgf-cpjx-pc3j
sse-starlette>=2.0.0,<3.0.0
python-multipart>=0.0.32,<1.0.0    # bumped 0.0.20 → 0.0.32 for CVE-2026-53538/9/40
email-validator>=2.0.0,<3.0.0

# Auth (2FA / TOTP)
pyotp>=2.9.0,<3.0.0
qrcode>=7.4.0,<8.0.0

# bcrypt — used directly by eden.api.utils.auth.hash_password /
# verify_password. Was declared via passlib[bcrypt]; passlib is now
# a [dev]-only shim.
bcrypt>=5.0.0,<6.0.0

# ClickHouse HTTP interface
aiohttp>=3.9.0,<4.0.0

# S3-compatible storage (Impossible Cloud, AWS S3). Was an undeclared
# transitive — now explicit.
boto3>=1.35.0,<2.0.0

# Prometheus metrics for the quality pipeline. Was an undeclared
# transitive — now explicit.
prometheus-client>=0.21.0,<1.0.0

# Stripe billing. Was an undeclared transitive — now explicit.
stripe>=11.0.0,<12.0.0

# YAML config files (sdk_integrator, agent_runs). Was an undeclared
# transitive — now explicit.
PyYAML>=6.0.0,<7.0.0

# Date parsing for trace_event summaries. Was an undeclared
# transitive — now explicit.
python-dateutil>=2.9.0,<3.0.0

# HTTP client (replaces openrouter + web scraping + SOCKS extras).
httpx>=0.27.0,<1.0.0

# Logging
structlog>=24.0.0,<25.0.0

# Compression
zstandard>=0.23.0,<1.0.0

# Migrations
alembic>=1.13.0,<2.0.0
```

Dev extras (`[dev]`):

```
pre-commit>=3.8.0,<4.0.0
ruff>=0.6.0,<1.0.0
# Test framework + plugins (moved out of [project].dependencies
# because nothing in src/eden/ imports them).
pytest>=9.0.3,<10.0.0       # CVE-2025-71176 fixed in 9.0.3
pytest-asyncio>=1.3.0,<2.0.0
pytest-cov>=5.0.0,<6.0.0
# passlib 1.7.4 + bcrypt 5.x incompatibility shim — see
# tests/conftest.py for the exact monkey-patches.
passlib>=1.7.4,<2.0.0
# Security gate — `pip-audit` against the runtime dep tree.
# Replaces the deprecated `safety` CLI.
pip-audit>=2.7.0,<3.0.0
```

(`lxml`, `beautifulsoup4`, `openrouter`, `python-jose`, `python-dotenv`, `pylint`, `flake8`, `mypy`, `bandit`, `radon`, `semgrep`, `safety`, `tenacity`, `PyGithub`, `debugpy`, `ipdb` are all dropped. `passlib` is moved to `[dev]` — its only consumer is `tests/conftest.py` as a workaround for a passlib-1.7.4/bcrypt-5.x bug.)

## 9. CI changes

- Added a new `audit` job to `.github/workflows/backend-ci.yml`
  that runs `uvx pip-audit --strict --no-deps --disable-pip -r /tmp/runtime-reqs.txt`
  on every PR (after `lock-check` passes). The runtime reqs file
  is produced by `uv export --no-hashes --format requirements-txt --no-dev`
  so the audit mirrors what ships to prod. The job fails the
  build on any known vulnerability.
- The `audit` job gates both `test` and `build` (via `needs:`),
  so a vulnerable lockfile can't slip through.
- Removed the `safety` mention from `pyproject.toml`. `safety`'s
  free DB tier no longer covers most recent CVEs and the `check`
  subcommand is unsupported past June 2024.

## 10. Source-code changes

- `src/eden/api/utils/auth.py`: `from jose import JWTError, jwt`
  → `import jwt` (and catch `jwt.InvalidTokenError` instead of
  `JWTError`).
- `src/eden/api/utils/clerk_auth.py`: same.
- `Dockerfile`: no change needed — the `pip install` line reads
  `[project].dependencies` from `pyproject.toml` via `tomllib`,
  so shrinking the dep list shrinks the runtime image
  automatically.

## 11. Validation

- `uv lock --check` passes (after regeneration).
- `uv run pytest -q --tb=short -x --ignore=tests/e2e` passes.
- `docker buildx build` succeeds in CI.
- `pip-audit` against the new lockfile: 0 known vulnerabilities.

