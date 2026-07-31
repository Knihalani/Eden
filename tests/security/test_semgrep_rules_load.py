"""The semgrep rule files must actually parse.

Two of the four did not, and had not for as long as they had existed:

* ``.semgrep/rules/auth-bypass.yml`` wrote ``pattern: user: dict =
  get_current_user`` unquoted. The value contains ``": "``, which YAML reads
  as a nested mapping key, so the document was malformed from line 9 onward.
* ``.semgrep/strict/hardcoded-secrets.yml`` wrote a regex as
  ``'...["\\'][^"\\']+["\\']'``. Inside a *single-quoted* YAML scalar a quote
  is escaped by **doubling** it, not with a backslash — so the scalar ended at
  the first ``'`` and the remainder of the regex was parsed as YAML structure.

Both files therefore loaded zero rules. The failure mode is the one this
codebase keeps producing: nothing raised, nothing warned, and a security
scanner with unparseable rules looks exactly like a security scanner that
found nothing. The rules that were silently absent include the hardcoded-JWT
and hardcoded-API-key detectors.

Nothing currently invokes semgrep (it appears only in ``CODEOWNERS``), so no
scan was actually skipped — but the rules would have failed to load the moment
anyone wired it up, which is the worst possible time to discover it.

The regex check is deliberately separate from the YAML check: a file can parse
perfectly and still carry a ``pattern-regex`` that no engine will compile, and
that is the same class of silent failure one level down.
"""

from __future__ import annotations

import re
from pathlib import Path

import pytest
import yaml

SEMGREP_DIR = Path(__file__).resolve().parents[2] / ".semgrep"
RULE_FILES = sorted(SEMGREP_DIR.rglob("*.yml")) + sorted(SEMGREP_DIR.rglob("*.yaml"))


def test_there_are_rule_files_to_check() -> None:
    """Guards the guard: an empty glob would make every test below vacuous."""
    assert RULE_FILES, f"no semgrep rule files found under {SEMGREP_DIR}"


@pytest.mark.parametrize("path", RULE_FILES, ids=lambda p: p.name)
def test_rule_file_is_valid_yaml(path: Path) -> None:
    try:
        document = yaml.safe_load(path.read_text(encoding="utf-8"))
    except yaml.YAMLError as exc:
        pytest.fail(
            f"{path.relative_to(SEMGREP_DIR.parent)} is not valid YAML, so "
            f"semgrep loads none of its rules:\n{exc}\n\n"
            "Common causes here: an unquoted pattern containing ': ', or a "
            "single-quoted scalar using \\' instead of '' to escape a quote."
        )

    assert isinstance(document, dict), "a rule file must be a mapping"
    rules = document.get("rules")
    assert isinstance(rules, list) and rules, (
        f"{path.name} parsed but declares no rules, which is indistinguishable "
        "from a clean scan"
    )


@pytest.mark.parametrize("path", RULE_FILES, ids=lambda p: p.name)
def test_every_rule_is_well_formed(path: Path) -> None:
    document = yaml.safe_load(path.read_text(encoding="utf-8"))
    for rule in document["rules"]:
        rule_id = rule.get("id", "<missing id>")
        assert rule.get("id"), f"a rule in {path.name} has no id"
        assert rule.get("message"), f"{rule_id} has no message"
        assert rule.get("severity") in {"ERROR", "WARNING", "INFO"}, (
            f"{rule_id} has severity {rule.get('severity')!r}"
        )
        assert any(
            key in rule for key in ("pattern", "pattern-regex", "patterns", "pattern-either")
        ), f"{rule_id} matches nothing"

        expression = rule.get("pattern-regex")
        if expression is not None:
            try:
                re.compile(expression)
            except re.error as exc:
                pytest.fail(f"{rule_id}: pattern-regex does not compile: {exc}")


def test_the_secret_detectors_still_detect() -> None:
    """The quoting fix must not have changed what the regexes mean.

    ``\\'`` inside a character class is just ``'``, so the corrected form is
    equivalent — but "equivalent" is exactly the sort of claim worth executing
    rather than asserting, since the whole bug was a quoting mistake.
    """
    path = SEMGREP_DIR / "strict" / "hardcoded-secrets.yml"
    rules = {r["id"]: r for r in yaml.safe_load(path.read_text())["rules"]}

    jwt = rules["hardcoded-jwt-secret"]["pattern-regex"]
    assert re.search(jwt, 'JWT_SECRET = "hunter2hunter2"')
    assert re.search(jwt, "secret_key = 'abc'")
    assert not re.search(jwt, 'jwt_secret = os.environ["JWT_SECRET"]'), (
        "the detector fires on the correct pattern (reading from the "
        "environment), which would make it noise people turn off"
    )

    api = rules["hardcoded-api-key"]["pattern-regex"]
    assert re.search(api, "api_key = 'abcdefghijklmnopqrst'")
    assert not re.search(api, "api_key = 'short'"), (
        "the {16,} length bound is gone; short non-secret values will match"
    )
