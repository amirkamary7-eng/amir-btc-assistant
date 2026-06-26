"""Database-backed ticket conversation service."""

from __future__ import annotations

import uuid
from typing import Any, Optional

from sqlalchemy.orm import Session, selectinload

from backend.models import Ticket, TicketReply, User, utcnow

USER_SENDER = "user"
ADMIN_SENDER = "admin"
VALID_SENDERS = {USER_SENDER, ADMIN_SENDER}

TICKET_STATUS_OPEN = "open"
TICKET_STATUS_ANSWERED = "answered"
TICKET_STATUS_USER_REPLIED = "user_replied"


def _ensure_user(db: Session, *, user_id: str, user_name: Optional[str] = None) -> User:
    user = db.get(User, str(user_id))
    now = utcnow()
    if user is None:
        user = User(
            telegram_id=str(user_id),
            username=user_name or None,
            lang="fa",
            created_at=now,
            updated_at=now,
        )
        db.add(user)
        db.flush()
        return user

    if user_name and not user.username:
        user.username = user_name
    user.updated_at = now
    db.flush()
    return user


def _reply_to_dict(reply: TicketReply) -> dict[str, Any]:
    return {
        "id": reply.id,
        "ticket_id": reply.ticket_id,
        "sender_type": reply.sender_type,
        "sender_id": reply.sender_id,
        "message": reply.message,
        "at": reply.created_at.isoformat() if reply.created_at else None,
        "created_at": reply.created_at.isoformat() if reply.created_at else None,
    }


def _ticket_to_dict(ticket: Ticket) -> dict[str, Any]:
    replies = sorted(ticket.replies, key=lambda item: item.created_at or utcnow())
    return {
        "id": ticket.id,
        "user_id": ticket.user_id,
        "user_name": ticket.user_name,
        "title": ticket.title,
        "body": ticket.body,
        "status": ticket.status,
        "replies": [_reply_to_dict(reply) for reply in replies],
        "created_at": ticket.created_at.isoformat() if ticket.created_at else None,
        "updated_at": ticket.updated_at.isoformat() if ticket.updated_at else None,
    }


def _next_status_for_reply(sender_type: str) -> str:
    return TICKET_STATUS_ANSWERED if sender_type == ADMIN_SENDER else TICKET_STATUS_USER_REPLIED


def create_ticket(
    db: Session,
    *,
    user_id: str,
    user_name: str,
    title: str,
    body: str,
) -> dict[str, Any]:
    user_id = str(user_id)
    display_name = (user_name or user_id).strip()
    now = utcnow()

    _ensure_user(db, user_id=user_id, user_name=display_name)

    ticket = Ticket(
        id=str(uuid.uuid4())[:12],
        user_id=user_id,
        user_name=display_name,
        title=title.strip(),
        body=body.strip(),
        status=TICKET_STATUS_OPEN,
        created_at=now,
        updated_at=now,
    )
    db.add(ticket)
    db.flush()
    db.refresh(ticket)
    return _ticket_to_dict(ticket)


def add_reply(
    db: Session,
    *,
    ticket_id: str,
    sender_type: str,
    sender_id: Optional[str],
    message: str,
) -> Optional[dict[str, Any]]:
    normalized_sender = str(sender_type or "").strip().lower()
    if normalized_sender not in VALID_SENDERS:
        raise ValueError(f"Unsupported sender_type: {sender_type}")

    ticket = (
        db.query(Ticket)
        .options(selectinload(Ticket.replies))
        .filter(Ticket.id == str(ticket_id))
        .first()
    )
    if not ticket:
        return None

    now = utcnow()
    reply = TicketReply(
        ticket_id=ticket.id,
        sender_type=normalized_sender,
        sender_id=str(sender_id) if sender_id else None,
        message=message.strip(),
        created_at=now,
    )
    db.add(reply)
    ticket.status = _next_status_for_reply(normalized_sender)
    ticket.updated_at = now
    db.flush()
    db.refresh(ticket)
    return _ticket_to_dict(ticket)


def get_user_tickets(db: Session, user_id: str) -> list[dict[str, Any]]:
    rows = (
        db.query(Ticket)
        .options(selectinload(Ticket.replies))
        .filter(Ticket.user_id == str(user_id))
        .order_by(Ticket.created_at.desc())
        .all()
    )
    return [_ticket_to_dict(ticket) for ticket in rows]
