"""The PII literal prefilter must be *exactly* equivalent to its regexes.

Masking costs ~188us per KiB and is linear — a 512 KiB body is ~96ms, and it
runs inline on the gateway's telemetry-emit path. Measured on 128 KiB of
ordinary prose, all 14 patterns scanned the full text and **none matched**: the
whole 23.8ms found nothing.

Three patterns cannot match without a literal substring, and testing for that
literal is 7.9-9.6x cheaper than running the regex. But skipping a pattern that
would have matched is a **PII leak**, so "probably equivalent" is not good
enough. This module is the proof obligation for
``PIIMasker._REQUIRED_LITERALS``:

* every literal set is checked against its own regex over a large adversarial
  corpus, asserting the prefilter is never False when the regex matches
* the regexes are asserted case-sensitive, because a plain ``in`` test is only
  sound if the pattern is
* the end-to-end masker output is compared with the prefilter forcibly
  disabled, so the optimisation cannot change a single byte of result

Adding an entry to ``_REQUIRED_LITERALS`` without extending this file is a
PII-safety regression, and ``test_every_configured_literal_is_covered`` fails
if that happens.
"""

from __future__ import annotations

import random
import string

import pytest

from eden.data_platform.pii import PIIMasker

# Alphabet chosen to generate near-misses: the marker characters, separators
# the patterns care about, and the alphanumerics their bodies consume.
_ALPHABET = string.ascii_letters + string.digits + " ._:/@-=+%&?#"


def _corpus(n: int, seed: int) -> list[str]:
    rnd = random.Random(seed)
    out: list[str] = [
        "",
        " ",
        "plain prose with nothing sensitive in it whatsoever",
        # Positive cases per pattern.
        "eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjMifQ.SflKxwRJSMeKKF2QT4",
        "https://user:pass@example.com/path",
        "http://u:p@h/p",
        "ftp://a:b@host/p",
        "sk_live_abcdefghijklmnopqrstuvwx",
        "sk-abcdefghijklmnopqrstuvwxyz",
        "pk_test_abcdefghijklmnopqrstuvwx",
        "api_key=abcdefghijklmnopqrstuvwxyz",
        "api-key=abcdefghijklmnopqrstuvwxyz",
        "apikey_abcdefghijklmnopqrstuvwxyz",
        # Marker-only, must not crash the prefilter and must agree with regex.
        "eyJ",
        "://",
        "sk",
        "pk",
        "api_key",
        # Near misses.
        "eyj lowercase marker",
        "https//no-colon-slash",
        "s k _live_abcdefghijklmnopqrst",
        "SK_LIVE_ABCDEFGHIJKLMNOPQRSTUV",
        "EYJHBGCIOIJIUZI1NIJ9.X.Y",
        "HTTPS://USER:PASS@EXAMPLE.COM",
    ]
    for _ in range(n):
        length = rnd.randint(1, 120)
        out.append("".join(rnd.choice(_ALPHABET) for _ in range(length)))
    # Also splice markers into random noise, so positives are well represented.
    for _ in range(n // 4):
        noise = "".join(rnd.choice(_ALPHABET) for _ in range(rnd.randint(0, 40)))
        marker = rnd.choice(["eyJ", "://", "sk", "pk", "api_key", "apikey"])
        tail = "".join(rnd.choice(string.ascii_letters + string.digits)
                       for _ in range(rnd.randint(0, 40)))
        out.append(noise + marker + tail)
    return out


@pytest.fixture(scope="module")
def masker() -> PIIMasker:
    return PIIMasker()


@pytest.fixture(scope="module")
def corpus() -> list[str]:
    return _corpus(20_000, seed=20260730)


def test_every_configured_literal_is_covered(masker: PIIMasker) -> None:
    """No entry may be added to _REQUIRED_LITERALS without a proof here."""
    proven = {"jwt", "url_with_creds", "api_key"}
    configured = set(PIIMasker._REQUIRED_LITERALS)
    assert configured == proven, (
        f"_REQUIRED_LITERALS has changed ({configured ^ proven}). Every entry "
        "is a PII-safety claim and needs an equivalence proof in this file — "
        "extend `proven` only after adding the corresponding assertions."
    )


#: Exact source of each prefiltered regex at the time its equivalence was
#: proven. See ``test_the_prefiltered_patterns_have_not_been_widened``.
_PROVEN_PATTERN_SOURCES = {
    "jwt": r"\beyJ[a-zA-Z0-9_-]*\.[a-zA-Z0-9_-]*\.[a-zA-Z0-9_-]*\b",
    "url_with_creds": r"\b(?:https?|ftp)://[^:]+:[^@]+@\S+\b",
    "api_key": (
        r"\b(?:sk|pk|api[_-]?key)[_-]?(?:live|test)?[_=]?"
        r"[A-Za-z0-9]{20,}\b"
    ),
}


def test_the_prefiltered_patterns_have_not_been_widened(
    masker: PIIMasker,
) -> None:
    """The other half of the proof obligation, and the easy one to miss.

    ``test_every_configured_literal_is_covered`` guards the *literals*. Nothing
    guarded the *regexes* — so widening one silently invalidated the
    equivalence. Concretely: this pattern used to be
    ``(sk-|pk-|rk-)[a-zA-Z0-9_-]{24,64}``. Restoring the ``rk-`` alternative, or
    adding ``ghp_`` / ``xoxb-``, gives ``api_key`` a form with no literal in
    ``_REQUIRED_LITERALS``, and ``_can_skip`` starts skipping a pattern that
    would have matched — a PII leak with no failing test.

    The generated corpus cannot catch this on its own: its marker list is
    derived from the literals under test, so an unlisted alternative is absent
    from the corpus too. The test is self-confirming on exactly the axis that
    matters, which is why this snapshot exists instead.
    """
    for cat, expected in _PROVEN_PATTERN_SOURCES.items():
        pattern = masker._active_patterns.get(cat)
        assert pattern is not None, f"{cat} is no longer an active pattern"
        assert pattern.pattern == expected, (
            f"the {cat!r} regex changed.\n"
            f"  proven: {expected!r}\n"
            f"  now:    {pattern.pattern!r}\n"
            "Its literal prefilter in PIIMasker._REQUIRED_LITERALS may no "
            "longer be sound. Re-derive the mandatory literals for every "
            "alternative, extend the corpus in this file with a positive case "
            "for each, confirm the equivalence tests still pass, and only then "
            "update this snapshot."
        )


@pytest.mark.parametrize("pii_type", sorted(PIIMasker._REQUIRED_LITERALS))
def test_prefilter_never_skips_a_real_match(
    masker: PIIMasker, corpus: list[str], pii_type: str
) -> None:
    """The one-directional property that matters.

    A prefilter that passes when the regex would not match only costs time. A
    prefilter that skips when the regex *would* match leaks PII.
    """
    pattern = masker._active_patterns.get(pii_type)
    if pattern is None:
        pytest.skip(f"{pii_type} not in the default active set")

    misses: list[str] = []
    matched_at_least_once = False
    for text in corpus:
        if pattern.search(text):
            matched_at_least_once = True
            if masker._can_skip(pii_type, text):
                misses.append(text)
    assert not misses, (
        f"{pii_type}: prefilter skipped {len(misses)} text(s) the regex "
        f"matches — that is a PII leak. First: {misses[0]!r}"
    )
    assert matched_at_least_once, (
        f"{pii_type}: the corpus contains no positive case, so this test "
        "proves nothing. Add one."
    )


@pytest.mark.parametrize("pii_type", sorted(PIIMasker._REQUIRED_LITERALS))
def test_the_pattern_is_case_sensitive(masker: PIIMasker, pii_type: str) -> None:
    """A substring test is only sound for a case-sensitive pattern."""
    import re

    pattern = masker._active_patterns.get(pii_type)
    if pattern is None:
        pytest.skip(f"{pii_type} not active")
    assert not (pattern.flags & re.IGNORECASE), (
        f"{pii_type} is case-insensitive, so `literal in text` can skip a "
        "match with different casing"
    )


def test_masked_output_is_byte_identical_with_the_prefilter_disabled(
    corpus: list[str],
) -> None:
    """End-to-end: the optimisation must not change one byte of output."""
    with_prefilter = PIIMasker()
    without = PIIMasker()
    # Force every pattern to run.
    without._REQUIRED_LITERALS = {}  # type: ignore[misc]

    for text in corpus:
        a = with_prefilter.mask(text)
        b = without.mask(text)
        assert a == b, (
            f"prefilter changed the output for {text!r}:\n"
            f"  with:    {a!r}\n  without: {b!r}"
        )


def test_dict_payloads_are_also_identical(corpus: list[str]) -> None:
    with_prefilter = PIIMasker()
    without = PIIMasker()
    without._REQUIRED_LITERALS = {}  # type: ignore[misc]

    for text in corpus[:2000]:
        body = {"messages": [{"role": "user", "content": text}], "nested": {"v": text}}
        assert with_prefilter.mask(body) == without.mask(body)


def test_fail_closed_still_raises_on_a_credential(monkeypatch: pytest.MonkeyPatch) -> None:
    """The prefilter must not turn a fail-closed policy into a pass.

    It short-circuits the credential scan too, so the risk is a credential that
    slips through because its literal was not checked.
    """
    from eden.data_platform.pii import PIIPolicy

    policy = PIIPolicy(fail_closed_on_credentials=True)
    masker = PIIMasker(policy=policy)
    creds = list(policy.credential_categories)
    assert creds, "policy has no credential categories; test proves nothing"

    samples = {
        "jwt": "token eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxIn0.abcdef",
        "api_key": "key sk_live_abcdefghijklmnopqrstuvwx",
        "url_with_creds": "see https://user:pass@example.com/x",
    }
    raised_for = []
    for cat, text in samples.items():
        if cat not in creds:
            continue
        from eden.data_platform.pii import PIIMaskingError

        with pytest.raises(PIIMaskingError):
            masker.mask(text)
        raised_for.append(cat)
    assert raised_for, (
        "none of the sampled categories are credential categories, so the "
        "fail-closed path was never exercised"
    )


class TestAmaskRunsOffTheEventLoop:
    """``amask`` exists solely to move CPU work off the loop.

    Measured on a 512 KiB body: wall time is unchanged (96.5ms inline vs
    96.8ms threaded, because ``re`` holds the GIL) but the worst event-loop
    stall drops from 96.2ms to 30.7ms — 3.1x. If ``amask`` quietly stops
    dispatching to a thread it still returns the right answer, so only a test
    on the *mechanism* catches it.
    """

    @pytest.mark.asyncio
    async def test_it_dispatches_through_to_thread(
        self, monkeypatch: pytest.MonkeyPatch
    ) -> None:
        import asyncio as _asyncio

        calls: list[object] = []
        real = _asyncio.to_thread

        async def spy(fn, /, *a, **kw):  # type: ignore[no-untyped-def]
            calls.append(fn)
            return await real(fn, *a, **kw)

        monkeypatch.setattr(_asyncio, "to_thread", spy)

        masker = PIIMasker()
        out = await masker.amask({"messages": [{"content": "hello"}]})

        assert calls, (
            "amask did not go through asyncio.to_thread, so the masking regexes "
            "are running on the event loop again"
        )
        assert out == {"messages": [{"content": "hello"}]}

    @pytest.mark.asyncio
    async def test_it_returns_the_same_result_as_mask(self) -> None:
        masker = PIIMasker()
        for payload in (
            "contact alex@example.com",
            {"messages": [{"role": "user", "content": "token eyJa.b.c"}]},
            "nothing sensitive here",
        ):
            assert await masker.amask(payload) == masker.mask(payload)

    @pytest.mark.asyncio
    @pytest.mark.perf
    async def test_the_loop_keeps_ticking_during_a_large_mask(self) -> None:
        """Behavioural counterpart to the mechanism test above."""
        import asyncio as _asyncio
        import time

        prose = (
            "Please summarise the attached support thread and identify the "
            "root cause of the customer issue. The token expired. "
        )
        text = (prose * 3000)[: 256 * 1024]
        body = {"messages": [{"role": "user", "content": text}]}

        ticks = 0
        stop = _asyncio.Event()

        async def beat() -> None:
            nonlocal ticks
            while not stop.is_set():
                await _asyncio.sleep(0.001)
                ticks += 1

        hb = _asyncio.create_task(beat())
        await _asyncio.sleep(0.01)
        ticks = 0
        t0 = time.perf_counter()
        await PIIMasker().amask(body)
        elapsed = time.perf_counter() - t0
        stop.set()
        await hb

        # Inline, the loop gets ~0 ticks for the whole duration. Threaded it
        # gets many. Assert a low bar so this is not flaky on a loaded box.
        assert ticks >= 3, (
            f"the event loop ticked only {ticks} time(s) during a "
            f"{elapsed * 1000:.0f}ms mask — the work is not being offloaded"
        )


def test_clean_text_skips_the_listed_patterns(masker: PIIMasker) -> None:
    """Confirms the optimisation actually engages — otherwise it is dead code."""
    clean = "ordinary prose about resetting a password after token expiry"
    skipped = [
        p for p in PIIMasker._REQUIRED_LITERALS if masker._can_skip(p, clean)
    ]
    assert set(skipped) == set(PIIMasker._REQUIRED_LITERALS), (
        f"only {skipped} were skipped on clean prose; the prefilter is not "
        "engaging and buys nothing"
    )
