from contextlib import contextmanager

from sqlalchemy import create_engine, text
from sqlalchemy.orm import Session, sessionmaker

from backend.config import get_settings
from backend.models import Base

_engine = None
SessionLocal = None
_db_ready = False


def init_database() -> bool:
    global _engine, SessionLocal, _db_ready

    settings = get_settings()
    if not settings.database_enabled:
        print("ℹ️ DATABASE_URL not set; PostgreSQL features disabled.")
        _db_ready = False
        return False

    try:
        _engine = create_engine(
            settings.DATABASE_URL,
            pool_pre_ping=True,
            pool_size=5,
            max_overflow=10,
        )
        SessionLocal = sessionmaker(bind=_engine, autocommit=False, autoflush=False)
        Base.metadata.create_all(bind=_engine)
        with _engine.connect() as conn:
            conn.execute(text("SELECT 1"))
        _db_ready = True
        print("✅ PostgreSQL connected and schema ready.")
        return True
    except Exception as exc:
        print(f"⚠️ PostgreSQL init failed: {exc}")
        _engine = None
        SessionLocal = None
        _db_ready = False
        return False


def database_ready() -> bool:
    return _db_ready


@contextmanager
def get_db_session():
    if not SessionLocal:
        raise RuntimeError("Database is not configured")
    session: Session = SessionLocal()
    try:
        yield session
        session.commit()
    except Exception:
        session.rollback()
        raise
    finally:
        session.close()
