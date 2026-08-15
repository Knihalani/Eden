# Publishing `eden-sdk` to PyPI

These are the exact commands to publish the Python SDK to PyPI as `eden-sdk`.

## Prerequisites

```bash
# 1. Make sure you have a PyPI account and an API token:
#    https://pypi.org/manage/account/token/
# 2. Use Python 3.10+ (the wheel declares `requires-python = ">=3.10"`).
#    If `python3` on your system is 3.9 (macOS default), use the
#    repo's venv or any Python 3.10+ interpreter:
#      /Users/kaiavnihalani/Downloads/Eden/.venv/bin/python   # Python 3.12
#      python3.10 / python3.11 / python3.12
# 3. Install the build tooling:
python3 -m pip install --upgrade build twine setuptools wheel
# 4. Configure your PyPI credentials (one-time setup):
#    Use either a keyring entry (`keyring set https://upload.pypi.org/legacy/ __token__`)
#    or an API token via env var (less safe):
export TWINE_USERNAME=__token__
export TWINE_PASSWORD=pypi-...your-token-here...
```

## Pre-flight

```bash
cd sdk/python

# 1. Make sure the source builds cleanly (no `dist/` artifacts left):
rm -rf build dist *.egg-info eden_sdk.egg-info

# 2. Run the full test suite. All 98 tests must pass:
python3 -m pytest ./tests/ \
    -c ./pyproject.toml -p no:cacheprovider \
    -o "addopts=" -o "testpaths=./tests" --tb=short

# 3. Lint must be clean:
python3 -m ruff check ./eden ./eden_sdk ./tests

# 4. (optional) Smoke-test the top-level import path:
python3 -c "import eden; print(eden.__version__, eden.trace, eden.instrument)"
```

## Build

```bash
cd sdk/python
python3 -m build --wheel --sdist --no-isolation
# → produces ./dist/eden_sdk-0.3.1-py3-none-any.whl
# → produces ./dist/eden-sdk-0.3.1.tar.gz
```

## Validate

```bash
# Inspect the wheel contents:
python3 -m zipfile -e dist/eden_sdk-0.3.1-py3-none-any.whl /tmp/inspect
find /tmp/inspect -type f | sort
rm -rf /tmp/inspect

# Run twine check to validate the package metadata:
python3 -m twine check dist/*
# → "Checking dist/eden_sdk-0.3.1-py3-none-any.whl: PASSED"
# → "Checking dist/eden-sdk-0.3.1.tar.gz: PASSED"
```

## Publish to Test PyPI (recommended first run)

```bash
python3 -m twine upload --repository testpypi dist/*
# Follow the prompts (or rely on TWINE_USERNAME/TWINE_PASSWORD env vars).
# This uploads to https://test.pypi.org/project/eden-sdk/

# Then verify the installable artifact:
python3 -m venv /tmp/eden-verify
source /tmp/eden-verify/bin/activate
pip install --index-url https://test.pypi.org/simple/ \
            --extra-index-url https://pypi.org/simple/ \
            eden-sdk==0.3.1
python3 -c "import eden; print('imported eden', eden.__version__)"
python3 -c "from eden_sdk import EdenClient; print('OK', EdenClient)"
deactivate
rm -rf /tmp/eden-verify
```

## Publish to PyPI (production)

```bash
python3 -m twine upload dist/*
# → Uploads to https://pypi.org/project/eden-sdk/

# Verify:
pip install eden-sdk==0.3.1
python3 -c "import eden; print('imported eden', eden.__version__)"
```

## Tag the release

```bash
cd /Users/kaiavnihalani/Downloads/Eden
git tag -a sdk-python-v0.3.1 -m "Release eden-sdk 0.1.0"
git push origin sdk-python-v0.3.1
```

## Publishing a new version

1. Bump the version in `sdk/python/pyproject.toml` (`version = "0.3.1"` → `"0.1.1"`).
2. Re-run the pre-flight and build steps above.
3. `git tag -a sdk-python-v0.1.1 -m "Release eden-sdk 0.1.1" && git push origin sdk-python-v0.1.1`.
