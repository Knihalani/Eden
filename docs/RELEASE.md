# Release

Publishing is a deliberate act by the owner (names, versions, licence, support — D853). Everything below runs from a
clean checkout on `main` after `CHECK_COLD=1 bun run check` passes.

## Version bumps

Set a real version before publishing — both SDKs stay at `0.0.0` in the repo:

- `packages/client/package.json` → `version` for `@eden/client` (npm)
- `packages/client-python/pyproject.toml` → `version` for `eden-client` (PyPI)

## Dry run

`bun run publish:check` builds every artifact and runs each registry's dry run (npm pack/publish --dry-run,
sdist+wheel + `twine check`, docker build + healthz) without uploading anything.

## Publish

```
bun run publish -- --yes            # npm + PyPI
bun run publish -- --yes --npm      # npm only
bun run publish -- --yes --pypi     # PyPI only
```

- **npm**: needs `NPM_TOKEN` in the environment (org secrets). `packClient` writes the standalone package to
  `dist/publish/eden-client`; a `.npmrc` with `//registry.npmjs.org/:_authToken=${NPM_TOKEN}` is staged inside it,
  `npm publish --access public` runs, and the file is deleted — the token is never echoed or committed.
- **PyPI**: needs `PYPI_TOKEN` and `pip install build twine` (or `PYTHON=/path/to/venv/bin/python`). `twine upload`
  runs with `TWINE_USERNAME=__token__`/`TWINE_PASSWORD=$PYPI_TOKEN`.

Without `--yes` the script prints what it would publish and exits.

## Tag

`git tag v<npm-version> && git push --tags` after a publish lands.
