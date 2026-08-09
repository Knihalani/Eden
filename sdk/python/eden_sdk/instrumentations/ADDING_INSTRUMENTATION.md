# Adding a Python auto-instrumentation

The framework list in `__init__.py` (`__all__`) is a **living target** — new LLM
app frameworks ship continuously. Use this checklist whenever you add support
so Python's coverage advantage over the TS SDK does not quietly erode.

## Prerequisites

1. Confirm the library has a public, stable enough API (client class / method
   names that monkey-patching can target).
2. Prefer instrumenting the lowest common call site (e.g. `client.chat.completions.create`)
   rather than every convenience wrapper.
3. Check whether the framework already emits OpenTelemetry GenAI spans — if it
   does, prefer dual-emit / attribute enrichment over a full re-implementation.

## Checklist

- [ ] **Detect-or-no-op.** `install()` must be a no-op when the library is not
      importable (do not raise at import time). Mirror an existing module such as
      `openai.py` or `anthropic.py`.
- [ ] **Monkey-patch pattern.** Patch the class/method once; keep an
      `uninstall()` that restores originals. Avoid wrapping twice.
- [ ] **Emit Eden spans.** Use the same helper path existing instrumentations use
      (`eden.trace` / internal span helpers) so attributes stay consistent
      (`gen_ai.*`, model, tokens, latency).
- [ ] **Register.** Add the module name to `__all__` in
      `eden_sdk/instrumentations/__init__.py` (lazy `__getattr__` loads it).
- [ ] **Extras.** If the framework needs an optional dependency group, add it to
      `sdk/python/pyproject.toml` extras and mention it in `sdk/python/README.md`.
- [ ] **Tests.** Add a unit test that:
      - imports the module without the framework installed (no-op path), and
      - with a stubbed client, asserts `install()` wraps the target method and
        `uninstall()` restores it.
- [ ] **Docs.** Update the framework list / install examples in
      `sdk/python/README.md`. Keep the count accurate.
- [ ] **Smoke.** `python -c "import eden; eden.instrument()"` still returns in
      well under a second with no optional frameworks installed (eager-import
      lock-in test must keep passing).

## When *not* to add a framework

- Pure TypeScript / browser SDKs — document in the TS SDK instead.
- Abandoned / pre-1.0 libraries with weekly breaking renames — wait for stability.
- Frameworks that only wrap OpenAI/Anthropic without their own client surface —
  the underlying instrumentation usually already covers them.

## Review questions

1. Does uninstall restore every patched symbol?
2. Are secrets (API keys, raw prompts under redaction policy) kept out of span
   attributes by default?
3. Did you update `__all__` *and* the README list in the same PR?
