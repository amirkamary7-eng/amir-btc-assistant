"""Standalone bot runner is intentionally disabled.

Telegram bot execution is centralized in main.py via webhook mode to avoid
conflicts between polling and webhook update processing.
"""


def main() -> None:
    raise SystemExit(
        "bot.py is disabled. Run the FastAPI app in main.py so Telegram updates are handled via webhook."
    )


if __name__ == "__main__":
    main()
