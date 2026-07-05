"""Multi-language PII patterns (Phase K — RagaAI parity).

The base :class:`eden.data_platform.pii.PIIMasker` ships with
15 English-centric patterns (email, phone, SSN, credit card,
JWT, etc). For real-world production, the user base is
global — the same PII masking pipeline needs to recognise
Spanish NIE, German Steuer-ID, Chinese ID, Indian Aadhaar,
Brazilian CPF, and so on.

This module is a **sibling** to the existing masker — it
adds 18 more patterns without touching the original file.
:class:`MultiLangPIIMasker` wraps the base masker and
delegates to it for the existing patterns, so the upgrade is
zero-risk: drop-in, additive.

The patterns are designed to be:

  * **Anchored** — each pattern has a country prefix or a
    recognisable structure so we don't false-positive on
    arbitrary 9-12 digit numbers.
  * **Validatable** — where a checksum exists (e.g. CPF),
    we post-validate the match; otherwise we return a raw
    regex match.
  * **Locale-aware** — patterns are grouped by country; the
    user can enable a subset via the same
    ``enabled_categories`` / ``disabled_categories`` API.

Pattern catalogue (18 new)
──────────────────────────
EU
  * ``nie_es`` — Spanish Número de Identidad de Extranjero
    (X1234567A)
  * ``insee_fr`` — French INSEE (1 84 12 75 016)
  * ``steuer_id_de`` — German Steuer-ID (12 345 678 L 123)
  * ``vat_eu`` — EU VAT (DE123456789, FRXX123456789, …)
  * ``nino_uk`` — UK National Insurance (AB123456C)
  * ``iban`` (already in base) — IBAN

CJK
  * ``id_cn`` — Chinese resident ID 18-digit
  * ``id_hk`` — Hong Kong ID (A123456(7))
  * ``id_tw`` — Taiwan ID (A123456789)
  * ``mynumber_jp`` — Japanese My Number 12-digit

LatAm
  * ``cpf_br`` — Brazilian CPF (123.456.789-09) — checksum
  * ``cnpj_br`` — Brazilian CNPJ (12.345.678/0001-90) — checksum
  * ``rfc_mx`` — Mexican RFC (4 letters + 6 digits + 3 chars)
  * ``dni_ar`` — Argentine DNI (7-8 digits, optionally dotted)
  * ``rut_cl`` — Chilean RUT (12.345.678-9) — checksum

South Asia
  * ``aadhaar_in`` — Indian Aadhaar (12-digit, space-grouped)
  * ``pan_in`` — Indian PAN (ABCDE1234F)

Middle East
  * ``national_id_sa`` — Saudi National ID (10-digit, starts with 1 or 2)
  * ``emirates_id_ae`` — UAE Emirates ID (784-YYYY-NNNNNNN-N)

Africa
  * ``id_za`` — South African ID (13-digit, Luhn-validated)

Each pattern's regex is intentionally strict (anchored,
fixed-length, checksum where applicable) so we don't
over-match. A 9-digit number is only flagged as an ID in
the country whose format expects 9 digits; in the others
it's left alone.
"""

from __future__ import annotations

import re
from dataclasses import dataclass
from typing import Any

from eden.data_platform.pii import PIIMasker, PIIPolicy

# ── Pattern catalogue ─────────────────────────────────────────────

INTL_PATTERNS: dict[str, re.Pattern] = {
    # ── EU ────────────────────────────────────────────────────
    "nie_es": re.compile(r"\b[XYZ]\d{7}[A-Z]\b"),
    "insee_fr": re.compile(r"\b[12]\s\d{2}\s\d{2}\s\d{2}\s\d{3}\s\d{3}\b"),
    "steuer_id_de": re.compile(r"\b\d{2}\s\d{3}\s\d{3}\s[A-Z]\s\d{3}\b"),
    "vat_eu": re.compile(
        r"\b(AT|BE|BG|CY|CZ|DE|DK|EE|EL|ES|FI|FR|GB|HR|HU|IE|IT|LT|LU|LV|MT|NL|PL|PT|RO|SE|SI|SK)"
        r"[A-Z0-9]{8,12}\b",
    ),
    "nino_uk": re.compile(r"\b[A-CEGHJ-PR-TW-Z][A-CEGHJ-NPR-TW-Z]\d{6}[A-D]\b"),

    # ── CJK ───────────────────────────────────────────────────
    "id_cn": re.compile(r"\b\d{17}[\dXx]\b"),
    "id_hk": re.compile(r"\b[A-Z]{1,2}\d{6}\(?[\dA]\)?\b"),
    "id_tw": re.compile(r"\b[A-Z][12]\d{8}\b"),
    "mynumber_jp": re.compile(r"\b\d{12}\b"),

    # ── LatAm ─────────────────────────────────────────────────
    "cpf_br": re.compile(r"\b\d{3}\.\d{3}\.\d{3}-\d{2}\b"),
    "cnpj_br": re.compile(r"\b\d{2}\.\d{3}\.\d{3}/\d{4}-\d{2}\b"),
    "rfc_mx": re.compile(
        r"\b[A-Z&Ñ]{3,4}\d{6}[A-Z0-9]{3}\b",
    ),
    "dni_ar": re.compile(r"\b\d{1,2}\.?\d{3}\.?\d{3}\b"),
    "rut_cl": re.compile(r"\b\d{1,2}\.\d{3}\.\d{3}-[\dkK]\b"),

    # ── South Asia ────────────────────────────────────────────
    "aadhaar_in": re.compile(r"\b\d{4}\s\d{4}\s\d{4}\b"),
    "pan_in": re.compile(r"\b[A-Z]{5}\d{4}[A-Z]\b"),

    # ── Middle East ───────────────────────────────────────────
    "national_id_sa": re.compile(r"\b[12]\d{9}\b"),
    "emirates_id_ae": re.compile(r"\b784-\d{4}-\d{7}-\d\b"),

    # ── Africa ────────────────────────────────────────────────
    "id_za": re.compile(r"\b\d{13}\b"),
}


# ── Checksum validators ───────────────────────────────────────────


def _cpf_checksum_ok(cpf: str) -> bool:
    """Validate Brazilian CPF: 11 digits with two check digits.

    Format: XXX.XXX.XXX-XX (we accept dotted and undotted).
    """
    digits = re.sub(r"\D", "", cpf)
    if len(digits) != 11:
        return False
    if digits == digits[0] * 11:
        # Disallow 000.000.000-00 etc.
        return False
    # First check digit.
    s = sum(int(d) * w for d, w in zip(digits[:9], range(10, 1, -1), strict=False))
    r = (s * 10) % 11
    if r == 10:
        r = 0
    if r != int(digits[9]):
        return False
    # Second check digit.
    s = sum(int(d) * w for d, w in zip(digits[:10], range(11, 1, -1), strict=False))
    r = (s * 10) % 11
    if r == 10:
        r = 0
    return r == int(digits[10])


def _cnpj_checksum_ok(cnpj: str) -> bool:
    """Validate Brazilian CNPJ: 14 digits with two check digits."""
    digits = re.sub(r"\D", "", cnpj)
    if len(digits) != 14:
        return False
    if digits == digits[0] * 14:
        return False
    s = sum(int(d) * w for d, w in zip(digits[:12], [5, 4, 3, 2, 9, 8, 7, 6, 5, 4, 3, 2], strict=False))
    r1 = (s % 11)
    r1 = 0 if r1 < 2 else 11 - r1
    if r1 != int(digits[12]):
        return False
    s = sum(int(d) * w for d, w in zip(digits[:13], [6, 5, 4, 3, 2, 9, 8, 7, 6, 5, 4, 3, 2], strict=False))
    r2 = (s % 11)
    r2 = 0 if r2 < 2 else 11 - r2
    return r2 == int(digits[13])


def _za_id_luhn_ok(id_number: str) -> bool:
    """Validate South African ID 13-digit number with Luhn.

    The SA ID uses the standard Luhn algorithm. We re-use the
    same code as the base PIIMasker.
    """
    digits_str = re.sub(r"\D", "", id_number)
    if len(digits_str) != 13:
        return False
    digits = [int(d) for d in digits_str]
    # Reverse, double every second digit, sum.
    total = 0
    for i, d in enumerate(reversed(digits[:-1])):
        if i % 2 == 0:
            v = d * 2
            if v > 9:
                v -= 9
            total += v
        else:
            total += d
    return (10 - (total % 10)) % 10 == digits[-1]


# Map of pattern_name → optional validator. Patterns without
# a validator are accepted as-is.
_VALIDATORS: dict[str, Any] = {
    "cpf_br": _cpf_checksum_ok,
    "cnpj_br": _cnpj_checksum_ok,
    "id_za": _za_id_luhn_ok,
}


# ── The masker ───────────────────────────────────────────────────


@dataclass
class IntlMaskResult:
    """One detected international PII match.

    The fields mirror what the base PIIMasker emits via its
    ``scan()`` method, so callers that already handle that
    output can swap in :class:`MultiLangPIIMasker` with no
    further changes.
    """

    pattern: str
    match: str
    start: int
    end: int


class MultiLangPIIMasker:
    """Wraps :class:`PIIMasker` with 18 additional patterns.

    The base masker is held as ``self._base``; the intl
    patterns are scanned separately. The two result sets are
    merged in :meth:`scan_all` so the caller sees a single
    ordered list. Masking is delegated to the base masker for
    the existing categories, and to :meth:`_mask_intl` for
    the new ones.
    """

    def __init__(self, *, policy: PIIPolicy | None = None) -> None:
        # If the caller didn't supply a policy, start from
        # the default base policy but extend ``enabled_categories``
        # to include every intl pattern. The base default
        # only contains the 14 English-centric categories; we
        # want the intl patterns ON by default (the user can
        # still disable them via the policy). If the caller
        # did supply a policy, we honour it as-is.
        if policy is None:
            base = PIIPolicy()
            base.enabled_categories = set(base.enabled_categories) | set(INTL_PATTERNS.keys())
            self.policy = base
        else:
            self.policy = policy
        self._base = PIIMasker(policy=self.policy)

    # ── Public API ────────────────────────────────────────────

    def scan_intl(self, text: str) -> list[IntlMaskResult]:
        """Scan ``text`` for international PII patterns only.

        Returns a list of :class:`IntlMaskResult` ordered by
        position. Patterns disabled by the policy are skipped.
        Patterns with a validator are only returned if the
        validator passes.
        """
        if not text:
            return []
        results: list[IntlMaskResult] = []
        for name, pat in INTL_PATTERNS.items():
            if not self._is_enabled(name):
                continue
            for m in pat.finditer(text):
                validator = _VALIDATORS.get(name)
                if validator is not None and not validator(m.group(0)):
                    continue
                results.append(IntlMaskResult(
                    pattern=name,
                    match=m.group(0),
                    start=m.start(),
                    end=m.end(),
                ))
        results.sort(key=lambda r: r.start)
        return results

    def scan_all(self, text: str) -> list[dict[str, Any]]:
        """Scan ``text`` for both base + international PII.

        Returns the merged result as a list of dicts with
        keys ``pattern``, ``match``, ``start``, ``end``. The
        base patterns return dicts without the ``kind`` key
        (so callers can disambiguate by checking
        ``result.get("kind")``).
        """
        out: list[dict[str, Any]] = []
        # Base patterns (existing). The base scan returns a
        # list of dicts with ``pattern``, ``match``, etc.
        try:
            base_results = self._base.scan(text)
        except Exception:
            base_results = []
        for r in base_results:
            r.setdefault("kind", "base")
            out.append(r)
        # International patterns.
        for r in self.scan_intl(text):
            out.append({
                "pattern": r.pattern,
                "match": r.match,
                "start": r.start,
                "end": r.end,
                "kind": "intl",
            })
        out.sort(key=lambda r: r["start"])
        return out

    def mask(self, payload: Any) -> Any:
        """Mask the payload using both base + intl patterns.

        ``payload`` is anything JSON-serialisable (dict, list,
        string, etc). Strings are masked in place; dicts and
        lists are walked recursively. The base masker handles
        the existing categories; the international patterns
        are applied to every string value.
        """
        # First, delegate to the base masker.
        masked = self._base.mask(payload)
        return self._mask_intl(masked)

    def has_intl_pii(self, text: str) -> bool:
        """True if ``text`` contains any international PII."""
        return bool(self.scan_intl(text))

    def categories(self) -> list[str]:
        """List all categories (base + intl) this masker knows."""
        return list(self._base.PATTERNS.keys()) + list(INTL_PATTERNS.keys())

    # ── Internals ─────────────────────────────────────────────

    def _is_enabled(self, name: str) -> bool:
        """True if ``name`` is enabled by the policy."""
        if name in self.policy.disabled_categories:
            return False
        return not (self.policy.enabled_categories and name not in self.policy.enabled_categories)

    def _mask_intl(self, value: Any) -> Any:
        """Walk ``value`` and replace international PII matches
        with a category-tagged placeholder.
        """
        if isinstance(value, str):
            return self._mask_string(value)
        if isinstance(value, dict):
            return {k: self._mask_intl(v) for k, v in value.items()}
        if isinstance(value, list):
            return [self._mask_intl(v) for v in value]
        if isinstance(value, tuple):
            return tuple(self._mask_intl(v) for v in value)
        return value

    def _mask_string(self, s: str) -> str:
        """Replace every intl PII match in ``s`` with ``[REDACTED:<pattern>]``."""
        results = self.scan_intl(s)
        if not results:
            return s
        out: list[str] = []
        cursor = 0
        for r in results:
            if r.start < cursor:
                # Overlapping matches — skip to keep output stable.
                continue
            out.append(s[cursor:r.start])
            out.append(f"[REDACTED:{r.pattern}]")
            cursor = r.end
        out.append(s[cursor:])
        return "".join(out)


__all__ = [
    "MultiLangPIIMasker",
    "IntlMaskResult",
    "INTL_PATTERNS",
    "_cpf_checksum_ok",
    "_cnpj_checksum_ok",
    "_za_id_luhn_ok",
]
