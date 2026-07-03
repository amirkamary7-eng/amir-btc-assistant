# LIVE STATE CHECKLIST (قبل از هر deploy)

> هدف: وضعیت واقعی production را قبل از deploy مشخص کنید تا ambiguity بین Worker / FastAPI و Pages از بین برود.

## اطلاعات اپراتور

- تاریخ: 
- نام اپراتور: 

## موارد بررسی (نتیجه را اپراتور پر می‌کند)

- [ ] URL فعلی webhook در BotFather  
  نتیجه: 

- [ ] Host واقعی Mini App (Pages URL)  
  نتیجه: 

- [ ] مقدار `window.API_BASE` در browser DevTools  
  نتیجه: 

- [ ] آیا `/api/health` روی همان host پاسخ می‌دهد  
  نتیجه: 

- [ ] Worker name فعال: `amir-btc-assistant-api-production` یا FastAPI  
  نتیجه: 

## Webhook Cutover (فقط یک target)

> هدف: فقط Worker webhook فعال باشد تا پیام‌های تکراری /start رخ ندهد.

- [ ] Set webhook: `https://<worker-host>/telegram`  
  نتیجه: 

- [ ] Set `secret_token` (placeholder برای TASK 2.11)  
  نتیجه: 

- [ ] Remove/stop FastAPI webhook registration  
  نتیجه: 
