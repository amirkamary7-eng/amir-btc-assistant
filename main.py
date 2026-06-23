import os
import re
import time
import sqlite3
import requests
from datetime import datetime
from fastapi import FastAPI, Request
from fastapi.middleware.cors import CORSMiddleware
from deep_translator import GoogleTranslator
import xml.etree.ElementTree as ET

app = FastAPI(title="Crypto MiniApp Backend Engine")

# حل مشکل CORS برای اتصال بدون دردسر مینی‌اپ
app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)

DB_NAME = "database.db"
BOT_TOKEN = os.getenv("TELEGRAM_BOT_TOKEN", "YOUR_TELEGRAM_BOT_TOKEN")

# سیستم کش مرکزی بک‌اند برای اخبار
news_cache = {
    "data": None,
    "expiry": 0
}

# دیتای پشتیبان جذاب در صورت قطع بودن اینترنت سرور
MOCK_NEWS = [
    {
        "title": "تحلیل بازار: بیت‌کوین در تلاش برای شکستن سقف تاریخی جدید",
        "source": "CoinTelegraph",
        "image": "https://images.cryptocompare.com/news/default/bitcoin.png",
        "url": "https://cointelegraph.com"
    },
    {
        "title": "فوری: تصویب قوانین جدید ارزهای دیجیتال در ایالات متحده",
        "source": "CoinTelegraph",
        "image": "https://images.cryptocompare.com/news/default/ethereum.png",
        "url": "https://cointelegraph.com"
    }
]

def init_db():
    conn = sqlite3.connect(DB_NAME)
    cursor = conn.cursor()
    cursor.execute("PRAGMA journal_mode=WAL;")
    cursor.execute('''
        CREATE TABLE IF NOT EXISTS analysis (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            title TEXT,
            text TEXT,
            date TEXT,
            tag TEXT
        )
    ''')
    conn.commit()
    conn.close()

init_db()

# ==========================================
# بخش دریافت اخبار درجه‌یک از CoinTelegraph
# ==========================================
@app.get("/api/farsi-news")
def get_farsi_news():
    current_time = time.time()
    
    # ۱. استفاده از کش در صورت معتبر بودن زمان
    if news_cache["data"] and current_time < news_cache["expiry"]:
        return {"status": "success", "source": "cache", "data": news_cache["data"]}
        
    try:
        # فراخوانی فید رسمی اخبار داغ کوین‌تلگراف با هدر مرورگر برای دور زدن بلاک
        headers = {"User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36"}
        rss_url = "https://cointelegraph.com/rss"
        res = requests.get(rss_url, headers=headers, timeout=8)
        
        if res.status_code != 200:
            raise Exception(f"CoinTelegraph RSS returned status code {res.status_code}")

        # پارس کردن دیتای XML فید
        root = ET.fromstring(res.text)
        items = root.findall(".//item")[:6] # دریافت ۶ خبر اول و داغ بازار
        
        if not items:
            raise Exception("هیچ خبری در فید پیدا نشد.")

        farsi_articles = []
        translator = GoogleTranslator(source='en', target='fa')

        for item in items:
            title_en = item.find("title").text if item.find("title") is not None else ""
            url = item.find("link").text if item.find("link") is not None else "https://cointelegraph.com"
            description_en = item.find("description").text if item.find("description") is not None else ""
            
            # استخراج هوشمند لینک عکس خبر از داخل تگ‌های XML یا دیسکریپشن
            image_url = "https://images.cryptocompare.com/news/default/bitcoin.png" # عکس پیش‌فرض
            img_match = re.search(r'src="([^"]+)"', description_en)
            if img_match:
                image_url = img_match.group(1)
            else:
                # بررسی تگ‌های جایگزین برای مدیا
                media_content = item.find("{http://search.yahoo.com/mrss/}content")
                if media_content is not None and "url" in media_content.attrib:
                    image_url = media_content.attrib["url"]

            # ترجمه عنوان خبر به فارسی روان
            try:
                translated_title = translator.translate(title_en) if title_en else "بدون عنوان"
            except Exception:
                translated_title = title_en

            farsi_articles.append({
                "title": translated_title,
                "source": "CoinTelegraph",
                "image": image_url,
                "url": url
            })
            
        if farsi_articles:
            news_cache["data"] = farsi_articles
            news_cache["expiry"] = current_time + 1200  # کش کردن اخبار برای ۲۰ دقیقه
            return {"status": "success", "source": "cointelegraph_live", "data": farsi_articles}
        else:
            raise Exception("خطا در ساختار آرایه اخبار فارسی")
        
    except Exception as e:
        print(f"🔴 Live News Redirected to Fallback. Error: {str(e)}")
        if news_cache["data"]:
            return {"status": "success", "source": "expired_fallback", "data": news_cache["data"]}
        return {"status": "success", "source": "mock_fallback", "data": MOCK_NEWS}

# ==========================================
# بخش تحلیل‌ها و وب‌هوک (بدون تغییر نسبت به قبل)
# ==========================================
@app.get("/api/analysis")
def get_analysis():
    try:
        conn = sqlite3.connect(DB_NAME)
        cursor = conn.cursor()
        cursor.execute("SELECT title, text, date, tag FROM analysis ORDER BY id DESC LIMIT 20")
        rows = cursor.fetchall()
        conn.close()
        return {"status": "success", "data": [{"title": r[0], "text": r[1], "date": r[2], "tag": r[3]} for r in rows]}
    except Exception as e:
        return {"status": "error", "message": str(e)}

@app.post("/webhook")
async def telegram_webhook(request: Request):
    try:
        data = await request.json()
        message = data.get("channel_post") or data.get("message")
        if message and "text" in message:
            full_text = message["text"].strip()
            lines = [l.strip() for l in full_text.split("\n") if l.strip()]
            if lines:
                title = lines[0]
                tag = lines[-1] if len(lines) > 1 and lines[-1].startswith("#") else "#کریپتو"
                body_lines = lines[1:-1] if tag != "#کریپتو" else lines[1:]
                text = "\n".join(body_lines).strip() or full_text
                current_date = datetime.now().strftime("%Y-%m-%d %H:%M")
                conn = sqlite3.connect(DB_NAME)
                cursor = conn.cursor()
                cursor.execute("INSERT INTO analysis (title, text, date, tag) VALUES (?, ?, ?, ?)", (title, text, current_date, tag))
                conn.commit()
                conn.close()
        return {"status": "ok"}
    except Exception as e:
        return {"status": "error"}