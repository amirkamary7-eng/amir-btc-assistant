"""Referral tracking and AB token rewards."""

from typing import Any, Optional

from sqlalchemy.orm import Session

from backend.config import get_settings
from backend.models import Referral, TokenBalance, TokenTransaction, User, utcnow


def get_or_create_balance(db: Session, user_id: str) -> TokenBalance:
    balance = db.get(TokenBalance, user_id)
    if balance is None:
        balance = TokenBalance(user_id=user_id, balance=0)
        db.add(balance)
        db.flush()
    return balance


def get_token_balance(db: Session, user_id: str) -> int:
    balance = db.get(TokenBalance, user_id)
    return balance.balance if balance else 0


def get_token_history(db: Session, user_id: str, limit: int = 50) -> list[dict[str, Any]]:
    rows = (
        db.query(TokenTransaction)
        .filter(TokenTransaction.user_id == user_id)
        .order_by(TokenTransaction.created_at.desc())
        .limit(limit)
        .all()
    )
    return [
        {
            "id": r.id,
            "amount": r.amount,
            "type": r.tx_type,
            "description": r.description,
            "ref_id": r.ref_id,
            "created_at": r.created_at.isoformat() if r.created_at else None,
        }
        for r in rows
    ]


def get_referral_stats(db: Session, user_id: str) -> dict[str, Any]:
    referrals = db.query(Referral).filter(Referral.inviter_id == user_id).all()
    total = len(referrals)
    active = sum(1 for r in referrals if r.channel_verified)
    rewarded = sum(1 for r in referrals if r.rewarded)
    balance = get_token_balance(db, user_id)
    return {
        "total": total,
        "active": active,
        "rewarded": rewarded,
        "tokens": balance,
        "reward_per_invite": get_settings().REFERRAL_TOKENS_PER_INVITE,
    }


def _credit_tokens(
    db: Session,
    user_id: str,
    amount: int,
    tx_type: str,
    description: str,
    ref_id: Optional[str] = None,
) -> None:
    bal = get_or_create_balance(db, user_id)
    bal.balance += amount
    bal.updated_at = utcnow()
    db.add(
        TokenTransaction(
            user_id=user_id,
            amount=amount,
            tx_type=tx_type,
            description=description,
            ref_id=ref_id,
        )
    )
    db.flush()


def process_referral_on_bootstrap(
    db: Session,
    invitee_id: str,
    referrer_id: Optional[str],
    channel_joined: bool,
) -> Optional[dict[str, Any]]:
    """Record referral if valid; reward inviter when invitee joins channel."""
    if not referrer_id or referrer_id == invitee_id:
        return None

    settings = get_settings()
    inviter = db.get(User, referrer_id)
    if not inviter:
        return None

    existing = db.query(Referral).filter(Referral.invitee_id == invitee_id).first()
    if existing:
        if channel_joined and not existing.channel_verified:
            existing.channel_verified = True
            db.flush()
            if not existing.rewarded:
                _credit_tokens(
                    db,
                    existing.inviter_id,
                    settings.REFERRAL_TOKENS_PER_INVITE,
                    "referral_reward",
                    f"Invite reward for user {invitee_id}",
                    ref_id=str(existing.id),
                )
                existing.rewarded = True
                db.flush()
        return {"referral_id": existing.id, "already_exists": True}

    referral = Referral(
        inviter_id=referrer_id,
        invitee_id=invitee_id,
        channel_verified=channel_joined,
        rewarded=False,
    )
    db.add(referral)
    db.flush()

    if channel_joined:
        _credit_tokens(
            db,
            referrer_id,
            settings.REFERRAL_TOKENS_PER_INVITE,
            "referral_reward",
            f"Invite reward for user {invitee_id}",
            ref_id=str(referral.id),
        )
        referral.rewarded = True
        db.flush()

    return {"referral_id": referral.id, "rewarded": referral.rewarded}
