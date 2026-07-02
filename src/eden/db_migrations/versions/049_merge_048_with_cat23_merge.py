"""049 — merge the 047/048 main chain with the stale Cat 23 merge.

Revision ID: 049
Revises: 048, 5c782c65faa3
Create Date: 2026-06-23

Background
----------
The migration chain currently has TWO heads:

  head 1 (main):    ... 044 → 045 → 046 → 047 → 048
  head 2 (stale):   ... 044 → 045 + 0f45068e1e8e → 5c782c65faa3

The Cat 23 merge revision ``5c782c65faa3`` was created on
2026-06-20 when 045 was the head and a parallel branch
``0f45068e1e8e`` (a no-op merge of ``018`` and ``035``) needed
to be folded in. After that merge, ``046`` / ``047`` / ``048``
were added on the main chain — but the merge was never updated
to point at the new head. Result: ``alembic upgrade head``
errors with ``Multiple head revisions are present``.

This is a no-op merge revision (``upgrade`` / ``downgrade``
both ``pass``) that just stitches the two heads together so
``alembic upgrade head`` runs cleanly and the chain collapses
to a single head again.

Phase 3a (2026-06-23) created this revision alongside the
real Phase 3a changes; it's purely a chain repair, not a
schema change.
"""

from __future__ import annotations

from typing import Sequence, Union


revision: str = "049"
down_revision: Union[str, Sequence[str], None] = ("048", "5c782c65faa3")
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    """No-op merge revision — chain repair only."""
    pass


def downgrade() -> None:
    """No-op — undoing a merge is undefined; ``alembic`` will
    refuse unless one of the branches is independently
    downgraded."""
    pass