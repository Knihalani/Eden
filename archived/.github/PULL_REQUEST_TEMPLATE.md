## Summary

<!-- One paragraph: what does this PR change and why? -->

## Linked issues

<!-- Closes #123, fixes #456. Use "Closes" so the issue auto-closes on merge. -->

## Type of change

- [ ] Bug fix (non-breaking change that fixes an issue)
- [ ] New feature (non-breaking change that adds functionality)
- [ ] Breaking change (fix or feature that would change existing behavior)
- [ ] Refactor (no behavior change)
- [ ] Docs / test / chore

## Evolution / cost PRs

If your PR touches `src/eden/nudges/`, `src/eden/kb/ledger/`, or `src/eden/agents/evolution/`:

- [ ] Ran `python -m bench.evolution.run --suite smoke`
- [ ] Attached scorecard delta or linked nightly artifact
- [ ] Read `bench/evolution/ITERATION.md` backlog rules

## How was this tested?

<!-- Unit tests, integration tests, manual repro. -->

- [ ] Unit tests added/updated
- [ ] Integration tests pass
- [ ] E2E tests pass (if applicable)
- [ ] Manual repro in staging (if applicable)

## Checklist

- [ ] My code follows the project's style (`ruff`, `mypy`)
- [ ] I have added tests that prove my fix/feature works
- [ ] New and existing unit tests pass locally
- [ ] I have updated the relevant docs (ADR / README / roadmap)
- [ ] My changes generate no new warnings
- [ ] Any dependent changes are documented in the PR description

## Screenshots / output

<!-- If this PR changes UI or visible output, paste a screenshot. -->

## Risk assessment

<!-- What could go wrong? Migration risk? Backwards-compat? -->
