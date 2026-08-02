# Contributing to Eden

Thanks for your interest in Eden! This document covers the basics
of contributing. For deeper context, see
[`eden-development-roadmap.md`](./eden-development-roadmap.md) and
the architecture docs in `docs/ARCHITECTURE.md`.

## Code of conduct

This project follows a standard code of conduct (be respectful,
assume good faith, no harassment). Report violations to
<conduct@eden.example.com>.

## Development setup

```bash
# Clone
git clone https://github.com/eden/eden
cd eden

# Install (Python 3.12+, managed by uv)
uv sync --all-extras

# The backend test suite imports the Python SDK — install it
# editable. NOTE: `uv sync` prunes packages that are not in
# uv.lock, so re-run this after every sync.
uv pip install -e sdk/python

# Run the API locally. PYTHONPATH=src is REQUIRED once the SDK is
# installed editable: the SDK ships an `eden` import shim
# (sdk/python/eden → eden_sdk) whose .pth sorts ahead of the app's
# src/eden, so a bare `python -m eden.api.app` imports the SDK shim.
PYTHONPATH=src uv run python -m eden.api.app

# Full-stack local dev (portal + API + Clerk auth end-to-end): the API
# verifies the portal's Clerk session JWTs, so `.env` also needs
# CLERK_SECRET_KEY and CLERK_PUBLISHABLE_KEY (copy from
# clients/portal/.env.local, dropping the NEXT_PUBLIC_ prefix).
# Without them every proxied call returns 401 "Not authenticated".

# Apply DB migrations (requires postgres running)
uv run alembic upgrade head

# Run tests
uv run pytest tests/unit/

# Run lint + types (mypy is ratcheted against tests/baselines/mypy.json —
# your change must not add errors in any file)
uv run ruff check src/ --select F,B --ignore B008
uv run mypy src/eden | uv run python scripts/mypy_ratchet.py
```

## Pull request process

1. **Open an issue first** for any non-trivial change. We use the
   issue templates in `.github/ISSUE_TEMPLATE/`.
2. **Branch off `main`**. Use a descriptive branch name:
   `fix/audit-log-race` or `feat/insights-correlation`.
3. **Keep PRs focused.** One feature / one fix per PR. If you find
   an unrelated issue while working, file it as a separate PR.
4. **Tests are required.** New code ships with unit tests. Bug
   fixes ship with a regression test.
5. **CI must be green.** The PR template's checklist is enforced
   by the branch protection rules in `docs/BRANCH_PROTECTION.md`.
6. **Two approvals required** for `main`. The CODEOWNERS file
   routes you to the right team automatically.
7. **Squash-merge.** Use a Conventional Commits-style message
   (`feat:`, `fix:`, `docs:`, `test:`, `chore:`, `refactor:`).

## Code style

- Python: `ruff` (lint + format), `mypy` (types).
- TypeScript: `eslint` + `prettier` (see `clients/portal/`).
- SQL: 4-space indent, lowercase keywords, explicit `IF NOT EXISTS`.

## Architecture decisions

We keep ADRs in `docs/adr/` (one per significant decision). When
your PR introduces a new pattern, write an ADR in the same PR.

## Release process

- `main` is always shippable.
- We cut a release weekly on Tuesdays.
- Versioning follows semver.
- Releases are tagged by the maintainer on duty; see
  `docs/runbooks/release.md` (TODO).

## Questions?

- Open a Discussion in `.github/DISCUSSIONS.md`.
- Or join the community Discord (link in the README).
