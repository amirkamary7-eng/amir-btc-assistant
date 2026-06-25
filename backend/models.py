from datetime import datetime, timezone

from sqlalchemy import Boolean, Column, DateTime, ForeignKey, Integer, String, Text, UniqueConstraint
from sqlalchemy.orm import declarative_base, relationship

Base = declarative_base()


def utcnow():
    return datetime.now(timezone.utc)


class User(Base):
    __tablename__ = "users"

    telegram_id = Column(String(64), primary_key=True)
    username = Column(String(128), nullable=True)
    first_name = Column(String(128), nullable=True)
    last_name = Column(String(128), nullable=True)
    lang = Column(String(8), nullable=False, default="fa")
    channel_joined = Column(Boolean, nullable=False, default=False)
    channel_verified_at = Column(DateTime(timezone=True), nullable=True)
    created_at = Column(DateTime(timezone=True), nullable=False, default=utcnow)
    updated_at = Column(DateTime(timezone=True), nullable=False, default=utcnow, onupdate=utcnow)

    watchlist_items = relationship(
        "WatchlistItem",
        back_populates="user",
        cascade="all, delete-orphan",
        order_by="WatchlistItem.position",
    )


class WatchlistItem(Base):
    __tablename__ = "watchlist_items"
    __table_args__ = (UniqueConstraint("user_id", "symbol", name="uq_watchlist_user_symbol"),)

    id = Column(Integer, primary_key=True, autoincrement=True)
    user_id = Column(String(64), ForeignKey("users.telegram_id", ondelete="CASCADE"), nullable=False, index=True)
    symbol = Column(String(32), nullable=False)
    position = Column(Integer, nullable=False, default=0)
    created_at = Column(DateTime(timezone=True), nullable=False, default=utcnow)

    user = relationship("User", back_populates="watchlist_items")


class Analysis(Base):
    __tablename__ = "analyses"

    id = Column(String(64), primary_key=True)
    coin = Column(String(32), nullable=False, index=True)
    timeframe = Column(String(16), nullable=False, default="1d")
    image = Column(String(512), nullable=True)
    text = Column(Text, nullable=False)
    author = Column(String(128), nullable=False)
    author_id = Column(String(64), nullable=True)
    created_at = Column(DateTime(timezone=True), nullable=False, default=utcnow)
    updated_at = Column(DateTime(timezone=True), nullable=False, default=utcnow, onupdate=utcnow)


class Referral(Base):
    __tablename__ = "referrals"
    __table_args__ = (UniqueConstraint("invitee_id", name="uq_referral_invitee"),)

    id = Column(Integer, primary_key=True, autoincrement=True)
    inviter_id = Column(String(64), ForeignKey("users.telegram_id", ondelete="CASCADE"), nullable=False, index=True)
    invitee_id = Column(String(64), ForeignKey("users.telegram_id", ondelete="CASCADE"), nullable=False)
    channel_verified = Column(Boolean, nullable=False, default=False)
    rewarded = Column(Boolean, nullable=False, default=False)
    created_at = Column(DateTime(timezone=True), nullable=False, default=utcnow)


class TokenBalance(Base):
    __tablename__ = "token_balances"

    user_id = Column(String(64), ForeignKey("users.telegram_id", ondelete="CASCADE"), primary_key=True)
    balance = Column(Integer, nullable=False, default=0)
    updated_at = Column(DateTime(timezone=True), nullable=False, default=utcnow, onupdate=utcnow)


class TokenTransaction(Base):
    __tablename__ = "token_transactions"

    id = Column(Integer, primary_key=True, autoincrement=True)
    user_id = Column(String(64), ForeignKey("users.telegram_id", ondelete="CASCADE"), nullable=False, index=True)
    amount = Column(Integer, nullable=False)
    tx_type = Column(String(32), nullable=False)
    description = Column(String(256), nullable=True)
    ref_id = Column(String(64), nullable=True)
    created_at = Column(DateTime(timezone=True), nullable=False, default=utcnow)
