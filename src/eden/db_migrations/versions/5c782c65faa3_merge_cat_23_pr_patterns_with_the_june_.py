"""merge Cat 23 pr_patterns with the June 2026 merge chain

Revision ID: 5c782c65faa3
Revises: 045, 0f45068e1e8e
Create Date: 2026-06-20 17:04:37.879242

"""
from typing import Sequence, Union

from alembic import op
import sqlalchemy as sa

# revision identifiers, used by Alembic.
revision: str = '5c782c65faa3'
down_revision: Union[str, None] = ('045', '0f45068e1e8e')
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    pass


def downgrade() -> None:
    pass
