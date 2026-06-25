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

        self.MARKET_CACHE_TTL = int(os.environ.get("MARKET_CACHE_TTL", "60"))
        self.NEWS_CACHE_TTL = int(os.environ.get("NEWS_CACHE_TTL", "300"))
        self.CALENDAR_CACHE_TTL = int(os.environ.get("CALENDAR_CACHE_TTL", "600"))
        self.CHART_EXCHANGE_CACHE_TTL = int(os.environ.get("CHART_EXCHANGE_CACHE_TTL", "86400"))
        self.ANALYSIS_CACHE_TTL = int(os.environ.get("ANALYSIS_CACHE_TTL", "30"))
        self.SESSION_TTL = int(os.environ.get("SESSION_TTL", "120"))

        self.GEMINI_API_KEY = os.environ.get("GEMINI_API_KEY", "")
        self.OPENROUTER_API_KEY = os.environ.get("OPENROUTER_API_KEY", "")
        self.DEEPSEEK_API_KEY = os.environ.get("DEEPSEEK_API_KEY", "")
        self.AI_DAILY_MESSAGE_LIMIT = int(os.environ.get("AI_DAILY_MESSAGE_LIMIT", "50"))
        self.AI_DAILY_IMAGE_LIMIT = int(os.environ.get("AI_DAILY_IMAGE_LIMIT", "3"))
        self.AI_COOLDOWN_SECONDS = int(os.environ.get("AI_COOLDOWN_SECONDS", "4"))
        self.REFERRAL_TOKENS_PER_INVITE = int(os.environ.get("REFERRAL_TOKENS_PER_INVITE", "3"))

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
