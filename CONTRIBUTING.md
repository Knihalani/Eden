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

# Install (Python 3.12+)
python -m venv .venv
source .venv/bin/activate
pip install -e ".[dev]"

# Apply DB migrations (requires postgres running)
alembic upgrade head

# Run tests
pytest tests/unit/

# Run lint
ruff check src/ tests/
mypy src/eden
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
