import os
import time
import sqlite3
import requests
from datetime import datetime
from fastapi import FastAPI, Request
from fastapi.middleware.cors import CORSMiddleware
from deep_translator import GoogleTranslator

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

# ==========================================
# سیستم کش مرکزی بک‌اند برای اخبار
# ==========================================
news_cache = {
    "data": None,
    "expiry": 0
}

# اخبار آزمایشی برای زمانی که سرور خارجی پاسخ نمی‌دهد (جهت بالا آمدن مینی‌اپ)
MOCK_NEWS = [
    {
        "title": "تحلیل قیمت بیت‌کوین: تلاش برای تثبیت بالای کانال کلیدی",
        "source": "CryptoNews",
        "image": "https://images.cryptocompare.com/news/default/bitcoin.png",
        "url": "https://cryptocompare.com"
    },
    {
        "title": "رشد چشمگیر اتریوم در پی به‌روزرسانی جدید شبکه",
        "source": "EthereumWorld",
        "image": "https://images.cryptocompare.com/news/default/ethereum.png",
        "url": "https://cryptocompare.com"
    },
    {
        "title": "موج جدید استقبال از میم‌کوین‌ها در بازار کریپتو",
        "source": "CoinTelegraph",
        "image": "https://images.cryptocompare.com/news/default/doge.png",
        "url": "https://cryptocompare.com"
    }
]

# ==========================================
# مقداردهی اولیه دیتابیس با قابلیت WAL Mode
# ==========================================
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
# بخش اول: دریافت و ترجمه اخبار (نسخه هوشمند با دیتای پشتیبان)
# ==========================================
@app.get("/api/farsi-news")
def get_farsi_news():
    current_time = time.time()
    
    # ۱. اگر دیتای معتبر در کش موجود است، همان را برگردان
    if news_cache["data"] and current_time < news_cache["expiry"]:
        return {"status": "success", "source": "cache", "data": news_cache["data"]}
        
    try:
        url = "https://min-api.cryptocompare.com/data/v1/news/?lang=EN"
        res = requests.get(url, timeout=6)
        response = res.json()
        
        # بررسی اینکه آیا سرور خطا فرستاده یا خیر
        if isinstance(response, dict) and response.get("Response") == "Error":
            remote_msg = response.get("Message", "خطای ناشناخته از سرور اصلی")
            raise Exception(f"CryptoCompare Error: {remote_msg}")

        articles = []
        if isinstance(response, dict):
            data_field = response.get("Data", [])
            if isinstance(data_field, list):
                articles = data_field[:6]
        elif isinstance(response, list):
            articles = response[:6]
            
        if not articles:
            raise Exception("لیست اخبار دریافتی از سرور خالی است (احتمال لیمیت شدن آی‌پی)")

        farsi_articles = []
        translator = GoogleTranslator(source='en', target='fa')

        for art in articles:
            if not isinstance(art, dict):
                continue
                
            try:
                title_text = art.get("title", "")
                translated_title = translator.translate(title_text) if title_text else "بدون عنوان"
            except Exception:
                # لایه بازگشتی در صورت فیلتر بودن یا خطا دادن گوگل ترنسلیت
                translated_title = art.get("title", "بدون عنوان")
            
            source_info = art.get("source_info", {})
            source_name = source_info.get("name", "CryptoCompare") if isinstance(source_info, dict) else "CryptoCompare"

            farsi_articles.append({
                "title": translated_title,
                "source": source_name,
                "image": art.get("imageurl", ""),
                "url": art.get("url", "#")
            })
            
        if farsi_articles:
            news_cache["data"] = farsi_articles
            news_cache["expiry"] = current_time + 1800
            return {"status": "success", "source": "live", "data": farsi_articles}
        else:
            raise Exception("خطا در پردازش و استخراج فیلدهای اخبار")
        
    except Exception as e:
        # لایه امنیتی نهایی: اگر به هر دلیلی بالا خطا خوردیم، مینی‌اپ را بدون دیتا نگذار!
        print(f"🔴 News API Log: {str(e)}")
        
        # اگر از قبل کش داشتیم (حتی منقضی شده) آن را بفرست
        if news_cache["data"]:
            return {"status": "success", "source": "expired_fallback", "data": news_cache["data"]}
            
        # اگر کش هم نداشتیم، دیتای آزمایشی (Mock) بفرست تا مینی‌اپ ارور ندهد
        return {
            "status": "success", 
            "source": "mock_fallback", 
            "developer_note": f"به دلیل این خطا دیتای دمو لود شد: {str(e)}",
            "data": MOCK_NEWS
        }

# ==========================================
# بخش دوم: ارسال سریع لیست تحلیل‌ها به مینی‌اپ
# ==========================================
@app.get("/api/analysis")
def get_analysis():
    try:
        conn = sqlite3.connect(DB_NAME)
        cursor = conn.cursor()
        cursor.execute("SELECT title, text, date, tag FROM analysis ORDER BY id DESC LIMIT 20")
        rows = cursor.fetchall()
        conn.close()

        analysis_list = [
            {"title": row[0], "text": row[1], "date": row[2], "tag": row[3]}
            for row in rows
        ]
        return {"status": "success", "data": analysis_list}
    except Exception as e:
        return {"status": "error", "message": str(e)}

# ==========================================
# بخش سوم: وب‌هوک هوشمند ربات و کانال تلگرام
# ==========================================
@app.post("/webhook")
async def telegram_webhook(request: Request):
    try:
        data = await request.json()
        message = data.get("channel_post") or data.get("message")
        
        if message and "text" in message:
            full_text = message["text"].strip()
            lines = [line.strip() for line in full_text.split("\n") if line.strip()]
            
            if not lines:
                return {"status": "ignored", "reason": "empty_text"}
                
            title = lines[0]
            tag = "#کریپتو"
            
            if len(lines) > 1 and lines[-1].startswith("#"):
                tag = lines[-1]
                body_lines = lines[1:-1]
            else:
                body_lines = lines[1:]
                
            text = "\n".join(body_lines).strip()
            if not text:
                text = full_text

            current_date = datetime.now().strftime("%Y-%m-%d %H:%M")

            conn = sqlite3.connect(DB_NAME)
            cursor = conn.cursor()
            cursor.execute(
                "INSERT INTO analysis (title, text, date, tag) VALUES (?, ?, ?, ?)",
                (title, text, current_date, tag)
            )
            conn.commit()
            conn.close()
            
        return {"status": "ok"}
    except Exception as e:
        print(f"⚠️ Webhook Exception Logged: {str(e)}")
        return {"status": "error", "detail": "internal_processing_error"}