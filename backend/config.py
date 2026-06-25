import os
from functools import lru_cache


class Settings:
    """Application settings loaded from environment variables only."""

    def __init__(self):
        self.DATABASE_URL = os.environ.get("DATABASE_URL", "")
        self.REDIS_URL = os.environ.get("REDIS_URL", "")

        self.ADMIN_TELEGRAM_ID = os.environ.get("ADMIN_TELEGRAM_ID", "831704732")
        self.TELEGRAM_BOT_TOKEN = os.environ.get("TELEGRAM_BOT_TOKEN", "REPLACE_WITH_TOKEN")
        self.WEBAPP_URL = os.environ.get("WEBAPP_URL", "https://amir-btc-assistant.vercel.app")
        self.REQUIRED_CHANNEL = os.environ.get("REQUIRED_CHANNEL", "amir_btc_2024")

        self.JOIN_CACHE_TTL = int(os.environ.get("JOIN_CACHE_TTL", "1800"))
        self.MAX_WATCHLIST = int(os.environ.get("MAX_WATCHLIST", "7"))

    @property
    def database_enabled(self) -> bool:
        return bool(self.DATABASE_URL)

    @property
    def redis_enabled(self) -> bool:
        return bool(self.REDIS_URL)

    @property
    def bot_configured(self) -> bool:
        return bool(self.TELEGRAM_BOT_TOKEN and self.TELEGRAM_BOT_TOKEN != "REPLACE_WITH_TOKEN")


@lru_cache
def get_settings() -> Settings:
    return Settings()
