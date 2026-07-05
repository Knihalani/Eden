"""Empty conftest for the doctest harness.

Pytest picks the *closest* conftest.py for each test file. By
adding an empty conftest in ``tests/docs/``, the doctest harness
skips the heavy ``tests/conftest.py`` (which imports the full
FastAPI app + triggers the em-dash parse errors in pre-existing
``eden.code_change`` docstrings).

The actual doctest execution happens in a subprocess
(:func:`_run_doctests_for`), so this conftest doesn't need any
fixtures.
"""

from __future__ import annotations
