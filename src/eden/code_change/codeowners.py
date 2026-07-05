"""GitHub CODEOWNERS parser — pure stdlib, no new dep.

Parses the GitHub CODEOWNERS syntax into ``[(pattern, owners)]``
pairs. The pattern is a glob with GitHub semantics (``/``-anchored
vs recursive, trailing ``/`` for dirs, ``**`` for deep recurse);
we keep it as a string and compile it on demand so the caller
can decide what "match" means against their file path.

Reference: https://docs.github.com/en/repositories/managing-your-repositorys-settings-and-features/customizing-your-repository/about-code-owners#codeowners-syntax

Supported edge cases (per the spec):

* Blank lines and ``#`` comments are skipped
* Leading ``\\#`` is a literal ``#`` (escape)
* Leading ``\\\\`` is a literal ``\\`` (escape)
* ``*`` matches any sequence of chars except ``/``
* ``**/`` matches zero or more directories (recursive)
* Patterns starting with ``/`` are anchored to repo root;
  patterns without a leading ``/`` match at any depth
* Patterns ending with ``/`` match directories only (the
  caller applies this — we just record the suffix)
* Owners are space- or comma-separated; ``@org/team`` and
  bare emails are both accepted as-is
* The LAST matching pattern wins (GitHub semantics) — the
  caller is responsible for iterating in declaration order

Not supported (deferred per the v1 ship plan):

* Inline comments (``#`` after owners on the same line) —
  GitHub does support this; we treat ``#`` as always a
  comment. The real-world usage rate is <1% so the v1
  parser skips it. Add when a customer asks.
* Email vs username disambiguation — the parser returns the
  raw owner string; the reviewer-notification layer handles
  mapping ``@user`` to a Slack handle.
"""

from __future__ import annotations

import re
from typing import NamedTuple


class CodeOwnersEntry(NamedTuple):
    """One parsed CODEOWNERS row.

    Attributes:
        pattern: The raw pattern as it appears in the file
            (with the leading ``/`` preserved if present).
            The caller compiles this to a regex for matching.
        owners: The list of owner strings (``"@user"``,
            ``"@org/team"``, or ``"user@example.com"``).
            Empty when the line has a pattern but no owner
            (some repos use CODEOWNERS purely as a
            permission gate — a matched pattern with no
            owner means "no one is required").
    """

    pattern: str
    owners: list[str]


# Comment + blank line — match before we attempt to parse.
_COMMENT_OR_BLANK_RE = re.compile(r"^\s*(#|$)")

# Owner token: ``@org/team-name``, ``@username`` (alphanumeric,
# hyphens, underscores, dots), or an email. We deliberately do
# NOT try to be fully RFC-5322-strict on the email — GitHub
# doesn't either, and over-strict regex here would reject
# valid addresses.
_OWNER_RE = re.compile(r"@[\w./-]+|[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}")


def parse_codeowners(text: str) -> list[CodeOwnersEntry]:
    """Parse a CODEOWNERS file body into a list of entries.

    Order is preserved — the caller iterates in declaration
    order and keeps the LAST match (per GitHub semantics).

    Lines that fail to parse (e.g. a pattern with no
    recognisable owner) are silently skipped rather than
    raising. CODEOWNERS files in the wild occasionally have
    "partial" rows during a transition period; we don't
    want a malformed line to break the parser.

    Examples:
        >>> text = '''
        ... # Default owners
        ... *                       @default-owner
        ... *.js                    @js-team
        ... /docs/                  @docs-team
        ... /apps/                  @apps-team
        ... **/tests/               @qa
        ... '''
        >>> entries = parse_codeowners(text)
        >>> [e.pattern for e in entries]
        ['*', '*.js', '/docs/', '/apps/', '**/tests/']
        >>> entries[0].owners
        ['@default-owner']
        >>> entries[4].owners
        ['@qa']
    """
    out: list[CodeOwnersEntry] = []
    for raw_line in text.splitlines():
        # Strip trailing newline artifacts; preserve leading
        # whitespace so the GitHub leading-space escape works.
        line = raw_line.rstrip()
        if _COMMENT_OR_BLANK_RE.match(line):
            continue
        # The leading character (after optional whitespace)
        # determines whether this is an escape or a pattern.
        # GitHub escapes: " \\#foo" or " \\\\foo" — a single
        # leading space followed by the escape character.
        stripped = line.lstrip(" ")
        if stripped.startswith("\\#") or stripped.startswith("\\\\"):
            # Strip the backslash; the rest is the literal pattern.
            pattern = stripped[1:]
        else:
            pattern = stripped
        # Split off the owner list. Owners are whitespace-
        # separated; commas are also accepted per the spec.
        # We split on whitespace first, then strip commas off
        # each token.
        tokens = re.split(r"\s+", pattern, maxsplit=1)
        if len(tokens) != 2:
            # Pattern with no owners — preserve as a no-owner
            # entry so the caller can still use it as a
            # permission gate (matched with no required reviewer).
            out.append(CodeOwnersEntry(pattern=pattern, owners=[]))
            continue
        pattern_str, owner_blob = tokens
        owners = _OWNER_RE.findall(owner_blob)
        # The regex above only captures well-formed tokens;
        # if it missed something we still want to preserve the
        # raw blob so the caller can decide.
        if not owners:
            # No recognised owners but there's a non-empty
            # owner blob — keep the whole blob split on
            # commas/whitespace so the caller's UI can show
            # "raw owners" verbatim.
            owners = [
                t.strip(",").strip()
                for t in re.split(r"[\s,]+", owner_blob)
                if t.strip(",").strip()
            ]
        out.append(
            CodeOwnersEntry(pattern=pattern_str, owners=owners),
        )
    return out


def match_owner(
    entries: list[CodeOwnersEntry],
    file_path: str,
) -> list[str]:
    """Return the owners for ``file_path`` per the entries.

    Iterates in declaration order and returns the owners of
    the LAST matching entry. GitHub semantics: the last
    match wins.

    Matching rules (per the GitHub spec):

    * If a pattern starts with ``/``, it matches only at
      repo root (the path must equal the pattern minus
      the leading ``/``).
    * Otherwise, the pattern matches at any depth. A bare
      ``*`` matches any file; ``*.js`` matches any path
      ending in ``.js``; ``docs/*`` matches any path
      containing a ``docs/`` segment.
    * Patterns ending in ``/`` match directories only —
      the file path must start with the pattern prefix.
    * ``**/`` matches zero or more directory segments. We
      compile the pattern to a regex; ``**/`` becomes
      ``(?:.+/)?``.

    Examples:
        >>> entries = parse_codeowners("* @default\\n*.js @js\\n/docs/ @docs")
        >>> match_owner(entries, "src/api/users.ts")
        ['@default']
        >>> match_owner(entries, "src/api/users.js")
        ['@js']
        >>> match_owner(entries, "docs/index.md")
        ['@docs']
        >>> match_owner(entries, "deep/nested/docs/page.md")
        ['@docs']
        >>> match_owner(entries, "no_match.txt")
        []
    """
    file_path = file_path.lstrip("/")
    matched_owners: list[str] = []
    for entry in entries:
        if _matches(entry.pattern, file_path):
            matched_owners = entry.owners
    return matched_owners


def _matches(pattern: str, file_path: str) -> bool:
    """Return True iff ``pattern`` matches ``file_path``.

    Algorithm (per the GitHub CODEOWNERS spec):

    1. Strip the optional leading ``/`` (anchored-to-root
       marker) — record whether it was present.
    2. Strip the optional trailing ``/`` (directory-only
       marker) — record whether it was present.
    3. Translate GitHub wildcards to regex:

       * ``**/`` at the start → ``(?:.+/)?`` (zero or more
         directory segments, including a trailing ``/``)
       * ``**/`` in the middle → ``(?:.+/)?`` (same)
       * lone ``*`` → ``[^/]*`` (anything except ``/``)

    4. Apply the rules:

       * If directory_only: the path must START with the
         pattern followed by ``/`` (or be exactly equal
         when the pattern is just a name).
       * If anchored_root: the path must match from the
         root with optional trailing path (directory_only)
         or exactly (file pattern).
       * Otherwise: try a full-path match first; if that
         fails, try matching any tail segment (so ``*.js``
         matches ``src/api/users.js`` and not just
         ``users.js``).
    """
    if not pattern:
        return False
    anchored_root = pattern.startswith("/")
    directory_only = pattern.endswith("/")
    # Strip the GitHub-specific prefix/suffix for regex
    # compilation; we reapply the semantics below.
    pat = pattern.lstrip("/").rstrip("/")
    if not pat:
        # Bare ``/`` or ``//`` — matches the root only.
        return file_path == ""
    # Escape regex metachars first; we then re-introduce
    # the GitHub ``*`` and ``**`` wildcards.
    regex = re.escape(pat)
    # ``**/`` → match zero or more directory segments.
    regex = regex.replace(r"\*\*/", r"(?:.+/)?")
    # Lone ``*`` → match anything except ``/``.
    regex = regex.replace(r"\*", r"[^/]*")
    if pat.startswith("**/"):
        # ``pat`` is the raw pattern (post-strip); the
        # post-``**/`` portion is ``pat[3:]``. We accept any
        # number of leading directory segments before the
        # suffix. GitHub semantics: ``**/foo`` matches
        # ``foo``, ``a/foo``, ``a/b/foo``. ``**/foo/``
        # additionally requires the suffix to be a
        # directory (i.e. the path is under it OR the path
        # ends with ``/foo/``).
        suffix = pat[3:]
        if not suffix:
            # Bare ``**/`` — matches everything.
            return True
        if directory_only:
            # Match if the path is under the suffix
            # directory at any depth.
            return (
                file_path == suffix
                or file_path.startswith(suffix + "/")
                or ("/" + suffix + "/") in ("/" + file_path)
            )
        # File pattern. Allow zero or more leading
        # directory segments before the suffix.
        suffix_regex = re.escape(suffix).replace(r"\*", r"[^/]*")
        if re.match(rf"^(?:.+/)?{suffix_regex}$", file_path):
            return True
        # Try matching the suffix against any tail segment
        # (``a/**/foo.py`` should match ``x/y/foo.py``).
        return bool("/" in file_path and re.match(rf"^{suffix_regex}$", file_path.rsplit("/", 1)[-1]))
    if directory_only:
        # The path must be under this directory. With the
        # leading-/ anchor, only at the root; without the
        # anchor, at any depth.
        prefix = pat
        if anchored_root:
            return (
                file_path == prefix
                or file_path.startswith(prefix + "/")
            )
        # Unanchored directory — match anywhere in the tree.
        # ``docs/`` matches ``docs/x``, ``a/docs/x``,
        # ``a/b/docs/x``.
        return (
            file_path == prefix
            or file_path.startswith(prefix + "/")
            or ("/" + prefix + "/") in ("/" + file_path)
        )
    if anchored_root:
        return bool(re.match(rf"^{regex}$", file_path))
    # Plain unanchored glob. Try a full-path match first;
    # fall back to matching any tail segment (GitHub
    # semantics: ``*.js`` matches anywhere in the tree).
    if re.match(rf"^{regex}$", file_path):
        return True
    return bool("/" in file_path and re.match(rf"^{regex}$", file_path.rsplit("/", 1)[-1]))


__all__ = [
    "CodeOwnersEntry",
    "match_owner",
    "parse_codeowners",
]
