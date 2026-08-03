"""Golden-path harness (AUTONOMY-OVERHAUL-PLAN §2.2, plan M1).

Three deterministic offline scenarios exercise the full autonomy loop.
Every assertion that fails on today's code carries
``@pytest.mark.xfail(strict=True, reason="D<n>: ...")`` — the executable
defect list. ``grep -rn xfail tests/integration/golden_path`` is the live
open-defect report; later milestones flip markers off as they fix defects.
"""
