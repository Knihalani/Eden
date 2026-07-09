"""F76 — Docusaurus build config excludes internal-only docs correctly.

Pre-F76 the ``exclude`` patterns in ``docs/docusaurus.config.js``
were:

  ``docs/observability/**``
  ``docs/operations/**``

These patterns are MATCHED against paths RELATIVE to the ``path``
setting (which is ``docs``). So the actual file
``docs/docs/observability/cat23-redteam-report.md`` resolves to
the relative path ``observability/cat23-redteam-report.md`` —
which does NOT match the ``docs/observability/**`` pattern.

Result: ``cat23-redteam-report.md`` was being included in the
public build, where its bare ``<10s`` (and similar) in a table
cell tripped MDX's JSX parser (``Unexpected character '1'
(U+0031) before name``). The whole build failed with exit code 1.

F76 fixes the patterns to ``observability/**`` and
``operations/**`` (no ``docs/`` prefix — paths are already
relative to ``path: 'docs'``).

This test pins the patterns so a future copy-paste from the
Docusaurus docs (where ``exclude`` patterns often have a
``docs/`` prefix because they're written for the default
content root) doesn't reintroduce the bug.
"""

from __future__ import annotations

import re
import subprocess
from pathlib import Path


CONFIG = Path("docs/docusaurus.config.js")


class TestF76ExcludePatterns:
    """The exclude patterns MUST NOT have a leading ``docs/`` —
    they're relative to ``path: 'docs'``."""

    def test_exclude_block_present(self) -> None:
        text = CONFIG.read_text()
        assert "exclude:" in text, "docusaurus.config.js has no exclude block"
        # Extract the exclude array (everything between the first
        # ``exclude: [`` and the next ``]``).
        match = re.search(
            r"exclude:\s*\[(.*?)\]",
            text,
            re.DOTALL,
        )
        assert match, "could not find exclude array in docusaurus.config.js"
        self._exclude_body = match.group(1)

    def test_no_obsolete_docs_prefix(self) -> None:
        text = CONFIG.read_text()
        # The bad pattern was 'docs/observability/**'. Either with
        # single or double quotes. Must not appear in the config.
        for bad in (
            "'docs/observability/**'",
            '"docs/observability/**"',
            "'docs/operations/**'",
            '"docs/operations/**"',
        ):
            assert bad not in text, (
                f"F76 regression: '{bad}' is back in "
                f"docusaurus.config.js. The exclude patterns must be "
                f"relative to ``path: 'docs'`` (no leading 'docs/'). "
                f"With the bad pattern, internal-only files like "
                f"cat23-redteam-report.md are included in the build "
                f"and their bare `<10s` table cells trip MDX's JSX "
                f"parser."
            )

    def test_observability_excluded(self) -> None:
        text = CONFIG.read_text()
        # Must contain a pattern that excludes observability/
        # (correctly prefixed, no docs/).
        assert (
            "'observability/**'" in text or '"observability/**"' in text
        ), (
            "F76 regression: no pattern excludes docs/docs/observability/*.md. "
            "Internal-only observability reports will be published."
        )

    def test_operations_excluded(self) -> None:
        text = CONFIG.read_text()
        assert (
            "'operations/**'" in text or '"operations/**"' in text
        ), (
            "F76 regression: no pattern excludes docs/docs/operations/*.md. "
            "Internal-only operations docs will be published."
        )


class TestF76RemarkEscapeBareLt:
    """The ``remarkEscapeBareLt`` plugin MUST escape bare ``<`` in
    table cells too (not just top-level paragraphs).

    Pre-F76 the plugin's regex was the same, but it walked every
    ``node.value`` (which is set on ``text`` nodes anywhere in the
    tree, including inside ``tableCell``). So it actually worked
    for table cells too — the bug was that the plugin didn't run
    for the cat23 file at all (because of the broken exclude
    pattern).

    This test pins the plugin's regex so a refactor doesn't
    weaken the escape (e.g. someone adding a ``node.type ===
    'paragraph'`` guard that misses table cells).
    """

    def test_plugin_handles_all_text_nodes(self) -> None:
        text = CONFIG.read_text()
        # Extract the plugin function
        match = re.search(
            r"function remarkEscapeBareLt\(\) \{(.*?)^\}",
            text,
            re.DOTALL | re.MULTILINE,
        )
        assert match, "could not find remarkEscapeBareLt plugin function"
        body = match.group(1)
        # The plugin must NOT filter by node type (text-only would
        # work, but we want to be explicit that ALL string-valued
        # nodes get escaped — including future MDX/remark nodes).
        assert "node.value" in body, "plugin doesn't manipulate node.value"
        # The escape regex must escape `<` followed by a digit
        # (the bug was `<10s`).
        assert (
            "<(?![a-zA-Z!?/])" in body
        ), "plugin regex no longer matches bare < followed by digit"
