# Contributing to Eden

Thanks for your interest in Eden! This guide covers local development setup
and the contribution workflow.

## Local setup

### Prerequisites

* Python 3.12 (`uv` recommended — `pip install uv`).
* Node.js 22 + Bun 1.x.
* Postgres 16 (or a Neon dev branch).
* Redis 7+ (or Upstash free tier).
* Qdrant (local Docker or Qdrant Cloud free tier).

### Clone + install

```bash
git clone git@github.com:KaiavN/eden.git
cd eden
uv venv && source .venv/bin/activate
uv sync
# Migrations
alembic upgrade head
# Pre-commit
uv run pre-commit install
```

### Run the tests

```bash
# Backend
uv run pytest tests/unit tests/intelligence tests/api -q
# Portal
cd clients/portal && bun install && bun test
```

### Run the app locally

```bash
# Backend (terminal 1)
uv run uvicorn eden.api.app:app --reload
# Portal (terminal 2)
cd clients/portal && bun run dev
# Open http://localhost:3000
```

## Workflow

1. **Branch off `main`**: `git checkout -b yourname/short-description`
2. **Write code + tests.** All new code MUST have test coverage. The
   project's `pytest` suite runs in <3 minutes; please run it locally
   before pushing.
3. **Lint + typecheck**:
   ```bash
   uv run ruff check src/ tests/
   uv run mypy src/
   cd clients/portal && bun run lint && bun run typecheck
   ```
4. **Commit** with a clear message (Conventional Commits encouraged but
   not enforced).
5. **Push + open a PR** against `main`. Fill out the PR template.
6. **CI** runs the full test suite + linters. A maintainer reviews
   within 2 business days.

## Code style

* Python: ruff + mypy (strict). Black-compatible formatting.
* TypeScript: ESLint + Prettier (auto-formatted on commit).
* Tests: pytest for backend, vitest + Testing Library for the portal.

## Project conventions

* **No untyped dicts in API responses** — use Pydantic models.
* **No raw SQL** in route handlers — use the `PostgresClient` helpers.
* **No unawaited coroutines** — the agent has been burned by this; lint
  with `ruff` rule `RUF006`.
* **No new top-level dependencies** without a maintainer's approval.
  Prefer stdlib + already-installed packages.
* **PII is never logged** — see `.claude/vibecoder/security-progress.md`
  for the full audit log.

## Getting help

* Discord: <https://discord.gg/eden>
* GitHub Discussions: best for design questions.
* GitHub Issues: bug reports + feature requests.

## License

By contributing, you agree that your contributions will be licensed
under the project's MIT license.
