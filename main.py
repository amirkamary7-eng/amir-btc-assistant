import os
import re
import time
import html
from datetime import datetime, timezone
import requests
import xml.etree.ElementTree as ET
from fastapi import FastAPI
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import JSONResponse
from deep_translator import GoogleTranslator

# کتابخانه‌های ربات تلگرام
from telegram import Update, KeyboardButton, ReplyKeyboardMarkup, WebAppInfo
from telegram.ext import ApplicationBuilder, CommandHandler, ContextTypes

# ==========================================
# ۱. تنظیمات و راه‌اندازی FastAPI
# ==========================================
app = FastAPI(title="Crypto Premium News & Bot Engine")

app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_credentials=False,
    allow_methods=["*"],
    allow_headers=["*"],
)

# کش مرکزی اخبار
news_cache = {"data": None, "expiry": 0}
CACHE_TTL = 900  # ۱۵ دقیقه

telegram_app = None

# ==========================================
# ۲. مسیر ریشه برای تست سلامت سرور
# ==========================================
@app.get("/")
async def root():
    return {"status": "ok", "message": "Amir BTC Assistant Backend is running!"}

# ==========================================
# ۳. توابع بخش اخبار و ترجمه
# ==========================================
def clean_html(raw_html):
    if not raw_html: return ""
    clean_text = re.sub(r'<[^>]+>', '', raw_html)
    clean_text = html.unescape(clean_text)
    clean_text = re.sub(r'\s+', ' ', clean_text).strip()
    return clean_text[:150] + "..." if len(clean_text) > 150 else clean_text

def parse_relative_time(date_str):
    try:
        clean_date = date_str.split(" +")[0].split(" GMT")[0].strip()
        parsed_time = datetime.strptime(clean_date, "%a, %d %b %Y %H:%M:%S").replace(tzinfo=timezone.utc)
        now = datetime.now(timezone.utc)
        diff = now - parsed_time
        minutes = int(diff.total_seconds() / 60)
        if minutes < 1: return "همین الان"
        if minutes < 60: return f"{minutes} دقیقه پیش"
        hours = int(minutes / 60)
        if hours < 24: return f"{hours} ساعت پیش"
        return f"{int(hours / 24)} روز پیش"
    except Exception:
        return "اخیراً"

MOCK_NEWS = [{
    "title": "فورى: بیت‌کوین سقف مقاومتی جدید را شکست!",
    "description": "بازار ارزهای دیجیتال پس از ورود سرمایه‌گذاران سازمانی شاهد رشد شارپ فوق‌العاده‌ای در قیمت بیت‌کوین و اتریوم بوده است.",
    "time_ago": "۵ دقیقه پیش",
    "source": "کوین‌تلگراف",
    "image": "https://images.cryptocompare.com/news/default/bitcoin.png",
    "url": "https://cointelegraph.com"
}]

def fetch_raw_news_rss():
    headers = {"User-Agent": "Mozilla/5.0"}
    sources = [
        ("https://cointelegraph.com/rss", "کوین‌تلگراف"),
        ("https://www.coindesk.com/arc/outboundfeeds/rss/", "کوین‌دسک")
    ]
    for url, name in sources:
        try:
            res = requests.get(url, headers=headers, timeout=6)
            if res.status_code == 200 and "<item>" in res.text:
                return res.text, name
        except Exception as e:
            print(f"⚠️ منبع {name} در دسترس نبود: {e}")
    return None, None

@app.get("/api/farsi-news")
async def get_optimized_farsi_news():
    current_time = time.time()
    if news_cache["data"] and current_time < news_cache["expiry"]:
        return JSONResponse(content={"status": "success", "source": "cache", "data": news_cache["data"]})

    rss_data, source_name = fetch_raw_news_rss()
    if not rss_data:
        if news_cache["data"]:
            return JSONResponse(content={"status": "success", "source": "expired_cache", "data": news_cache["data"]})
        return JSONResponse(content={"status": "success", "source": "mock_fallback", "data": MOCK_NEWS})

    try:
        root = ET.fromstring(rss_data)
        items = root.findall(".//item")[:6]
        optimized_articles = []
        translator = GoogleTranslator(source='en', target='fa')

        for item in items:
            title_en = item.find("title").text if item.find("title") is not None else ""
            url = item.find("link").text if item.find("link") is not None else ""
            desc_en = item.find("description").text if item.find("description") is not None else ""
            pub_date = item.find("pubDate").text if item.find("pubDate") is not None else ""

            clean_desc_en = clean_html(desc_en)
            image_url = "https://images.cryptocompare.com/news/default/bitcoin.png"
            img_match = re.search(r'src="([^"]+)"', desc_en)
            if img_match:
                image_url = img_match.group(1)

            try:
                translated_title = translator.translate(title_en) if title_en else "بدون عنوان"
                translated_desc = translator.translate(clean_desc_en) if clean_desc_en else ""
            except Exception as e:
                print(f"Translation error: {e}")
                translated_title = title_en
                translated_desc = clean_desc_en

            optimized_articles.append({
                "title": translated_title.replace("\n", " ").strip(),
                "description": translated_desc.replace("\n", " ").strip(),
                "time_ago": parse_relative_time(pub_date),
                "source": source_name,
                "image": image_url,
                "url": url
            })

        if optimized_articles:
            news_cache["data"] = optimized_articles
            news_cache["expiry"] = current_time + CACHE_TTL
            return JSONResponse(content={"status": "success", "source": f"{source_name}_live", "data": optimized_articles})
    except ET.ParseError as e:
        print(f"XML Parse Error: {e}")
    except Exception as e:
        print(f"Unexpected error: {e}")

    return JSONResponse(content={"status": "success", "source": "mock_fallback", "data": MOCK_NEWS})

# ==========================================
# ۴. تنظیمات و توابع ربات تلگرام (در صورت نیاز)
# ==========================================
TOKEN = os.environ.get("TELEGRAM_BOT_TOKEN", "REPLACE_WITH_TOKEN")
WEBAPP_URL = os.environ.get("WEBAPP_URL", "https://amir-btc-assistant.vercel.app")

if TOKEN == "REPLACE_WITH_TOKEN":
    print("⚠️ WARNING: TELEGRAM_BOT_TOKEN not set in environment. Telegram bot will not start until configured.")

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

@app.on_event("startup")
async def startup_event():
    global telegram_app
    if not TOKEN or TOKEN == "REPLACE_WITH_TOKEN":
        print("ℹ️ Telegram token not configured; skipping telegram bot startup.")
        return

    telegram_app = ApplicationBuilder().token(TOKEN).build()
    telegram_app.add_handler(CommandHandler("start", start))

    await telegram_app.initialize()
    await telegram_app.start()
    await telegram_app.updater.start_polling(drop_pending_updates=True)
    print("🚀 ربات تلگرام با موفقیت در پس‌زمینه فعال شد!")

@app.on_event("shutdown")
async def shutdown_event():
    global telegram_app
    if telegram_app:
        try:
            if telegram_app.updater.running:
                await telegram_app.updater.stop()
            await telegram_app.stop()
            await telegram_app.shutdown()
        except Exception:
            pass
        print("🔌 ربات تلگرام متوقف شد.")

# ==========================================
# ۵. اجرای نهایی سرور
# ==========================================
if __name__ == "__main__":
    import uvicorn
    port = int(os.environ.get("PORT", 8000))
    uvicorn.run("main:app", host="0.0.0.0", port=port)