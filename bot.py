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

TOKEN = "8989227188:AAGg504dd7By2MF3Wl_YT-HHcoBwGX3lCpw"

WEBAPP_URL = "https://amir-btc-assistant.vercel.app"

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