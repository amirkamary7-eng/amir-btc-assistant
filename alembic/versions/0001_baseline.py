"""baseline — initial schema from backend/models.py

This is the first migration and represents the full database schema
as defined in backend/models.py at the time of Alembic introduction.
All 9 tables are created in dependency order (users first, then
tables with foreign keys referencing users).

Revision ID: 0001_baseline
Revises: None
Create Date: 2026-07-03 12:00:00.000000
"""
from typing import Sequence, Union

from alembic import op
import sqlalchemy as sa

# revision identifiers, used by Alembic.
revision: str = "0001_baseline"
down_revision: Union[str, None] = None
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    # --- users ---
    op.create_table(
        "users",
        sa.Column("telegram_id", sa.String(64), primary_key=True),
        sa.Column("username", sa.String(128), nullable=True),
        sa.Column("first_name", sa.String(128), nullable=True),
        sa.Column("last_name", sa.String(128), nullable=True),
        sa.Column("lang", sa.String(8), nullable=False, server_default="fa"),
        sa.Column("channel_joined", sa.Boolean(), nullable=False, server_default=sa.text("false")),
        sa.Column("channel_verified_at", sa.DateTime(timezone=True), nullable=True),
        sa.Column("created_at", sa.DateTime(timezone=True), nullable=False),
        sa.Column("updated_at", sa.DateTime(timezone=True), nullable=False),
    )

    # --- token_balances (1:1 with users) ---
    op.create_table(
        "token_balances",
        sa.Column("user_id", sa.String(64), sa.ForeignKey("users.telegram_id", ondelete="CASCADE"), primary_key=True),
        sa.Column("balance", sa.Integer(), nullable=False, server_default=sa.text("0")),
        sa.Column("updated_at", sa.DateTime(timezone=True), nullable=False),
    )

    # --- watchlist_items ---
    op.create_table(
        "watchlist_items",
        sa.Column("id", sa.Integer(), autoincrement=True, primary_key=True),
        sa.Column("user_id", sa.String(64), sa.ForeignKey("users.telegram_id", ondelete="CASCADE"), nullable=False, index=True),
        sa.Column("symbol", sa.String(32), nullable=False),
        sa.Column("position", sa.Integer(), nullable=False, server_default=sa.text("0")),
        sa.Column("created_at", sa.DateTime(timezone=True), nullable=False),
        sa.UniqueConstraint("user_id", "symbol", name="uq_watchlist_user_symbol"),
    )

    # --- analyses (no FK to users) ---
    op.create_table(
        "analyses",
        sa.Column("id", sa.String(64), primary_key=True),
        sa.Column("coin", sa.String(32), nullable=False, index=True),
        sa.Column("timeframe", sa.String(16), nullable=False, server_default="1d"),
        sa.Column("image", sa.String(512), nullable=True),
        sa.Column("text", sa.Text(), nullable=False),
        sa.Column("author", sa.String(128), nullable=False),
        sa.Column("author_id", sa.String(64), nullable=True),
        sa.Column("created_at", sa.DateTime(timezone=True), nullable=False),
        sa.Column("updated_at", sa.DateTime(timezone=True), nullable=False),
    )

    # --- tickets ---
    op.create_table(
        "tickets",
        sa.Column("id", sa.String(64), primary_key=True),
        sa.Column("user_id", sa.String(64), sa.ForeignKey("users.telegram_id", ondelete="CASCADE"), nullable=False, index=True),
        sa.Column("user_name", sa.String(128), nullable=False),
        sa.Column("title", sa.String(256), nullable=False),
        sa.Column("body", sa.Text(), nullable=False),
        sa.Column("status", sa.String(32), nullable=False, server_default="open", index=True),
        sa.Column("created_at", sa.DateTime(timezone=True), nullable=False, index=True),
        sa.Column("updated_at", sa.DateTime(timezone=True), nullable=False),
    )

    # --- ticket_replies ---
    op.create_table(
        "ticket_replies",
        sa.Column("id", sa.Integer(), autoincrement=True, primary_key=True),
        sa.Column("ticket_id", sa.String(64), sa.ForeignKey("tickets.id", ondelete="CASCADE"), nullable=False, index=True),
        sa.Column("sender_type", sa.String(16), nullable=False, server_default="user"),
        sa.Column("sender_id", sa.String(64), nullable=True, index=True),
        sa.Column("message", sa.Text(), nullable=False),
        sa.Column("created_at", sa.DateTime(timezone=True), nullable=False, index=True),
    )

    # --- price_alerts ---
    op.create_table(
        "price_alerts",
        sa.Column("id", sa.String(64), primary_key=True),
        sa.Column("user_id", sa.String(64), sa.ForeignKey("users.telegram_id", ondelete="CASCADE"), nullable=False, index=True),
        sa.Column("symbol", sa.String(32), nullable=False, index=True),
        sa.Column("price", sa.Float(), nullable=False),
        sa.Column("direction", sa.String(16), nullable=False, server_default="above"),
        sa.Column("status", sa.String(16), nullable=False, server_default="active", index=True),
        sa.Column("created_at", sa.DateTime(timezone=True), nullable=False, index=True),
        sa.Column("triggered_at", sa.DateTime(timezone=True), nullable=True),
        sa.UniqueConstraint("user_id", "symbol", "price", "direction", name="uq_price_alert_user_symbol_price_direction"),
    )

    # --- referrals ---
    op.create_table(
        "referrals",
        sa.Column("id", sa.Integer(), autoincrement=True, primary_key=True),
        sa.Column("inviter_id", sa.String(64), sa.ForeignKey("users.telegram_id", ondelete="CASCADE"), nullable=False, index=True),
        sa.Column("invitee_id", sa.String(64), sa.ForeignKey("users.telegram_id", ondelete="CASCADE"), nullable=False),
        sa.Column("channel_verified", sa.Boolean(), nullable=False, server_default=sa.text("false")),
        sa.Column("rewarded", sa.Boolean(), nullable=False, server_default=sa.text("false")),
        sa.Column("created_at", sa.DateTime(timezone=True), nullable=False),
        sa.UniqueConstraint("invitee_id", name="uq_referral_invitee"),
    )

    # --- token_transactions ---
    op.create_table(
        "token_transactions",
        sa.Column("id", sa.Integer(), autoincrement=True, primary_key=True),
        sa.Column("user_id", sa.String(64), sa.ForeignKey("users.telegram_id", ondelete="CASCADE"), nullable=False, index=True),
        sa.Column("amount", sa.Integer(), nullable=False),
        sa.Column("tx_type", sa.String(32), nullable=False),
        sa.Column("description", sa.String(256), nullable=True),
        sa.Column("ref_id", sa.String(64), nullable=True),
        sa.Column("created_at", sa.DateTime(timezone=True), nullable=False),
    )


def downgrade() -> None:
    op.drop_table("token_transactions")
    op.drop_table("referrals")
    op.drop_table("price_alerts")
    op.drop_table("ticket_replies")
    op.drop_table("tickets")
    op.drop_table("analyses")
    op.drop_table("watchlist_items")
    op.drop_table("token_balances")
    op.drop_table("users")