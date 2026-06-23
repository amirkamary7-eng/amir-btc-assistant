import os
import sys
from dotenv import load_dotenv
from telegram import (
    Update,
    KeyboardButton,
    ReplyKeyboardMarkup,
    WebAppInfo
)
from telegram.ext import (
    ApplicationBuilder,
    CommandHandler,
    ContextTypes
)

load_dotenv()
TOKEN = os.environ.get("TELEGRAM_BOT_TOKEN", "REPLACE_WITH_TOKEN")
WEBAPP_URL = os.environ.get("WEBAPP_URL", "https://amir-btc-assistant.vercel.app")

if TOKEN == "REPLACE_WITH_TOKEN":
    print("⚠️ ERROR: TELEGRAM_BOT_TOKEN not set in environment.")
    sys.exit(1)

async def start(update: Update, context: ContextTypes.DEFAULT_TYPE):
    keyboard = [[
        KeyboardButton(
            text="🚀 Open App",
            web_app=WebAppInfo(url=WEBAPP_URL)
        )
    ]]
    await update.message.reply_text(
        "به Amir BTC Assistant خوش آمدی",
        reply_markup=ReplyKeyboardMarkup(
            keyboard,
            resize_keyboard=True
        )
    )

app = ApplicationBuilder().token(TOKEN).build()
app.add_handler(CommandHandler("start", start))
app.run_polling()