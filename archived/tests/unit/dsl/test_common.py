"""Regression tests for the Cat 19 EQL tenant-isolation fix.

``eden.dsl._common._inject_org_id`` used to decide whether a query
was "already org-scoped" with a bare ``"org_id" in query.lower()``
substring check. That has zero context awareness: a SQL comment
(``-- org_id``), a column alias (``AS org_id_x``), or a string
literal that merely contains the text ``org_id`` would all cause
the substring check to fire and the org filter would silently be
skipped — a CRITICAL tenant-isolation bug, since the unscoped query
is later persisted (:class:`eden.dsl.alerts.AlertAsCode`) and run
verbatim by the cron watchdog.

That was replaced with :func:`_has_org_scope_predicate`, a
structural check requiring a real, word-bounded ``org_id`` column
reference compared with ``=`` to a string literal that matches
*this* org's id. That check was **still** insufficient: it only
verified such a predicate occurred *somewhere* in the query text,
never that it actually gated the whole query as a top-level ANDed
conjunct. A query like
``WHERE (t.org_id = '<this org>' OR 1=1)`` contains a textually
genuine match, so the old gate returned True and injection was
skipped — but the query as written is always-true and returns every
org's rows. Same bypass with ``NOT(...)`` or the predicate buried in
an unrelated subquery.

The current fix abandons the "skip injection if it looks already
scoped" strategy entirely: :func:`_inject_org_id` now
*unconditionally* parenthesizes whatever WHERE body the query
already has and ANDs the real ``t.org_id = '<org>'`` filter onto the
outside of those parens, so no boolean trick inside the caller's
clause can ever escape the injected filter.
:func:`_has_org_scope_predicate` is kept only as a diagnostic
text-check (still exercised directly below) — it no longer gates
whether injection happens.

These tests pin the current behaviour so a future edit can't
silently reintroduce either the substring-check bug or the
"looks-already-scoped" gating bug, and also cover the companion
read-only-SQL hardening (:func:`_looks_like_readonly_sql` rejecting
UNION/INTERSECT/EXCEPT and non-allowlisted table references, while
still accepting CTE ``WITH ... AS (...)`` references to their own
CTE name).
"""

from __future__ import annotations

import pytest

from eden.dsl._common import (
    _has_org_scope_predicate,
    _has_unbalanced_quotes,
    _inject_org_id,
    _looks_like_readonly_sql,
    _strip_sql_comments,
)

ORG_ID = "org_123"
OTHER_ORG_ID = "org_attacker"


class TestHasOrgScopePredicateFalsePositives:
    """Structural bypasses that a bare substring check would have missed."""

    def test_trailing_line_comment_is_not_a_scope_predicate(self) -> None:
        query = (
            "SELECT * FROM telemetry_events "
            "WHERE t.duration_ms > 100 -- org_id"
        )
        assert _has_org_scope_predicate(query, ORG_ID) is False

    def test_trailing_line_comment_still_gets_the_real_filter_injected(self) -> None:
        query = (
            "SELECT * FROM telemetry_events "
            "WHERE t.duration_ms > 100 -- org_id"
        )
        injected = _inject_org_id(query, ORG_ID)
        assert f"t.org_id = '{ORG_ID}'" in injected
        assert injected != query

    def test_column_alias_org_id_x_is_not_a_scope_predicate(self) -> None:
        query = (
            "SELECT t.tenant AS org_id_x FROM telemetry_events "
            "WHERE t.duration_ms > 100"
        )
        assert _has_org_scope_predicate(query, ORG_ID) is False

    def test_column_alias_org_id_x_still_gets_the_real_filter_injected(self) -> None:
        query = (
            "SELECT t.tenant AS org_id_x FROM telemetry_events "
            "WHERE t.duration_ms > 100"
        )
        injected = _inject_org_id(query, ORG_ID)
        assert f"t.org_id = '{ORG_ID}'" in injected
        assert injected != query

    def test_bare_string_literal_mention_is_not_a_scope_predicate(self) -> None:
        # The literal text "org_id" appears inside a string value being
        # compared against an unrelated column (t.name) — not a real
        # org_id column reference compared to a literal.
        query = (
            "SELECT * FROM telemetry_events "
            "WHERE t.name = 'org_id = evil'"
        )
        assert _has_org_scope_predicate(query, ORG_ID) is False

    def test_bare_string_literal_mention_still_gets_the_real_filter_injected(
        self,
    ) -> None:
        query = (
            "SELECT * FROM telemetry_events "
            "WHERE t.name = 'org_id = evil'"
        )
        injected = _inject_org_id(query, ORG_ID)
        assert f"t.org_id = '{ORG_ID}'" in injected
        # The original (harmless) clause is preserved, not stripped.
        assert "t.name = 'org_id = evil'" in injected


class TestHasOrgScopePredicateGenuinePredicates:
    """Genuine ``org_id = <literal>`` predicates: same-org vs. other-org."""

    def test_genuine_predicate_for_current_org_is_treated_as_scoped(self) -> None:
        query = f"SELECT * FROM telemetry_events WHERE org_id = '{ORG_ID}'"
        assert _has_org_scope_predicate(query, ORG_ID) is True

    def test_genuine_predicate_for_current_org_is_redundant_but_harmless(
        self,
    ) -> None:
        # _inject_org_id no longer skips injection just because the
        # query already looks scoped (that gating logic was itself
        # the bypass — see module docstring). For the legitimate
        # already-scoped case this means a second, redundant
        # ``AND t.org_id = '<org>'`` gets ANDed on — ANDing a true
        # predicate with itself is a no-op, so the result set is
        # unaffected; it's simply no longer byte-identical to the
        # input.
        query = f"SELECT * FROM telemetry_events WHERE org_id = '{ORG_ID}'"
        injected = _inject_org_id(query, ORG_ID)
        assert injected != query
        assert injected.count("org_id") == 2
        # The original predicate is preserved, parenthesized, and
        # ANDed with the real (redundant) filter — not replaced.
        assert f"WHERE (org_id = '{ORG_ID}') AND t.org_id = '{ORG_ID}'" in injected

    def test_genuine_predicate_for_other_org_is_not_treated_as_scoped(self) -> None:
        # An attacker-supplied org_id predicate for a *different* org
        # must not be mistaken for this request's own scoping.
        query = f"SELECT * FROM telemetry_events WHERE org_id = '{OTHER_ORG_ID}'"
        assert _has_org_scope_predicate(query, ORG_ID) is False

    def test_genuine_predicate_for_other_org_still_gets_real_filter_anded_in(
        self,
    ) -> None:
        query = f"SELECT * FROM telemetry_events WHERE org_id = '{OTHER_ORG_ID}'"
        injected = _inject_org_id(query, ORG_ID)
        # The real filter is ANDed in (narrows, never widens the result
        # set) — the attacker's clause is left in place, not relied upon.
        assert f"t.org_id = '{ORG_ID}'" in injected
        assert f"org_id = '{OTHER_ORG_ID}'" in injected


class TestInjectOrgIdBooleanBypass:
    """CRITICAL regression: OR/NOT tricks must not escape the injected filter.

    These pin the fix for the residual bypass an adversarial review
    found in the *previous* revision of ``_inject_org_id``: it skipped
    injection whenever :func:`_has_org_scope_predicate` found a
    textually genuine ``org_id = '<this org>'`` match ANYWHERE in the
    query — including inside an ``OR 1=1`` disjunct or a ``NOT(...)``
    wrapper, where the match does not actually gate the query at all.
    The current ``_inject_org_id`` no longer performs that "already
    scoped" check; it unconditionally wraps the ENTIRE pre-existing
    WHERE body in parens and ANDs the real filter on the outside, so
    no boolean trick inside the caller's clause can escape it. We
    assert the exact output shape (not just substring presence) so a
    future change back to conditional injection would fail these
    tests immediately.
    """

    def test_or_1_equals_1_bypass_is_wrapped_not_bypassed(self) -> None:
        query = (
            "SELECT * FROM telemetry_events t "
            f"WHERE (t.org_id = '{ORG_ID}' OR 1=1)"
        )
        injected = _inject_org_id(query, ORG_ID)
        # The injected AND must gate the *entire* original condition,
        # including the OR — i.e. the original condition appears,
        # still parenthesized, immediately followed by the real
        # AND'd filter outside those parens. This is what makes the
        # OR unable to make the overall WHERE always-true: even if
        # the inner OR evaluates True for another org's row, the
        # outer ``AND t.org_id = '<this org>'`` still filters it out.
        expected_wrapped = f"WHERE ((t.org_id = '{ORG_ID}' OR 1=1)) AND t.org_id = '{ORG_ID}'"
        assert expected_wrapped in injected
        # Structural invariant: the real filter is the last token in
        # the WHERE clause and is ANDed (not ORed) onto the wrapped
        # original condition — this is what makes it impossible for
        # anything inside the original condition to widen past it.
        assert injected.rstrip().endswith(f"AND t.org_id = '{ORG_ID}'")

    def test_not_wrapper_bypass_is_wrapped_not_bypassed(self) -> None:
        query = (
            "SELECT * FROM telemetry_events t "
            f"WHERE NOT (t.org_id != '{ORG_ID}')"
        )
        injected = _inject_org_id(query, ORG_ID)
        expected_wrapped = (
            f"WHERE (NOT (t.org_id != '{ORG_ID}')) AND t.org_id = '{ORG_ID}'"
        )
        assert expected_wrapped in injected
        assert injected.rstrip().endswith(f"AND t.org_id = '{ORG_ID}'")

    def test_bypass_buried_in_subquery_with_outer_or_1_equals_1(self) -> None:
        # The org_id predicate is textually present (inside the
        # EXISTS subquery) but the OUTER WHERE is an unconditional
        # ``1=1 OR ...`` — the old substring/regex-anywhere check
        # would have matched the inner org_id predicate and skipped
        # injection entirely, leaving the outer WHERE always-true.
        query = (
            "SELECT * FROM telemetry_events t "
            "WHERE 1=1 OR EXISTS ("
            "SELECT 1 FROM telemetry_events e "
            f"WHERE e.org_id = '{ORG_ID}')"
        )
        injected = _inject_org_id(query, ORG_ID)
        expected_wrapped = (
            "WHERE (1=1 OR EXISTS (SELECT 1 FROM telemetry_events e "
            f"WHERE e.org_id = '{ORG_ID}')) AND t.org_id = '{ORG_ID}'"
        )
        assert expected_wrapped in injected
        assert injected.rstrip().endswith(f"AND t.org_id = '{ORG_ID}'")


class TestInjectOrgIdCommentSwallowBypass:
    """CRITICAL regression: a trailing/embedded SQL comment must not be
    able to swallow the ``AND t.org_id = ...`` clause :func:`_inject_org_id`
    appends.

    A THIRD round of review (after the substring-check bypass and the
    OR/NOT boolean bypass, both fixed above) found that the WHERE-body
    detection and AND-appending logic in ``_inject_org_id`` ran on the
    RAW query text with any SQL comment the caller wrote still embedded
    in it. A trailing ``--`` line comment placed after the point where
    this function's own appended text lands swallows that appended text
    into the comment: the *string* ``_inject_org_id`` returns contains
    the real filter, but a SQL engine parsing it would never execute
    that part, since it is inside a comment. The fix: ``_inject_org_id``
    now calls :func:`_strip_sql_comments` FIRST and does all of its
    rewriting against the comment-free text, so no comment the caller
    wrote can ever end up positioned after the injected clause.
    """

    def test_exploit_1_no_where_trailing_line_comment_is_not_swallowed(
        self,
    ) -> None:
        # Before the fix: _inject_org_id appended " WHERE t.org_id = ..."
        # AFTER the existing trailing comment, so the whole appended
        # clause became part of the comment and the actually-executed
        # SQL was the fully unscoped
        # "SELECT * FROM telemetry_events t" (no WHERE at all).
        query = "SELECT * FROM telemetry_events t -- no filters here"
        injected = _inject_org_id(query, ORG_ID)
        # No comment marker survives — nothing appended after this
        # point can ever be swallowed by it.
        assert "--" not in injected
        # The real filter is present and is not commented out.
        assert f"WHERE t.org_id = '{ORG_ID}'" in injected
        assert injected.rstrip().endswith(f"t.org_id = '{ORG_ID}'")

    def test_exploit_2_has_where_trailing_comment_cannot_eat_and_clause(
        self,
    ) -> None:
        # Before the fix: the body/tail split happened on raw text, so
        # the trailing "--" ate the injector's own closing paren *and*
        # the appended "AND t.org_id = ..." clause, leaving the
        # actually-executed SQL as the always-true, fully unscoped
        # "SELECT * FROM telemetry_events t WHERE (1=1) OR 1=1".
        query = "SELECT * FROM telemetry_events t WHERE 1=1) OR 1=1 --"
        injected = _inject_org_id(query, ORG_ID)
        # No comment marker survives in the rewritten query.
        assert "--" not in injected
        # The injected AND clause is present, verbatim, and is the
        # last thing in the query — nothing after it (like a comment)
        # can neutralize it.
        assert injected.rstrip().endswith(f"AND t.org_id = '{ORG_ID}'")
        # The clause is genuinely appended via AND, not embedded inside
        # a comment or dropped: it must appear exactly once, joined by
        # "AND" to whatever precedes it.
        assert f"AND t.org_id = '{ORG_ID}'" in injected
        assert injected.count(f"t.org_id = '{ORG_ID}'") == 1

    def test_block_comment_cannot_hide_injected_clause(self) -> None:
        # A /* ... */ block comment wrapped around (or trailing) the
        # existing WHERE body must not be able to comment out the
        # appended filter either.
        query = (
            "SELECT * FROM telemetry_events t "
            "WHERE t.duration_ms > 100 /* AND t.org_id = 'ignored' */"
        )
        injected = _inject_org_id(query, ORG_ID)
        assert "/*" not in injected and "*/" not in injected
        assert injected.rstrip().endswith(f"AND t.org_id = '{ORG_ID}'")


class TestStripSqlCommentsPreservesStringLiterals:
    """A '--' or '/* */' inside a quoted string literal is a legitimate
    filter value, not a comment — it must survive comment-stripping
    intact, since :func:`_inject_org_id` now rewrites the
    comment-stripped text verbatim (a corrupted literal would silently
    change a value the caller depends on, not just a heuristic input).
    """

    def test_double_dash_inside_single_quoted_literal_survives(self) -> None:
        query = "SELECT * FROM telemetry_events t WHERE t.message = '-- not a comment'"
        cleaned = _strip_sql_comments(query)
        assert cleaned == query

    def test_double_dash_inside_double_quoted_literal_survives(self) -> None:
        query = 'SELECT * FROM telemetry_events t WHERE t.message = "-- not a comment"'
        cleaned = _strip_sql_comments(query)
        assert cleaned == query

    def test_block_comment_markers_inside_literal_survive(self) -> None:
        query = (
            "SELECT * FROM telemetry_events t "
            "WHERE t.message = '/* still not a comment */'"
        )
        cleaned = _strip_sql_comments(query)
        assert cleaned == query

    def test_real_comment_after_a_literal_is_still_stripped(self) -> None:
        # The literal survives, but a genuine trailing comment that
        # comes *after* the closing quote is still removed.
        query = (
            "SELECT * FROM telemetry_events t "
            "WHERE t.message = '-- not a comment' -- but this is"
        )
        cleaned = _strip_sql_comments(query)
        assert "'-- not a comment'" in cleaned
        assert "but this is" not in cleaned

    def test_inject_org_id_does_not_corrupt_literal_containing_double_dash(
        self,
    ) -> None:
        query = "SELECT * FROM telemetry_events t WHERE t.message = '-- not a comment'"
        injected = _inject_org_id(query, ORG_ID)
        # The literal's exact contents survive, untouched, inside the
        # rewritten query.
        assert "'-- not a comment'" in injected
        assert f"AND t.org_id = '{ORG_ID}'" in injected

    def test_inject_org_id_does_not_corrupt_literal_containing_block_comment_markers(
        self,
    ) -> None:
        query = (
            "SELECT * FROM telemetry_events t "
            "WHERE t.message = '/* not a comment */ still text'"
        )
        injected = _inject_org_id(query, ORG_ID)
        assert "'/* not a comment */ still text'" in injected
        assert f"AND t.org_id = '{ORG_ID}'" in injected


class TestLooksLikeReadonlySql:
    """Companion hardening: reject set-ops and non-allowlisted tables."""

    def test_rejects_union_select(self) -> None:
        query = (
            f"SELECT * FROM telemetry_events WHERE org_id='{ORG_ID}' "
            "UNION SELECT * FROM other_table"
        )
        assert _looks_like_readonly_sql(query) is False

    def test_rejects_intersect(self) -> None:
        query = (
            f"SELECT * FROM telemetry_events WHERE org_id='{ORG_ID}' "
            "INTERSECT SELECT * FROM other_table"
        )
        assert _looks_like_readonly_sql(query) is False

    def test_rejects_except(self) -> None:
        query = (
            f"SELECT * FROM telemetry_events WHERE org_id='{ORG_ID}' "
            "EXCEPT SELECT * FROM other_table"
        )
        assert _looks_like_readonly_sql(query) is False

    def test_rejects_non_allowlisted_table_reference(self) -> None:
        query = f"SELECT * FROM other_table WHERE org_id='{ORG_ID}'"
        assert _looks_like_readonly_sql(query) is False

    def test_rejects_non_allowlisted_join_reference(self) -> None:
        query = (
            "SELECT * FROM telemetry_events t "
            "JOIN other_table o ON o.trace_id = t.trace_id "
            f"WHERE org_id='{ORG_ID}'"
        )
        assert _looks_like_readonly_sql(query) is False

    def test_accepts_plain_telemetry_events_query(self) -> None:
        # Sanity control: a normal, allowlisted query still passes.
        query = f"SELECT * FROM telemetry_events WHERE org_id='{ORG_ID}'"
        assert _looks_like_readonly_sql(query) is True

    def test_accepts_cte_reference_to_its_own_name(self) -> None:
        # Regression: WITH/CTE queries are a supported entry keyword
        # (the first-token check accepts SELECT or WITH), but the
        # table-allowlist check used to reject every CTE query
        # outright because the CTE's own name ("cte") isn't in
        # _ALLOWED_TABLES — the FROM clause of the outer SELECT reads
        # from the CTE, not from a real (non-allowlisted) table.
        query = (
            "WITH cte AS ("
            f"SELECT * FROM telemetry_events WHERE org_id = '{ORG_ID}'"
            ") SELECT * FROM cte"
        )
        assert _looks_like_readonly_sql(query) is True

    def test_accepts_multi_cte_reference(self) -> None:
        query = (
            "WITH a AS (SELECT * FROM telemetry_events), "
            "b AS (SELECT * FROM telemetry_events) "
            "SELECT * FROM a JOIN b ON a.trace_id = b.trace_id "
            f"WHERE a.org_id = '{ORG_ID}'"
        )
        assert _looks_like_readonly_sql(query) is True

    def test_still_rejects_non_allowlisted_table_inside_cte_query(self) -> None:
        # A CTE query must not become a loophole for reading a real,
        # non-allowlisted table — only the CTE's own defined name(s)
        # are exempted from the allowlist.
        query = (
            "WITH cte AS (SELECT * FROM other_table) "
            f"SELECT * FROM cte WHERE org_id = '{ORG_ID}'"
        )
        assert _looks_like_readonly_sql(query) is False


class TestInjectOrgIdWhereInStringLiteral:
    """GAP B (round 4): the WHERE keyword is now literal-aware.

    A perfectly ordinary, non-adversarial query that happens to
    contain the literal text ``WHERE`` inside a quoted string
    *before* the real WHERE keyword used to fool the old
    ``re.search(r'\\bWHERE\\b', query)`` into treating the string's
    contents as (part of) the clause boundary, corrupting the
    body/tail split. The fix is to detect WHERE (and the
    GROUP BY/ORDER BY/HAVING/LIMIT/OFFSET boundary) with
    :func:`_find_unquoted`, which skips any match inside a string
    literal.
    """

    def test_where_keyword_inside_string_literal_is_not_mistaken_for_real_where(
        self,
    ) -> None:
        query = (
            "SELECT id, 'WHERE' AS marker FROM telemetry_events t "
            "WHERE 1=1"
        )
        injected = _inject_org_id(query, ORG_ID)
        # The literal survives untouched -- it's ordinary SELECT-list
        # content, not something _inject_org_id should ever rewrite.
        assert "'WHERE' AS marker" in injected
        # The REAL where clause's condition (1=1) is correctly found,
        # parenthesized, and ANDed with the real org filter -- not
        # dropped, not left unwrapped/unscoped.
        expected_wrapped = f"WHERE (1=1) AND t.org_id = '{ORG_ID}'"
        assert expected_wrapped in injected
        assert injected.rstrip().endswith(f"AND t.org_id = '{ORG_ID}'")
        # Sanity: exactly one real WHERE keyword appears in the
        # rewritten query outside of the string literal.
        assert injected.count("WHERE (1=1)") == 1

    def test_where_keyword_inside_double_quoted_literal_is_not_mistaken(
        self,
    ) -> None:
        query = (
            'SELECT id, "WHERE" AS marker FROM telemetry_events t '
            "WHERE t.duration_ms > 10"
        )
        injected = _inject_org_id(query, ORG_ID)
        assert '"WHERE" AS marker' in injected
        expected_wrapped = (
            f"WHERE (t.duration_ms > 10) AND t.org_id = '{ORG_ID}'"
        )
        assert expected_wrapped in injected

    def test_clause_boundary_keyword_inside_string_literal_is_not_mistaken(
        self,
    ) -> None:
        # A literal containing "ORDER BY" before the real WHERE/ORDER
        # BY must not corrupt the WHERE-body/tail split either.
        query = (
            "SELECT id, 'ORDER BY' AS marker FROM telemetry_events t "
            "WHERE t.duration_ms > 10 ORDER BY t.timestamp"
        )
        injected = _inject_org_id(query, ORG_ID)
        assert "'ORDER BY' AS marker" in injected
        expected_wrapped = (
            f"WHERE (t.duration_ms > 10) AND t.org_id = '{ORG_ID}'"
        )
        assert expected_wrapped in injected
        # The real tail (the actual ORDER BY clause) is preserved.
        assert "ORDER BY t.timestamp" in injected


class TestInjectOrgIdUnbalancedQuotesRejected:
    """GAP A (round 4): an unbalanced (odd) quote count is rejected.

    A dangling/unterminated string literal in the caller's WHERE body
    lets a real SQL engine's own quote-toggle parsing over the FINAL
    text (after this function appends its own ``'<org_id>'`` literal)
    use the injected literal's quotes to close the attacker's dangling
    string, garbling the appended AND-clause. Every construction tried
    produces a syntax error rather than a silent bypass, but this
    function now rejects such input outright (fail-closed at
    compile-time) instead of attempting the rewrite.
    """

    def test_dangling_quote_in_where_body_is_rejected(self) -> None:
        query = "SELECT * FROM telemetry_events t WHERE 1=1 OR '"
        with pytest.raises(ValueError):
            _inject_org_id(query, ORG_ID)

    def test_dangling_quote_is_detected_by_has_unbalanced_quotes(self) -> None:
        query = "SELECT * FROM telemetry_events t WHERE 1=1 OR '"
        assert _has_unbalanced_quotes(query) is True

    def test_balanced_quotes_in_where_body_still_inject_normally(self) -> None:
        # Sanity control: a normal, well-formed string literal (even
        # one containing an apostrophe via the doubled-quote escape)
        # is not rejected.
        query = (
            "SELECT * FROM telemetry_events t "
            "WHERE t.message = 'it''s fine'"
        )
        injected = _inject_org_id(query, ORG_ID)
        assert f"AND t.org_id = '{ORG_ID}'" in injected
        assert "'it''s fine'" in injected

    def test_has_unbalanced_quotes_false_for_well_formed_query(self) -> None:
        query = "SELECT * FROM telemetry_events t WHERE t.name = 'ok'"
        assert _has_unbalanced_quotes(query) is False
