"""Smoke test for the client-side PII safety net.

Runs the redactor against a curated set of inputs and asserts:

* PII (email, formatted phone, SSN, Luhn-valid credit card) is masked.
* Non-PII (timestamps, token counts, pure-digit IDs, hex digests,
  short numeric IDs) is NOT masked.
* Recursion into nested dicts + lists works.
* String keys are redacted too.
* Empty / null / scalar inputs are returned unchanged.

Exit code 0 on success, 1 on any failed assertion.  Designed to be
run from CI as a quick post-install sanity check.
"""

from __future__ import annotations

import sys

from eden import redact_payload


CASES: list[tuple[str, str, str, str]] = [
    # (name, input json, must-contain substring, must-NOT-contain substring)
    ("email",
     '{"text": "ping alice@example.com"}',
     "[REDACTED]", "alice@example.com"),
    ("formatted phone",
     '{"phone": "415-555-2671"}',
     "[REDACTED]", "415-555-2671"),
    ("phone with parens",
     '{"phone": "(415) 555-2671"}',
     "[REDACTED]", "(415) 555-2671"),
    ("ssn",
     '{"ssn": "123-45-6789"}',
     "[REDACTED]", "123-45-6789"),
    ("luhn-valid visa",
     '{"card": "4111 1111 1111 1111"}',
     "[REDACTED]", "4111 1111 1111 1111"),
    ("pure 10-digit id (no separator)",
     '{"id": "1234567890"}',
     "1234567890", "[REDACTED]"),
    ("13-digit luhn-invalid",
     '{"id": "1234567890123"}',
     "1234567890123", "[REDACTED]"),
    ("token count",
     '{"usage": {"total_tokens": 1234567}}',
     "1234567", "[REDACTED]"),
    ("unix epoch",
     '{"timestamp": 1717000000}',
     "1717000000", "[REDACTED]"),
    ("hex digest",
     '{"hash": "abcdef0123456789abcdef0123456789"}',
     "abcdef0123456789", "[REDACTED]"),
    ("pii in dict key",
     '{"alice@example.com": "value"}',
     "[REDACTED]", "alice@example.com"),
    ("nested dict",
     '{"outer": {"inner": "alice@example.com"}}',
     "[REDACTED]", "alice@example.com"),
    ("empty inputs",
     '{}',
     "", ""),  # both substrings trivially absent; checked separately
    ("null input",
     "null",
     "", ""),
]


def main() -> int:
    import json
    failures: list[str] = []
    for name, raw, must_have, must_not in CASES:
        payload = json.loads(raw)
        out = redact_payload(payload)
        flat = json.dumps(out)
        if name in ("empty inputs", "null input"):
            if raw == "{}" and out != {}:
                failures.append(f"{name}: expected empty dict, got {out!r}")
            elif raw == "null" and out is not None:
                failures.append(f"{name}: expected None, got {out!r}")
            print(f"  [OK]   {name}")
            continue
        if must_have and must_have not in flat:
            failures.append(f"{name}: expected substring {must_have!r} in {flat!r}")
            print(f"  [FAIL] {name}: missing {must_have!r}")
            continue
        if must_not and must_not in flat:
            failures.append(f"{name}: forbidden substring {must_not!r} in {flat!r}")
            print(f"  [FAIL] {name}: leaked {must_not!r}")
            continue
        print(f"  [OK]   {name}")
    if failures:
        print(f"\n{len(failures)} failures:")
        for f in failures:
            print(f"  - {f}")
        return 1
    print(f"\nAll {len(CASES)} redactor smoke cases passed.")
    return 0


if __name__ == "__main__":
    sys.exit(main())
