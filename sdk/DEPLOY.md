# Publishing the Eden SDKs

The Eden platform ships two SDKs from the same monorepo:

| SDK | Distribution name | Path | Deploy guide |
|-----|-------------------|------|--------------|
| Python | `eden-sdk` on PyPI | `sdk/python/` | [sdk/python/DEPLOY.md](./python/DEPLOY.md) |
| TypeScript | `@eden-ai/sdk` on npm | `sdk/ts-ai/` | [sdk/ts-ai/DEPLOY.md](./ts-ai/DEPLOY.md) |

## TL;DR

### Python (`eden-sdk`)

```bash
cd sdk/python
rm -rf build dist *.egg-info
python3 -m pytest ./tests/ -c ./pyproject.toml -p no:cacheprovider \
    -o "addopts=" -o "testpaths=./tests" --tb=short   # → 131 passed
python3 -m ruff check ./eden ./eden_sdk ./tests        # → All checks passed!
python3 -m build --wheel --sdist --no-isolation
python3 -m twine check dist/*                          # → PASSED
python3 -m twine upload --repository testpypi dist/*   # Test PyPI
python3 -m twine upload dist/*                         # Production PyPI
git tag -a sdk-python-v0.2.0 -m "Release eden-sdk 0.2.0" && git push origin sdk-python-v0.2.0
```

### TypeScript (`@eden-ai/sdk`)

```bash
cd sdk/ts-ai
rm -rf dist
bun run typecheck                                      # → tsc --noEmit (no output)
bun test                                               # → 106 pass, 0 fail
npm run build                                          # → builds dist/ + subpaths
npm publish --dry-run --cache /tmp/npm-cache          # Dry-run validation
npm publish --access public                            # Production npm
git tag -a sdk-ts-v0.2.0 -m "Release @eden-ai/sdk 0.2.0" && git push origin sdk-ts-v0.2.0
```

## Pre-flight checklist

Before tagging a release, verify the following end-to-end:

### Python
- [ ] `python -m pytest ./tests/` → 131 passed in < 5 s
- [ ] `python -m ruff check ./eden ./eden_sdk ./tests` → no errors
- [ ] `python -m build --wheel --sdist --no-isolation` produces both artifacts
- [ ] `python -m twine check dist/*` → PASSED for both
- [ ] Top-level `import eden` exposes all names in `eden.__all__`
- [ ] `eden-sdk==<version>` installs cleanly into a fresh venv
- [ ] `@eden.trace_agent` decorator runs end-to-end with `dry_run=True` and `client.sent >= 1`

### TypeScript
- [ ] `bun run typecheck` → no output (clean)
- [ ] `bun test` → 106 pass, 0 fail, 252 expect() calls
- [ ] `npm run build` produces all `dist/instrumentations/*.js + *.d.ts` files
- [ ] `npm pack --dry-run` shows the package.json `files` are included
- [ ] Deep imports via `@eden-ai/sdk/instrumentations/openai` etc. resolve from a fresh `npm install`
- [ ] Both ESM (`import`) and CJS (`require`) entry points work
- [ ] `wrapOpenAI` etc. are idempotent (double-wrap returns the same shape)

## Release checklist

1. Bump the version:
   - `sdk/python/pyproject.toml`: `version = "0.1.0"` → `"0.2.0"`
   - `sdk/ts-ai/package.json`: `"version": "0.1.0"` → `"0.1.1"`
2. Update the release notes (in this repo's root `CHANGELOG.md`, if present).
3. Run the pre-flight checklist above for the SDKs you are publishing.

### What changed in 0.2.0

- **Python**: Span API (`set_input / set_output / set_tag / set_status`),
  retry with exponential backoff + `Retry-After`, `autoInstrument` /
  `detect_installed_frameworks` (7 frameworks), `redact_on_client` safety
  net, new examples (`05_crewai`, `06_autogen`, `07_llamaindex`),
  `CHANGELOG.md`.
- **TypeScript**: Context-manager `TraceController`, retry with backoff +
  `Retry-After`, `maxQueueSize / timeoutS / disabled / redactOnClient`
  config parity, `redactPayload` safety net, `configure()` free function,
  `chatCompletion()` one-shot helper, `CHANGELOG.md`.
4. Publish to the test registries first:
   - PyPI: `python -m twine upload --repository testpypi dist/*`
   - npm: `npm publish --dry-run --registry https://registry.npmjs.org/`
5. Publish to the production registries.
6. Tag the release in git (see the TL;DR above).
7. Smoke-test the published artifact from a fresh directory.


## Post-publish smoke test

After publishing both wheels, run the top-level smoke script to
verify the redactor works end-to-end on the freshly-built
artifacts:

```bash
cd sdk/python && python -m build --wheel --sdist --no-isolation
cd ../ts-ai && npm pack && cd ..
./scripts/verify_sdks.sh
```

The script installs the wheel into a fresh venv, runs the Python
redactor smoke (`scripts/redactor_smoke.py`, 14 cases), then
installs the TS tarball into a fresh `node_modules` and runs the
TS redactor smoke (11 cases).  Exits 0 on success, 1 on any
failed assertion.
