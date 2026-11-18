# Contributing

Thanks for your interest in Eden. This file is the short version for humans;
[CLAUDE.md](CLAUDE.md) holds the detailed engineering rules (they apply to AI
agents contributing too), and [docs/TESTING.md](docs/TESTING.md) lists the
test commands.

## Getting set up

Needs [Bun](https://bun.sh) 1.4+.

```bash
bun install
bun run demo        # end-to-end demo, no API key, $0
bun run test:changed
```

## Before opening a pull request

- One change per PR, branched from up-to-date `main`.
- Tests first for behaviour changes; eval scenarios for engine behaviour.
- The gate before merge, on the final tree (CI is local; GitHub Actions is
  off):

  ```bash
  CHECK_COLD=1 bun run check   # format, typecheck and tests, no caches
  bun run eval                 # paste the JSON in the PR if engine behaviour changed
  ```

- Update `docs/` in the same PR when behaviour, a decision or the roadmap
  changes. Decisions live in [docs/DECISIONS.md](docs/DECISIONS.md); regenerate
  the index with `bun run decisions:index` after touching it (never hand-edit
  `docs/DECISION-INDEX.md` or `docs/DEAD-ENDS.md`).
- Keep changes minimal and follow the surrounding style: 120-column limit,
  comments explain why.
- Never commit `.env`, credentials or real user data. Text that is stored,
  indexed, logged or sent to a model must pass `sanitizeForStore` first — see
  the engineering rules in [CLAUDE.md](CLAUDE.md) (read-only sources, per-user
  isolation, model last, honest numbers).

## Where things are

Each package has its own `CLAUDE.md` with files, rules and quick tests
(`packages/<name>/CLAUDE.md`); the README's repository table maps the tree.

## License

By contributing you agree that your contributions are licensed under the
project's [MIT License](LICENSE).
