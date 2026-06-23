import os
import re
import time
import html
import asyncio
from datetime import datetime, timezone
import requests
import xml.etree.ElementTree as ET
from fastapi import FastAPI
from fastapi.middleware.cors import CORSMiddleware
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

# ==========================================
# ۲. توابع بخش اخبار و ترجمه
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
    try:
        res = requests.get("https://cointelegraph.com/rss", headers=headers, timeout=6)
        if res.status_code == 200 and "<item>" in res.text:
            return res.text, "کوین‌تلگراف"
    except Exception:
        print("⚠️ منبع اول در دسترس نبود...")
    try:
        res = requests.get("https://www.coindesk.com/arc/outboundfeeds/rss/", headers=headers, timeout=6)
        if res.status_code == 200 and "<item>" in res.text:
            return res.text, "کوین‌دسک"
    except Exception:
        print("⚠️ منبع دوم در دسترس نبود.")
    return None, None

@app.get("/api/farsi-news")
def get_optimized_farsi_news():
    current_time = time.time()
    if news_cache["data"] and current_time < news_cache["expiry"]:
        return {"status": "success", "source": "cache", "data": news_cache["data"]}
        
    rss_data, source_name = fetch_raw_news_rss()
    if not rss_data:
        if news_cache["data"]:
            return {"status": "success", "source": "expired_cache", "data": news_cache["data"]}
        return {"status": "success", "source": "mock_fallback", "data": MOCK_NEWS}

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
            except Exception:
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
            news_cache["expiry"] = current_time + 900
            return {"status": "success", "source": f"{source_name}_live", "data": optimized_articles}
    except Exception as e:
        print(f"Error: {e}")
    return {"status": "success", "source": "mock_fallback", "data": MOCK_NEWS}

# ==========================================
# ۳. تنظیمات و توابع ربات تلگرام
# ==========================================
TOKEN = "8989227188:AAH0KCEIonjRmN45zLtRq65JIbkY8ON990k"
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

# سیستم راه‌اندازی همزمان ربات تلگرام در پس‌زمینه FastAPI
@app.on_event("startup")
async def startup_event():
    telegram_app = ApplicationBuilder().token(TOKEN).build()
    telegram_app.add_handler(CommandHandler("start", start))
    
    # اجرای ربات به صورت ناهمگام (Async) تا سرور FastAPI قفل نشود
    await telegram_app.initialize()
    await telegram_app.start()
    asyncio.create_task(telegram_app.updater.start_polling())
    print("🚀 ربات تلگرام با موفقیت در پس‌زمینه فعال شد!")

# ==========================================
# ۴. اجرای نهایی سرور
# ==========================================
if __name__ == "__main__":
    import uvicorn
    port = int(os.environ.get("PORT", 8000))
    uvicorn.run("main:app", host="0.0.0.0", port=port)