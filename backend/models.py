# ============================================================================
# region Imports
# این بخش وابستگی‌ها و importهای فایل `models.py` را نگه می‌دارد.
# ============================================================================
from datetime import datetime, timezone

from sqlalchemy import Boolean, Column, DateTime, Float, ForeignKey, Integer, String, Text, UniqueConstraint
from sqlalchemy.orm import declarative_base, relationship

# endregion

# ============================================================================
# region تعاریف و منطق ماژول
# این بخش ثابت‌ها، مدل‌ها و منطق اصلی فایل را در خود نگه می‌دارد.
# ============================================================================
Base = declarative_base()



# عملیات مربوط به utcnow را انجام می‌دهد.
# ورودی: بدون ورودی.
# خروجی: نتیجه مستقیم این عملیات را برمی‌گرداند یا روی وضعیت ماژول اثر می‌گذارد.
def utcnow():
    return datetime.now(timezone.utc)



# User ساختار داده یا کلاس اصلی این فایل را تعریف می‌کند.
# ورودی: در زمان نمونه‌سازی یا ارث‌بری، پارامترها و فیلدهای موردنیاز را دریافت می‌کند.
# خروجی: یک ساختار داده، مدل یا رفتار شی‌گرا برای استفاده در سایر بخش‌ها فراهم می‌کند.
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
    tickets = relationship(
        "Ticket",
        back_populates="user",
        cascade="all, delete-orphan",
        order_by="desc(Ticket.created_at)",
    )
    alerts = relationship(
        "PriceAlert",
        back_populates="user",
        cascade="all, delete-orphan",
        order_by="desc(PriceAlert.created_at)",
    )


# WatchlistItem ساختار داده یا کلاس اصلی این فایل را تعریف می‌کند.
# ورودی: در زمان نمونه‌سازی یا ارث‌بری، پارامترها و فیلدهای موردنیاز را دریافت می‌کند.
# خروجی: یک ساختار داده، مدل یا رفتار شی‌گرا برای استفاده در سایر بخش‌ها فراهم می‌کند.
class WatchlistItem(Base):
    __tablename__ = "watchlist_items"
    __table_args__ = (UniqueConstraint("user_id", "symbol", name="uq_watchlist_user_symbol"),)

    id = Column(Integer, primary_key=True, autoincrement=True)
    user_id = Column(String(64), ForeignKey("users.telegram_id", ondelete="CASCADE"), nullable=False, index=True)
    symbol = Column(String(32), nullable=False)
    position = Column(Integer, nullable=False, default=0)
    created_at = Column(DateTime(timezone=True), nullable=False, default=utcnow)

    user = relationship("User", back_populates="watchlist_items")


# Analysis ساختار داده یا کلاس اصلی این فایل را تعریف می‌کند.
# ورودی: در زمان نمونه‌سازی یا ارث‌بری، پارامترها و فیلدهای موردنیاز را دریافت می‌کند.
# خروجی: یک ساختار داده، مدل یا رفتار شی‌گرا برای استفاده در سایر بخش‌ها فراهم می‌کند.
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

# Ticket ساختار داده یا کلاس اصلی این فایل را تعریف می‌کند.
# ورودی: در زمان نمونه‌سازی یا ارث‌بری، پارامترها و فیلدهای موردنیاز را دریافت می‌کند.
# خروجی: یک ساختار داده، مدل یا رفتار شی‌گرا برای استفاده در سایر بخش‌ها فراهم می‌کند.
class Ticket(Base):
    __tablename__ = "tickets"

    id = Column(String(64), primary_key=True)
    user_id = Column(String(64), ForeignKey("users.telegram_id", ondelete="CASCADE"), nullable=False, index=True)
    user_name = Column(String(128), nullable=False)
    title = Column(String(256), nullable=False)
    body = Column(Text, nullable=False)
    status = Column(String(32), nullable=False, default="open", index=True)
    created_at = Column(DateTime(timezone=True), nullable=False, default=utcnow, index=True)
    updated_at = Column(DateTime(timezone=True), nullable=False, default=utcnow, onupdate=utcnow)

    user = relationship("User", back_populates="tickets")
    replies = relationship(
        "TicketReply",
        back_populates="ticket",
        cascade="all, delete-orphan",
        order_by="TicketReply.created_at",
    )

# TicketReply ساختار داده یا کلاس اصلی این فایل را تعریف می‌کند.
# ورودی: در زمان نمونه‌سازی یا ارث‌بری، پارامترها و فیلدهای موردنیاز را دریافت می‌کند.
# خروجی: یک ساختار داده، مدل یا رفتار شی‌گرا برای استفاده در سایر بخش‌ها فراهم می‌کند.
class TicketReply(Base):
    __tablename__ = "ticket_replies"

    id = Column(Integer, primary_key=True, autoincrement=True)
    ticket_id = Column(String(64), ForeignKey("tickets.id", ondelete="CASCADE"), nullable=False, index=True)
    sender_type = Column(String(16), nullable=False, default="user")
    sender_id = Column(String(64), nullable=True, index=True)
    message = Column(Text, nullable=False)
    created_at = Column(DateTime(timezone=True), nullable=False, default=utcnow, index=True)

    ticket = relationship("Ticket", back_populates="replies")

# PriceAlert ساختار داده یا کلاس اصلی این فایل را تعریف می‌کند.
# ورودی: در زمان نمونه‌سازی یا ارث‌بری، پارامترها و فیلدهای موردنیاز را دریافت می‌کند.
# خروجی: یک ساختار داده، مدل یا رفتار شی‌گرا برای استفاده در سایر بخش‌ها فراهم می‌کند.
class PriceAlert(Base):
    __tablename__ = "price_alerts"
    __table_args__ = (
        UniqueConstraint("user_id", "symbol", "price", "direction", name="uq_price_alert_user_symbol_price_direction"),
    )

    id = Column(String(64), primary_key=True)
    user_id = Column(String(64), ForeignKey("users.telegram_id", ondelete="CASCADE"), nullable=False, index=True)
    symbol = Column(String(32), nullable=False, index=True)
    price = Column(Float, nullable=False)
    direction = Column(String(16), nullable=False, default="above")
    status = Column(String(16), nullable=False, default="active", index=True)
    created_at = Column(DateTime(timezone=True), nullable=False, default=utcnow, index=True)
    triggered_at = Column(DateTime(timezone=True), nullable=True)

    user = relationship("User", back_populates="alerts")


# Referral ساختار داده یا کلاس اصلی این فایل را تعریف می‌کند.
# ورودی: در زمان نمونه‌سازی یا ارث‌بری، پارامترها و فیلدهای موردنیاز را دریافت می‌کند.
# خروجی: یک ساختار داده، مدل یا رفتار شی‌گرا برای استفاده در سایر بخش‌ها فراهم می‌کند.
class Referral(Base):
    __tablename__ = "referrals"
    __table_args__ = (UniqueConstraint("invitee_id", name="uq_referral_invitee"),)

    id = Column(Integer, primary_key=True, autoincrement=True)
    inviter_id = Column(String(64), ForeignKey("users.telegram_id", ondelete="CASCADE"), nullable=False, index=True)
    invitee_id = Column(String(64), ForeignKey("users.telegram_id", ondelete="CASCADE"), nullable=False)
    channel_verified = Column(Boolean, nullable=False, default=False)
    rewarded = Column(Boolean, nullable=False, default=False)
    created_at = Column(DateTime(timezone=True), nullable=False, default=utcnow)


# TokenBalance ساختار داده یا کلاس اصلی این فایل را تعریف می‌کند.
# ورودی: در زمان نمونه‌سازی یا ارث‌بری، پارامترها و فیلدهای موردنیاز را دریافت می‌کند.
# خروجی: یک ساختار داده، مدل یا رفتار شی‌گرا برای استفاده در سایر بخش‌ها فراهم می‌کند.
class TokenBalance(Base):
    __tablename__ = "token_balances"

    user_id = Column(String(64), ForeignKey("users.telegram_id", ondelete="CASCADE"), primary_key=True)
    balance = Column(Integer, nullable=False, default=0)
    updated_at = Column(DateTime(timezone=True), nullable=False, default=utcnow, onupdate=utcnow)


# TokenTransaction ساختار داده یا کلاس اصلی این فایل را تعریف می‌کند.
# ورودی: در زمان نمونه‌سازی یا ارث‌بری، پارامترها و فیلدهای موردنیاز را دریافت می‌کند.
# خروجی: یک ساختار داده، مدل یا رفتار شی‌گرا برای استفاده در سایر بخش‌ها فراهم می‌کند.
class TokenTransaction(Base):
    __tablename__ = "token_transactions"

    id = Column(Integer, primary_key=True, autoincrement=True)
    user_id = Column(String(64), ForeignKey("users.telegram_id", ondelete="CASCADE"), nullable=False, index=True)
    amount = Column(Integer, nullable=False)
    tx_type = Column(String(32), nullable=False)
    description = Column(String(256), nullable=True)
    ref_id = Column(String(64), nullable=True)
    created_at = Column(DateTime(timezone=True), nullable=False, default=utcnow)

# endregion