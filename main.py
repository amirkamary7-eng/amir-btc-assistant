import os
import sqlite3
import requests
from fastapi import FastAPI, Request
from fastapi.middleware.cors import CORSMiddleware
from deep_translator import GoogleTranslator

app = FastAPI()

# حل مشکل CORS برای اتصال مینی‌اپ
app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)

DB_NAME = "database.db"

# ==========================================
# دیتابیس: ساخت جدول تحلیل‌ها در صورت عدم وجود
# ==========================================
def init_db():
    conn = sqlite3.connect(DB_NAME)
    cursor = conn.cursor()
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
# بخش اول: دریافت اخبار فارسی از خارج
# ==========================================
@app.get("/api/farsi-news")
def get_farsi_news():
    try:
        url = "https://min-api.cryptocompare.com/data/v1/news/?lang=EN"
        response = requests.get(url).json()
        articles = response.get("Data", [])[:6]
        
        farsi_articles = []
        translator = GoogleTranslator(source='en', target='fa')

        for art in articles:
            translated_title = translator.translate(art["title"])
            farsi_articles.append({
                "title": translated_title,
                "source": art["source_info"]["name"],
                "image": art["imageurl"],
                "url": art["url"]
            })
        return {"status": "success", "data": farsi_articles}
    except Exception as e:
        return {"status": "error", "message": str(e)}

# ==========================================
# بخش دوم: ارسال تحلیل‌ها به وب‌اپ
# ==========================================
@app.get("/api/analysis")
def get_analysis():
    try:
        conn = sqlite3.connect(DB_NAME)
        cursor = conn.cursor()
        # دریافت تحلیل‌ها به ترتیب از جدیدترین به قدیمی‌ترین
        cursor.execute("SELECT title, text, date, tag FROM analysis ORDER BY id DESC")
        rows = cursor.fetchall()
        conn.close()

        analysis_list = []
        for row in rows:
            analysis_list.append({
                "title": row[0],
                "text": row[1],
                "date": row[2],
                "tag": row[3]
            })
        return {"status": "success", "data": analysis_list}
    except Exception as e:
        return {"status": "error", "message": str(e)}

# ==========================================
# بخش سوم: دریافت خودکار تحلیل از ربات تلگرام
# ==========================================
# توکن ربات خود را اینجا بگذارید (از BotFather بگیرید)
BOT_TOKEN = "YOUR_TELEGRAM_BOT_TOKEN" 

@app.post("/webhook")
async def telegram_webhook(request: Request):
    try:
        data = await request.json()
        
        # بررسی اینکه آیا پیام از کانال آمده یا گروه/چت معمولی
        message = data.get("channel_post") or data.get("message")
        
        if message and "text" in message:
            full_text = message["text"]
            
            # فرض می‌کنیم خط اول پیام شما تایتل، بقیه متن و خط آخر هشتگ است
            lines = full_text.split("\n")
            title = lines[0] if len(lines) > 0 else "تحلیل جدید بازار"
            tag = lines[-1] if len(lines) > 1 and lines[-1].startswith("#") else "#Crypto"
            
            # متن اصلی تحلیل (حذف خط اول و آخر در صورت وجود هشتگ)
            body_lines = lines[1:-1] if tag != "#Crypto" else lines[1:]
            text = "\n".join(body_lines).strip()
            if not text:
                text = full_text

            # ذخیره در دیتابیس
            conn = sqlite3.connect(DB_NAME)
            cursor = conn.cursor()
            cursor.execute(
                "INSERT INTO analysis (title, text, date, tag) VALUES (?, ?, ?, ?)",
                (title, text, "امروز", tag)
            )
            conn.commit()
            conn.close()
            
        return {"status": "ok"}
    except Exception as e:
        print("Webhook Error:", str(e))
        return {"status": "error"}