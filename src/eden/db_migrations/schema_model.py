"""Build a ``{table -> columns}`` model from the alembic migration chain.

Eden's single largest defect class is SQL that names a column no migration ever
created, wrapped in ``except Exception: logger.debug(...)``. The query raises
``UndefinedColumn`` every time, the handler swallows it, and the feature returns
an empty list forever. It accounts for roughly a third of all known bugs and has
silently disabled the metering chain, trace replay, Live Tail, the reasoning
endpoint, every EQL query, and four intelligence subsystems.

Three properties make it invisible without a tool like this:

* the failure is *total* (every call raises), so there is no partial signal;
* the handler logs at DEBUG and production runs at INFO;
* an empty list is indistinguishable from "this tenant has no data".

This module reconstructs the real schema by replaying the DDL, so a static
check can compare it against the SQL the application actually issues.

Deliberately stdlib-only (``ast`` + ``re``). It runs in the blocking pre-commit
hook, where adding a SQL-parser dependency would be a poor trade — and the
alembic tree is hand-written raw SQL in a narrow, consistent style (every
statement goes through ``op.execute`` with a triple-quoted literal), which a
general parser would not exploit anyway.
"""

from __future__ import annotations

import ast
import re
from collections.abc import Iterator
from dataclasses import dataclass, field
from pathlib import Path

#: Statement-level constructs that appear inside a ``CREATE TABLE (...)`` body
#: but are constraints, not columns.
_NON_COLUMN_PREFIXES = (
    "primary key",
    "unique",
    "foreign key",
    "check",
    "constraint",
    "exclude",
    "like",
)

#: DDL we intentionally ignore: it never adds or removes a column.
_IGNORED_STATEMENT_PREFIXES = (
    "create index",
    "create unique index",
    "drop index",
    "create policy",
    "drop policy",
    "alter policy",
    "create trigger",
    "drop trigger",
    "create extension",
    "comment on",
    "grant",
    "revoke",
    "insert into",
    "update ",
    "delete from",
    "select ",
    "analyze",
    "vacuum",
)

_IDENT = r'(?:"[^"]+"|[A-Za-z_][A-Za-z0-9_$]*)'

#: Tables whose DDL is incomplete or absent in this repository, confirmed by
#: cross-checking the reconstructed model against a live database. Treated as
#: opaque so the guard never reports a column on them — we cannot prove a
#: column is missing from a table we cannot fully see.
#:
#: ``guardrail_policies`` and ``closed_loop_actions`` have **no CREATE TABLE
#: anywhere** in ``src/`` or ``migrations/`` yet exist in production, so they
#: were applied out-of-band. The other two are missing columns added the same
#: way. Shrink this set by adding the missing DDL, not by deleting entries.
_INCOMPLETE_TABLES = frozenset(
    {
        "guardrail_policies",
        "closed_loop_actions",
        "prompt_versions",
        "pr_rejection_memory",
    }
)


def _clean_ident(raw: str) -> str:
    """Strip quoting and any ``schema.`` qualifier from an identifier."""
    name = raw.strip().strip('"')
    if "." in name:
        name = name.rsplit(".", 1)[-1]
    return name.lower()


@dataclass
class SchemaModel:
    """Columns per table, as reconstructed from the migration chain."""

    tables: dict[str, set[str]] = field(default_factory=dict)
    #: Views and other relations whose columns we cannot resolve statically.
    #: References to these are never reported — we cannot prove them wrong.
    opaque: set[str] = field(default_factory=set)
    #: Statements the parser chose not to interpret. Surfaced so coverage can
    #: be asserted; a guard that silently skips most of its input is theatre.
    skipped: int = 0
    parsed: int = 0

    def has_table(self, table: str) -> bool:
        return _clean_ident(table) in self.tables

    def columns(self, table: str) -> set[str]:
        return self.tables.get(_clean_ident(table), set())

    def knows(self, table: str, column: str) -> bool:
        """True when ``table`` is modelled and ``column`` exists on it."""
        t = _clean_ident(table)
        if t in self.opaque or t not in self.tables:
            return True  # unknown relation: cannot prove a violation
        return _clean_ident(column) in self.tables[t]


# ── Migration discovery ──────────────────────────────────────────────────


def _revision_ids(path: Path) -> tuple[str | None, list[str]]:
    """Return ``(revision, [down_revisions])`` for one migration module."""
    text = path.read_text(encoding="utf-8")
    rev = re.search(r'^revision(?::\s*\w[\w\[\], |]*)?\s*=\s*["\'](.+?)["\']', text, re.M)
    down_line = re.search(r"^down_revision[^=\n]*=\s*(.+)$", text, re.M)
    downs: list[str] = []
    if down_line:
        downs = re.findall(r'["\'](.+?)["\']', down_line.group(1))
    return (rev.group(1) if rev else None, downs)


def chain_order(versions_dir: Path) -> list[Path]:
    """Migration files in dependency order.

    Sorted topologically by ``down_revision`` so a later ``ADD COLUMN`` is
    applied after the ``CREATE TABLE`` it depends on. Falls back to filename
    order for anything unreachable, which keeps a malformed tree from silently
    dropping migrations out of the model.
    """
    files = sorted(p for p in versions_dir.glob("*.py") if p.name != "__init__.py")
    by_rev: dict[str, Path] = {}
    deps: dict[str, list[str]] = {}
    for p in files:
        rev, downs = _revision_ids(p)
        if rev:
            by_rev[rev] = p
            deps[rev] = downs

    ordered: list[Path] = []
    seen: set[str] = set()

    def visit(rev: str, stack: frozenset[str]) -> None:
        if rev in seen or rev not in by_rev or rev in stack:
            return
        for parent in deps.get(rev, []):
            visit(parent, stack | {rev})
        seen.add(rev)
        ordered.append(by_rev[rev])

    for rev in by_rev:
        visit(rev, frozenset())

    ordered.extend(p for p in files if p not in ordered)
    return ordered


def sql_statements(path: Path) -> Iterator[str]:
    """Yield every SQL string passed to ``op.execute`` inside ``upgrade()``.

    **Only ``upgrade()``.** Walking the whole module also collects
    ``downgrade()``, whose ``DROP TABLE`` undoes the ``CREATE TABLE`` that
    precedes it — replaying both nets an empty schema. (Found the hard way:
    every table modelled as zero columns.)

    ``ast`` folds implicitly concatenated string literals into one
    ``Constant`` automatically. ``f``-strings are yielded with their
    interpolations replaced by a placeholder — enough for the
    ``for table in [...]: op.execute(f"ALTER TABLE {table} ...")`` idiom the RLS
    migrations use, which creates no columns and is skipped downstream.
    """
    try:
        tree = ast.parse(path.read_text(encoding="utf-8"))
    except SyntaxError:
        return

    upgrade: ast.FunctionDef | ast.AsyncFunctionDef | None = None
    for node in tree.body:
        if isinstance(node, (ast.FunctionDef, ast.AsyncFunctionDef)) and node.name == "upgrade":
            upgrade = node
            break
    if upgrade is None:
        return

    literals = _literal_bindings(upgrade)

    # Calls inside a loop we expand below must not also be emitted by the
    # generic walk — that would yield the unsubstituted ``{}`` form alongside
    # the resolved ones, and an unresolved ADD COLUMN marks the whole table
    # opaque, blinding the guard on exactly the tables it matters most for.
    expanded_calls: set[int] = set()
    for node in ast.walk(upgrade):
        if isinstance(node, ast.For) and _is_expandable(node, literals):
            for sub in ast.walk(node):
                if isinstance(sub, ast.Call):
                    expanded_calls.add(id(sub))

    for node in ast.walk(upgrade):
        if isinstance(node, ast.For):
            yield from _expand_for(node, literals)
            continue
        if not isinstance(node, ast.Call) or id(node) in expanded_calls:
            continue
        func = node.func
        name = getattr(func, "attr", None) or getattr(func, "id", None)

        # Most migrations are raw SQL through op.execute, but a handful
        # (005, 076, 077, 078) use the alembic op API. Missing those silently
        # dropped real columns from the model — e.g. users.password_changed_at.
        if name in {"add_column", "drop_column", "create_table"}:
            stmt = _from_op_api(name, node)
            if stmt:
                yield stmt
            continue

        if name != "execute":
            continue
        for arg in node.args:
            if isinstance(arg, ast.Constant) and isinstance(arg.value, str):
                yield arg.value
            elif isinstance(arg, ast.JoinedStr):
                yield _render_fstring(arg, {})


def _from_op_api(name: str, node: ast.Call) -> str | None:
    """Translate an alembic ``op.*`` DDL call into equivalent SQL.

    Only the column-affecting calls matter here; types are irrelevant to a
    column-existence model, so a placeholder type is emitted.
    """
    def _str_arg(index: int) -> str | None:
        if len(node.args) <= index:
            return None
        arg = node.args[index]
        return arg.value if isinstance(arg, ast.Constant) and isinstance(arg.value, str) else None

    table = _str_arg(0)
    if not table:
        return None

    if name == "drop_column":
        col = _str_arg(1)
        return f"ALTER TABLE {table} DROP COLUMN {col}" if col else None

    if name == "add_column":
        # op.add_column("users", sa.Column("password_changed_at", ...))
        if len(node.args) > 1 and isinstance(node.args[1], ast.Call):
            inner = node.args[1]
            if inner.args and isinstance(inner.args[0], ast.Constant):
                col = inner.args[0].value
                if isinstance(col, str):
                    return f"ALTER TABLE {table} ADD COLUMN {col} TEXT"
        return None

    if name == "create_table":
        cols: list[str] = []
        for arg in node.args[1:]:
            if isinstance(arg, ast.Call) and arg.args:
                first = arg.args[0]
                if isinstance(first, ast.Constant) and isinstance(first.value, str):
                    cols.append(f"{first.value} TEXT")
        return f"CREATE TABLE {table} ({', '.join(cols)})" if cols else None

    return None


def _is_expandable(node: ast.For, literals: dict[str, list[tuple[str, ...]]]) -> bool:
    """True when ``_expand_for`` can resolve every iteration of this loop."""
    if not isinstance(node.iter, ast.Name) or not literals.get(node.iter.id):
        return False
    if isinstance(node.target, ast.Name):
        return True
    return isinstance(node.target, (ast.Tuple, ast.List)) and all(
        isinstance(e, ast.Name) for e in node.target.elts
    )


def _literal_bindings(fn: ast.AST) -> dict[str, list[tuple[str, ...]]]:
    """Collect ``name = [literal, ...]`` assignments in a function body.

    Migrations add columns in bulk via
    ``new_columns = [("request_body", "JSONB"), ...]`` followed by a loop.
    Without resolving these, those columns look absent and the guard would
    report false positives on the busiest table in the schema.
    """
    out: dict[str, list[tuple[str, ...]]] = {}
    for node in ast.walk(fn):
        if not isinstance(node, ast.Assign) or len(node.targets) != 1:
            continue
        target = node.targets[0]
        if not isinstance(target, ast.Name):
            continue
        if not isinstance(node.value, (ast.List, ast.Tuple)):
            continue
        rows: list[tuple[str, ...]] = []
        for elt in node.value.elts:
            if isinstance(elt, ast.Constant) and isinstance(elt.value, str):
                rows.append((elt.value,))
            elif isinstance(elt, (ast.Tuple, ast.List)) and all(
                isinstance(e, ast.Constant) and isinstance(e.value, str) for e in elt.elts
            ):
                rows.append(tuple(e.value for e in elt.elts))  # type: ignore[attr-defined]
            else:
                rows = []
                break
        if rows:
            out[target.id] = rows
    return out


def _render_fstring(node: ast.JoinedStr, env: dict[str, str]) -> str:
    """Render an f-string, substituting ``env`` and leaving the rest as ``{}``."""
    parts: list[str] = []
    for value in node.values:
        if isinstance(value, ast.Constant) and isinstance(value.value, str):
            parts.append(value.value)
        elif isinstance(value, ast.FormattedValue) and isinstance(value.value, ast.Name):
            parts.append(env.get(value.value.id, "{}"))
        else:
            parts.append("{}")
    return "".join(parts)


def _expand_for(
    node: ast.For, literals: dict[str, list[tuple[str, ...]]]
) -> Iterator[str]:
    """Yield one statement per iteration of a literal-driven ``for`` loop."""
    if not isinstance(node.iter, ast.Name):
        return
    rows = literals.get(node.iter.id)
    if not rows:
        return

    if isinstance(node.target, ast.Name):
        names = [node.target.id]
    elif isinstance(node.target, (ast.Tuple, ast.List)) and all(
        isinstance(e, ast.Name) for e in node.target.elts
    ):
        names = [e.id for e in node.target.elts]  # type: ignore[attr-defined]
    else:
        return

    for row in rows:
        if len(row) != len(names):
            continue
        env = dict(zip(names, row, strict=True))
        for sub in ast.walk(node):
            if not isinstance(sub, ast.Call):
                continue
            fname = getattr(sub.func, "attr", None) or getattr(sub.func, "id", None)
            if fname != "execute":
                continue
            for arg in sub.args:
                if isinstance(arg, ast.JoinedStr):
                    yield _render_fstring(arg, env)
                elif isinstance(arg, ast.Constant) and isinstance(arg.value, str):
                    yield arg.value


# ── DDL interpretation ───────────────────────────────────────────────────


def _strip_sql_comments(sql: str) -> str:
    """Remove ``--`` line comments and ``/* */`` block comments.

    Must run before whitespace is collapsed. Otherwise a leading comment line
    is joined onto the statement that follows it, the combined string starts
    with ``--``, and the statement is silently skipped — which cost 193 of 223
    statements in the raw-SQL tree, and with them the columns of ~20 tables.
    """
    out: list[str] = []
    i = 0
    in_str = False
    in_dollar = False
    while i < len(sql):
        if not in_str and sql.startswith("$$", i):
            in_dollar = not in_dollar
            out.append("$$")
            i += 2
            continue
        ch = sql[i]
        if not in_dollar and ch == "'":
            in_str = not in_str
        if not in_str and not in_dollar:
            if sql.startswith("--", i):
                nl = sql.find("\n", i)
                i = len(sql) if nl == -1 else nl
                continue
            if sql.startswith("/*", i):
                end = sql.find("*/", i + 2)
                i = len(sql) if end == -1 else end + 2
                continue
        out.append(ch)
        i += 1
    return "".join(out)


def _split_statements(sql: str) -> list[str]:
    """Split on ``;`` while respecting ``$$``-quoted bodies and string literals."""
    sql = _strip_sql_comments(sql)
    out: list[str] = []
    buf: list[str] = []
    i = 0
    in_dollar = False
    in_str = False
    while i < len(sql):
        ch = sql[i]
        if not in_str and sql.startswith("$$", i):
            in_dollar = not in_dollar
            buf.append("$$")
            i += 2
            continue
        if not in_dollar and ch == "'":
            in_str = not in_str
        if ch == ";" and not in_dollar and not in_str:
            out.append("".join(buf))
            buf = []
        else:
            buf.append(ch)
        i += 1
    if buf:
        out.append("".join(buf))
    return [s.strip() for s in out if s.strip()]


def _split_top_level_commas(body: str) -> list[str]:
    """Split a ``CREATE TABLE`` body on commas at paren depth zero."""
    parts: list[str] = []
    depth = 0
    buf: list[str] = []
    for ch in body:
        if ch == "(":
            depth += 1
        elif ch == ")":
            depth -= 1
        if ch == "," and depth == 0:
            parts.append("".join(buf))
            buf = []
        else:
            buf.append(ch)
    if buf:
        parts.append("".join(buf))
    return [p.strip() for p in parts if p.strip()]


def _columns_from_body(body: str) -> set[str]:
    cols: set[str] = set()
    for item in _split_top_level_commas(body):
        lowered = item.lower().lstrip()
        if lowered.startswith(_NON_COLUMN_PREFIXES):
            continue
        m = re.match(rf"^({_IDENT})\s", item.strip())
        if m:
            cols.add(_clean_ident(m.group(1)))
    return cols


def _apply(model: SchemaModel, stmt: str) -> None:
    """Apply one DDL statement to the model."""
    s = " ".join(stmt.split())
    lowered = s.lower()

    if lowered.startswith(_IGNORED_STATEMENT_PREFIXES) or lowered.startswith("do "):
        return

    # CREATE TABLE [IF NOT EXISTS] <t> ( ... )
    m = re.match(
        rf"create table\s+(?:if not exists\s+)?({_IDENT}(?:\.{_IDENT})?)\s*\((.*)\)",
        lowered,
        re.S,
    )
    if m:
        table = _clean_ident(m.group(1))
        original = re.search(
            rf"create table\s+(?:if not exists\s+)?{_IDENT}(?:\.{_IDENT})?\s*\((.*)\)",
            s,
            re.S | re.I,
        )
        body = original.group(1) if original else m.group(2)
        # PARTITION OF / LIKE inherit their parent's columns.
        parent = re.search(rf"partition of\s+({_IDENT})", lowered)
        cols = _columns_from_body(body)
        if parent:
            cols |= model.columns(parent.group(1))
        model.tables.setdefault(table, set()).update(cols)
        model.parsed += 1
        return

    m = re.match(rf"create table\s+(?:if not exists\s+)?({_IDENT})\s+partition of\s+({_IDENT})", lowered)
    if m:
        model.tables.setdefault(_clean_ident(m.group(1)), set()).update(
            model.columns(m.group(2))
        )
        model.parsed += 1
        return

    # CREATE [OR REPLACE] [MATERIALIZED] VIEW <v> — columns unresolvable.
    m = re.match(rf"create\s+(?:or replace\s+)?(?:materialized\s+)?view\s+({_IDENT})", lowered)
    if m:
        model.opaque.add(_clean_ident(m.group(1)))
        model.parsed += 1
        return

    m = re.match(rf"drop table\s+(?:if exists\s+)?({_IDENT}(?:\.{_IDENT})?)", lowered)
    if m:
        model.tables.pop(_clean_ident(m.group(1)), None)
        model.parsed += 1
        return

    m = re.match(rf"alter table\s+(?:if exists\s+)?(?:only\s+)?({_IDENT}(?:\.{_IDENT})?)\s+(.*)", s, re.I | re.S)
    if m:
        table = _clean_ident(m.group(1))
        actions = m.group(2)
        touched = False
        for action in _split_top_level_commas(actions):
            a = " ".join(action.split())
            al = a.lower()
            # A column name we could not resolve statically (an unexpanded
            # f-string placeholder). We cannot prove any column is *absent*
            # from this table any more, so mark it opaque rather than risk a
            # false positive — a guard that cries wolf gets switched off.
            if re.match(r"add column\s+(?:if not exists\s+)?\{\}", a, re.I):
                model.opaque.add(table)
                touched = True
                continue
            add = re.match(rf"add column\s+(?:if not exists\s+)?({_IDENT})", a, re.I)
            if add:
                model.tables.setdefault(table, set()).add(_clean_ident(add.group(1)))
                touched = True
                continue
            drop = re.match(rf"drop column\s+(?:if exists\s+)?({_IDENT})", a, re.I)
            if drop:
                model.tables.setdefault(table, set()).discard(_clean_ident(drop.group(1)))
                touched = True
                continue
            ren = re.match(rf"rename column\s+({_IDENT})\s+to\s+({_IDENT})", a, re.I)
            if ren:
                cols = model.tables.setdefault(table, set())
                cols.discard(_clean_ident(ren.group(1)))
                cols.add(_clean_ident(ren.group(2)))
                touched = True
                continue
            ren_t = re.match(rf"rename to\s+({_IDENT})", a, re.I)
            if ren_t:
                model.tables[_clean_ident(ren_t.group(1))] = model.tables.pop(table, set())
                table = _clean_ident(ren_t.group(1))
                touched = True
                continue
            if al.startswith(("enable ", "disable ", "no force", "force ", "set ", "owner to", "add constraint", "drop constraint", "alter column", "attach partition", "detach partition")):
                touched = True
        if touched:
            model.parsed += 1
        else:
            model.skipped += 1
        return

    model.skipped += 1


def build(
    versions_dir: Path | None = None, legacy_sql_dir: Path | None = None
) -> SchemaModel:
    """Reconstruct the schema by replaying every migration.

    Reads **both** DDL sources:

    * the alembic chain (``src/eden/db_migrations/versions``), in dependency
      order; and
    * the frozen raw-SQL tree (``migrations/*.sql``), in filename order.

    The second is not optional. ``docs/ops/migration-matrix.md`` records that
    tables such as ``role_definitions`` and the SCIM/GitHub tables exist *only*
    there, with no alembic equivalent — and production has them, because they
    were applied by hand. Modelling the alembic chain alone therefore reports
    real columns as missing: verified against a live database, ``usage_events``
    lost 7 columns, ``labeling_items`` 7, ``prompt_versions`` 2. Every one would
    have been a false positive, and false positives are how a guard gets
    switched off.

    The legacy tree is applied first so later alembic migrations can alter the
    tables it defines.
    """
    root = Path(__file__).resolve().parents[3]
    if versions_dir is None:
        versions_dir = Path(__file__).resolve().parent / "versions"
    if legacy_sql_dir is None:
        legacy_sql_dir = root / "migrations"

    model = SchemaModel()

    if legacy_sql_dir.is_dir():
        for path in sorted(legacy_sql_dir.glob("*.sql")):
            for stmt in _split_statements(path.read_text(encoding="utf-8")):
                _apply(model, stmt)

    for path in chain_order(versions_dir):
        for raw in sql_statements(path):
            for stmt in _split_statements(raw):
                _apply(model, stmt)

    model.opaque |= _INCOMPLETE_TABLES
    return model


__all__ = ["SchemaModel", "build", "chain_order", "sql_statements"]
