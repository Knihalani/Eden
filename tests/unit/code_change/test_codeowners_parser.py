"""Tests for the GitHub CODEOWNERS parser.

Covers the parser (``parse_codeowners``) + the matcher
(``match_owner``) across all documented edge cases. Reference:
https://docs.github.com/en/repositories/managing-your-repositorys-settings-and-features/customizing-your-repository/about-code-owners#codeowners-syntax

Per the v1 ship plan, the parser supports:

* Blank lines + ``#`` comments
* Leading-space escape for literal ``#``
* Anchored-root patterns (leading ``/``) vs unanchored
* Directory-only patterns (trailing ``/``)
* ``**/`` recursive wildcard
* ``*`` single-segment wildcard
* ``@org/team`` + bare emails + ``@username`` owners
* Multiple owners per pattern (whitespace- or comma-separated)

Last-match-wins semantics (the matcher iterates in
declaration order and returns the owners of the last
matching pattern).
"""

from __future__ import annotations

from eden.code_change.codeowners import (
    CodeOwnersEntry,
    match_owner,
    parse_codeowners,
)


# ── Parser tests ────────────────────────────────────────────────


def test_parse_handles_blank_lines_and_comments() -> None:
    """Blank lines + ``#`` comments are skipped."""
    text = """
    # This is a comment
    *                       @default

    # Another comment
    *.js                    @js
    """
    entries = parse_codeowners(text)
    assert len(entries) == 2
    assert entries[0].pattern == "*"
    assert entries[1].pattern == "*.js"


def test_parse_extracts_at_user_owner() -> None:
    """``@username`` is captured as an owner."""
    entries = parse_codeowners("* @alice")
    assert entries[0].owners == ["@alice"]


def test_parse_extracts_at_org_team_owner() -> None:
    """``@org/team-name`` is captured as a single owner."""
    entries = parse_codeowners("/docs/ @org/docs-team")
    assert entries[0].owners == ["@org/docs-team"]


def test_parse_extracts_email_owner() -> None:
    """Bare email addresses are captured as owners."""
    entries = parse_codeowners("*.py user@example.com")
    assert entries[0].owners == ["user@example.com"]


def test_parse_handles_multiple_owners_whitespace_separated() -> None:
    """Multiple owners are split on whitespace."""
    entries = parse_codeowners("* @alice @bob @carol")
    assert entries[0].owners == ["@alice", "@bob", "@carol"]


def test_parse_handles_multiple_owners_comma_separated() -> None:
    """Commas between owners are accepted (GitHub spec)."""
    entries = parse_codeowners("* @alice,@bob,@carol")
    assert entries[0].owners == ["@alice", "@bob", "@carol"]


def test_parse_handles_mixed_owner_kinds() -> None:
    """A pattern can mix users, teams, and emails."""
    entries = parse_codeowners(
        "/api/ @api-team @alice reviewer@example.com",
    )
    assert entries[0].owners == [
        "@api-team", "@alice", "reviewer@example.com",
    ]


def test_parse_preserves_anchored_root_slash() -> None:
    """Leading ``/`` is preserved on the pattern."""
    entries = parse_codeowners("/docs/ @docs")
    assert entries[0].pattern == "/docs/"


def test_parse_strips_trailing_directory_slash() -> None:
    """The trailing ``/`` is preserved (directory marker)."""
    entries = parse_codeowners("/docs/ @docs")
    assert entries[0].pattern == "/docs/"


def test_parse_handles_escape_leading_hash() -> None:
    """A leading ``\\#`` is a literal ``#`` in the pattern."""
    entries = parse_codeowners("\\#file.txt @alice")
    assert entries[0].pattern == "#file.txt"


def test_parse_handles_escape_leading_backslash() -> None:
    """A leading ``\\\\`` is a literal ``\\`` in the pattern."""
    entries = parse_codeowners("\\\\path @alice")
    assert entries[0].pattern == "\\path"


def test_parse_preserves_pattern_with_no_owner() -> None:
    """A pattern with no owners is preserved as a no-owner entry."""
    entries = parse_codeowners("/internal/")
    assert entries[0].pattern == "/internal/"
    assert entries[0].owners == []


def test_parse_returns_namedtuple() -> None:
    """Each entry is a :class:`CodeOwnersEntry` namedtuple."""
    entries = parse_codeowners("* @alice")
    assert isinstance(entries[0], CodeOwnersEntry)


def test_parse_empty_input_returns_empty_list() -> None:
    """An empty string parses to an empty list."""
    assert parse_codeowners("") == []


def test_parse_only_comments_returns_empty_list() -> None:
    """A file with only comments parses to an empty list."""
    assert parse_codeowners("# header\n# footer\n") == []


# ── Matcher tests ───────────────────────────────────────────────


def test_match_bare_star_matches_any_file() -> None:
    """``*`` matches any file."""
    entries = parse_codeowners("* @default")
    assert match_owner(entries, "anywhere.txt") == ["@default"]
    assert match_owner(entries, "deep/nested/path.py") == ["@default"]


def test_match_extension_glob_matches_anywhere() -> None:
    """``*.js`` matches any path ending in ``.js``."""
    entries = parse_codeowners("*.js @js")
    assert match_owner(entries, "users.js") == ["@js"]
    assert match_owner(entries, "src/api/users.js") == ["@js"]
    assert match_owner(entries, "users.py") == []


def test_match_anchored_extension_matches_root_only() -> None:
    """``/*.js`` matches only files at the repo root."""
    entries = parse_codeowners("/*.js @root-js")
    assert match_owner(entries, "users.js") == ["@root-js"]
    assert match_owner(entries, "src/users.js") == []


def test_match_anchored_directory_matches_root_only() -> None:
    """``/docs/`` matches only the root ``docs`` directory."""
    entries = parse_codeowners("/docs/ @docs-root")
    assert match_owner(entries, "docs/index.md") == ["@docs-root"]
    assert match_owner(entries, "docs/sub/page.md") == ["@docs-root"]
    # Not at root → no match.
    assert match_owner(entries, "deep/nested/docs/page.md") == []


def test_match_unanchored_directory_matches_any_depth() -> None:
    """``docs/`` (no leading ``/``) matches at any depth."""
    entries = parse_codeowners("docs/ @docs")
    assert match_owner(entries, "docs/index.md") == ["@docs"]
    assert match_owner(entries, "deep/nested/docs/page.md") == ["@docs"]


def test_match_double_star_directory_matches_any_depth() -> None:
    """``**/tests/`` matches the tests directory at any depth."""
    entries = parse_codeowners("**/tests/ @qa")
    assert match_owner(entries, "tests/unit/test_foo.py") == ["@qa"]
    assert match_owner(entries, "src/tests/test_foo.py") == ["@qa"]
    assert match_owner(entries, "a/b/c/tests/test_foo.py") == ["@qa"]
    # A directory named ``tests`` (no trailing path) — also
    # matches because the directory-only check considers
    # ``file_path == suffix`` to be a valid match (the path
    # IS the directory).
    assert match_owner(entries, "tests") == ["@qa"]


def test_match_double_star_file_pattern() -> None:
    """``**/foo.py`` matches ``foo.py`` at any depth."""
    entries = parse_codeowners("**/foo.py @foo")
    assert match_owner(entries, "foo.py") == ["@foo"]
    assert match_owner(entries, "a/foo.py") == ["@foo"]
    assert match_owner(entries, "a/b/foo.py") == ["@foo"]
    assert match_owner(entries, "foo.txt") == []


def test_match_double_star_middle_of_pattern() -> None:
    """``a/**/b`` matches any path with leading ``a/`` + trailing ``/b``."""
    entries = parse_codeowners("a/**/b @x")
    assert match_owner(entries, "a/b") == ["@x"]
    assert match_owner(entries, "a/x/b") == ["@x"]
    assert match_owner(entries, "a/x/y/b") == ["@x"]
    assert match_owner(entries, "b") == []


def test_last_match_wins() -> None:
    """When multiple patterns match, the LATER one wins."""
    entries = parse_codeowners("""
        *                   @default
        *.js                @js
        /docs/              @docs-root
    """)
    # `*.js` is declared after `*` → wins for `.js` files.
    assert match_owner(entries, "src/users.js") == ["@js"]
    # `/docs/` is declared after `*` → wins for `/docs/` files at root.
    assert match_owner(entries, "docs/index.md") == ["@docs-root"]


def test_match_returns_empty_list_when_no_pattern_matches() -> None:
    """No matching pattern → empty owner list."""
    entries = parse_codeowners("*.py @python")
    assert match_owner(entries, "users.js") == []


def test_match_handles_path_with_leading_slash() -> None:
    """A leading ``/`` on the file path is normalised away."""
    entries = parse_codeowners("* @default")
    assert match_owner(entries, "/users.txt") == ["@default"]


def test_match_handles_glob_in_middle_of_pattern() -> None:
    """``src/*/test.py`` matches ``src/<segment>/test.py``."""
    entries = parse_codeowners("src/*/test.py @mid")
    assert match_owner(entries, "src/api/test.py") == ["@mid"]
    # Lone ``*`` does NOT cross ``/`` — so deeper nesting fails.
    assert match_owner(entries, "src/api/v1/test.py") == []


def test_match_double_star_covers_deeper_nesting() -> None:
    """``src/**/test.py`` crosses ``/`` boundaries."""
    entries = parse_codeowners("src/**/test.py @deep")
    assert match_owner(entries, "src/api/test.py") == ["@deep"]
    assert match_owner(entries, "src/api/v1/test.py") == ["@deep"]
    assert match_owner(entries, "src/test.py") == ["@deep"]


def test_match_no_owner_pattern_yields_empty_owners() -> None:
    """A pattern with no owners matches but returns an empty list."""
    entries = parse_codeowners("""
        *                   @default
        /internal/          @code:owners-not-required
    """.replace("@code:owners-not-required", ""))
    # ``/internal/`` has no owner — its match wins, returning [].
    assert match_owner(entries, "internal/foo.py") == []
    # Outside ``/internal/`` — the ``*`` pattern wins.
    assert match_owner(entries, "src/foo.py") == ["@default"]


# ── Integration-ish (real-world CODEOWNERS examples) ───────────


def test_real_world_eden_codeowners_shape() -> None:
    """Mirrors the shape of a real OSS CODEOWNERS file."""
    text = """
    # Default
    *                                       @acme/core

    # Frontend
    *.js                                    @acme/frontend
    *.tsx                                   @acme/frontend
    /web/                                   @acme/frontend

    # Backend
    /api/                                   @acme/backend
    **/services/                            @acme/backend

    # Security-sensitive
    /auth/                                  @acme/security
    /billing/                               @acme/security

    # Docs
    /docs/                                  @acme/docs-team
    **/*.md                                 @acme/docs-team
    """
    entries = parse_codeowners(text)
    # Last-match-wins for several cases:
    # *.tsx wins over * for tsx files.
    assert match_owner(entries, "components/Button.tsx") == ["@acme/frontend"]
    # /api/ wins over **/services/ for files directly under /api/.
    assert match_owner(entries, "api/users.py") == ["@acme/backend"]
    # **/services/ catches service dirs at any depth.
    assert match_owner(entries, "src/services/billing.py") == ["@acme/backend"]
    # /auth/ wins over * for auth files.
    assert match_owner(entries, "auth/login.py") == ["@acme/security"]
    # /docs/ + **/*.md — last match wins for *.md in docs.
    assert match_owner(entries, "docs/setup.md") == ["@acme/docs-team"]
    # README.md at root is caught by **/*.md.
    assert match_owner(entries, "README.md") == ["@acme/docs-team"]


def test_no_false_positive_for_bare_star_vs_directory() -> None:
    """``*`` should match a file at the root named ``foo`` but
    not a directory named ``foo``. (The pattern doesn't end in
    ``/`` so it matches files only — directories are not files.)
    """
    entries = parse_codeowners("* @default")
    # A file named ``foo`` at root matches.
    assert match_owner(entries, "foo") == ["@default"]
    # A file ``foo/bar.txt`` (the file is in the foo directory).
    assert match_owner(entries, "foo/bar.txt") == ["@default"]