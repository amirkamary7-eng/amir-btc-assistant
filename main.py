import os
import re
import time
import html
import sqlite3
import requests
from datetime import datetime, timezone
from fastapi import FastAPI, Request
from fastapi.middleware.cors import CORSMiddleware
from deep_translator import GoogleTranslator
import xml.etree.ElementTree as ET

app = FastAPI(title="Crypto Premium News Engine")

# اصلاح لایه CORS جهت سازگاری کامل با Vercel و مرورگر تلگرام
app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_credentials=False,  # برای جلوگیری از بلاک شدن توسط مرورگر روی False تنظیم شد
    allow_methods=["*"],
    allow_headers=["*"],
)

DB_NAME = "database.db"

# کش مرکزی اخبار
news_cache = {"data": None, "expiry": 0}

# تمیزکننده تگ‌های HTML و متون اضافه
def clean_html(raw_html):
    if not raw_html: return ""
    clean_text = re.sub(r'<[^>]+>', '', raw_html) # حذف تگ‌ها
    clean_text = html.unescape(clean_text)        # تبدیل کاراکترهای خاص مثل &quot;
    clean_text = re.sub(r'\s+', ' ', clean_text).strip()
    return clean_text[:150] + "..." if len(clean_text) > 150 else clean_text

# محاسبه زمان گذشته به فارسی روانی شبیه شبکه‌های اجتماعی
def parse_relative_time(date_str):
    try:
        # فرمت استاندارد RSS (مثال: Wed, 23 Jun 2026 07:20:00 +0000)
        clean_date = date_str.split(" +")[0].split(" GMT")[0].strip()
        parsed_time = datetime.strptime(clean_date, "%a, %d %b %Y %H:%M:%S").replace(tzinfo=timezone.utc)
        now = datetime.now(timezone.utc)
        diff = now - parsed_time
        
        minutes = int(diff.total_seconds() / 60)
        if minutes < 1: return "همین الان"
        if minutes < 60: return f"{minutes} دقیقه پیش"
        
        hours = int(minutes / 60)
        if hours < 24: return f"{hours} ساعت پیش"
        
        days = int(hours / 24)
        return f"{days} روز پیش"
    except Exception:
        return "اخیراً"

# دیتای دمو فوق‌العاده شیک در صورت قطعی کامل اینترنت یا بلاک بودن آی‌پی سرور
MOCK_NEWS = [
    {
        "title": "فورى: بیت‌کوین سقف مقاومتی جدید را شکست!",
        "description": "بازار ارزهای دیجیتال پس از ورود سرمایه‌گذاران سازمانی شاهد رشد شارپ فوق‌العاده‌ای در قیمت بیت‌کوین و اتریوم بوده است.",
        "time_ago": "۵ دقیقه پیش",
        "source": "کوین‌تلگراف",
        "image": "https://images.cryptocompare.com/news/default/bitcoin.png",
        "url": "https://cointelegraph.com"
    }
]

# تابع اصلی دریافت و بهینه‌سازی دیتای اخبار از منابع چندگانه
def fetch_raw_news_rss():
    headers = {"User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36"}
    
    # منبع اول: CoinTelegraph
    try:
        res = requests.get("https://cointelegraph.com/rss", headers=headers, timeout=6)
        if res.status_code == 200 and "<item>" in res.text:
            return res.text, "کوین‌تلگراف"
    except Exception:
        print("⚠️ منبع اول (CoinTelegraph) در دسترس نبود. سوییچ به منبع پشتیبان...")

    # منبع دوم (پشتیبان زنده): CoinDesk
    try:
        res = requests.get("https://www.coindesk.com/arc/outboundfeeds/rss/", headers=headers, timeout=6)
        if res.status_code == 200 and "<item>" in res.text:
            return res.text, "کوین‌دسک"
    except Exception:
        print("⚠️ منبع دوم هم در دسترس نبود.")
        
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
        items = root.findall(".//item")[:6] # گلچین ۶ خبر داغ اول بازار
        
        optimized_articles = []
        translator = GoogleTranslator(source='en', target='fa')

        for item in items:
            title_en = item.find("title").text if item.find("title") is not None else ""
            url = item.find("link").text if item.find("link") is not None else ""
            desc_en = item.find("description").text if item.find("description") is not None else ""
            pub_date = item.find("pubDate").text if item.find("pubDate") is not None else ""
            
            clean_desc_en = clean_html(desc_en)
            
            # استخراج هوشمند عکس اصلی خبر با فیلتر آدرس‌های نامعتبر
            image_url = "https://images.cryptocompare.com/news/default/bitcoin.png"
            img_match = re.search(r'src="([^"]+)"', desc_en)
            if img_match:
                image_url = img_match.group(1)
            else:
                media = item.find("{http://search.yahoo.com/mrss/}content")
                if media is not None and "url" in media.attrib:
                    image_url = media.attrib["url"]

            # ترجمه روان عنوان و توضیحات با هندل کردن خطاها
            try:
                translated_title = translator.translate(title_en) if title_en else "بدون عنوان"
                translated_desc = translator.translate(clean_desc_en) if clean_desc_en else ""
            except Exception:
                translated_title = title_en
                translated_desc = clean_desc_en

            # بهینه‌سازی نهایی متون برای جلوگیری از شکستن کدهای جاوااسکریپت
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
            news_cache["expiry"] = current_time + 900 # کش ۱۵ دقیقه‌ای
            return {"status": "success", "source": f"{source_name}_live", "data": optimized_articles}
            
    except Exception as e:
        print(f"Error parsing RSS: {e}")
        
    return {"status": "success", "source": "mock_fallback", "data": MOCK_NEWS}

# بخش استارت اتوماتیک و هماهنگ با فرآیند دیپلوی وب
if __name__ == "__main__":
    import uvicorn
    # استخراج نام فایل جاری پایتون به صورت پویا جهت هماهنگی کامل با سرور ریلوِی
    file_name = os.path.basename(__file__).split('.')[0]
    port = int(os.environ.get("PORT", 8000))
    uvicorn.run(f"{file_name}:app", host="0.0.0.0", port=port)