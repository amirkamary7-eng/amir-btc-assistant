# ============================================================================
# region Imports
# این بخش وابستگی‌ها و importهای فایل `config.py` را نگه می‌دارد.
# ============================================================================
import os
from functools import lru_cache


# endregion

# ============================================================================
# region تعاریف و منطق ماژول
# این بخش ثابت‌ها، مدل‌ها و منطق اصلی فایل را در خود نگه می‌دارد.
# ============================================================================
# Settings ساختار داده یا کلاس اصلی این فایل را تعریف می‌کند.
# ورودی: در زمان نمونه‌سازی یا ارث‌بری، پارامترها و فیلدهای موردنیاز را دریافت می‌کند.
# خروجی: یک ساختار داده، مدل یا رفتار شی‌گرا برای استفاده در سایر بخش‌ها فراهم می‌کند.
class Settings:
    """Application settings loaded from environment variables only."""

    def __init__(self):
        self.DATABASE_URL = os.environ.get("DATABASE_URL", "")
        self.REDIS_URL = os.environ.get("REDIS_URL", "")

        # SECURITY: No hardcoded fallback — must be set via env var in production.
        # Fail-fast: validate_admin_config() will raise if missing in production.
        self.ADMIN_TELEGRAM_ID = os.environ.get("ADMIN_TELEGRAM_ID", "")
        self.ADMIN_IDS = os.environ.get("ADMIN_IDS", "")
        self.TELEGRAM_BOT_TOKEN = os.environ.get("TELEGRAM_BOT_TOKEN", "REPLACE_WITH_TOKEN")
        self.WEBAPP_URL = os.environ.get("WEBAPP_URL", "https://amir-btc-assistant-pages.pages.dev")
        self.REQUIRED_CHANNEL = os.environ.get("REQUIRED_CHANNEL", "amir_btc_2024")

        self.JOIN_CACHE_TTL = int(os.environ.get("JOIN_CACHE_TTL", "1800"))
        self.MAX_WATCHLIST = int(os.environ.get("MAX_WATCHLIST", "7"))

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
        self.TELEGRAM_WEBHOOK_SECRET = os.environ.get("TELEGRAM_WEBHOOK_SECRET", "")
        self.FASTAPI_LEGACY_ROUTES = os.environ.get("FASTAPI_LEGACY_ROUTES", "true").lower() in ("true", "1", "yes")

    @property
    def database_enabled(self) -> bool:
        return bool(self.DATABASE_URL)

    @property
    def redis_enabled(self) -> bool:
        return bool(self.REDIS_URL)

    @property
    def bot_configured(self) -> bool:
        return bool(self.TELEGRAM_BOT_TOKEN and self.TELEGRAM_BOT_TOKEN != "REPLACE_WITH_TOKEN")

    def validate_admin_config(self) -> None:
        """Fail-fast if ADMIN_TELEGRAM_ID is not set in production.

        Raises:
            RuntimeError: If no admin ID is configured.
        """
        if not self.ADMIN_TELEGRAM_ID and not self.ADMIN_IDS:
            raise RuntimeError(
                "ADMIN_TELEGRAM_ID (or ADMIN_IDS) environment variable is required. "
                "Set it to your Telegram user ID (numeric string)."
            )

    @property
    def admin_ids(self) -> set[str]:
        ids = {item.strip() for item in str(self.ADMIN_IDS or "").split(",") if item.strip()}
        if self.ADMIN_TELEGRAM_ID:
            ids.add(str(self.ADMIN_TELEGRAM_ID))
        return ids


@lru_cache
def get_settings() -> Settings:
    return Settings()

# endregion