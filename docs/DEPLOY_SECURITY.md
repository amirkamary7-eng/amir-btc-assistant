# Deploy Security Policy

> هدف: جلوگیری کامل از خراب شدن production با یک commit اشتباه

---

## ۱. قوانین کلی

| قانون | توضیح |
|--------|--------|
| **Production فقط دستی** | هیچ سیستم خودکاری حق deploy به production ندارد |
| **Staging از GitHub** | هر push به main → تست → deploy به staging |
| **main محافظت‌شده** | direct push ممنوع، فقط از طریق PR |
| **تست اجباری** | without passing test suite، staging هم deploy نمی‌شود |

---

## ۲. مسیرهای Deploy

```
GitHub push → main
    │
    ├── npm test ──→ FAIL → stops here, no deploy
    │
    └── npm test ──→ PASS → wrangler deploy --env staging
                                          │
                                          └── amir-btc-assistant-api-staging (خودکار)


Local (only by operator)
    │
    └── npm run cf:deploy:production
            │
            ├── هشدار تعاملی: "Press Ctrl+C to cancel"
            │
            └── wrangler deploy --env production
                    │
                    └── amir-btc-assistant-api-production (دستی)
```

---

## ۳. GitHub Actions — فقط Staging

فایل: `.github/workflows/deploy-staging.yml`

- **توسط:** push به main (فایل‌های non-doc)
- **مرحله ۱:** `npm test` — اگر fail شود، deploy لغو می‌شود
- **مرحله ۲:** `wrangler deploy --env staging` — فقط staging
- **production:** در این workflow وجود ندارد و هرگز deploy نمی‌شود

---

## ۴. اسکریپت‌های package.json

| اسکریپت | عملکرد | خطر |
|---------|--------|------|
| `npm test` | run test suite | امن |
| `npm run cf:dev` | اجرای محلی | امن |
| `npm run cf:deploy:staging` | deploy به staging | امن |
| `npm run cf:deploy:production` | **هشدار تعاملی + تأیید** | نیاز به تأیید دستی |

اسکریپت قدیمی `cf:deploy` حذف شده و با `cf:deploy:production` جایگزین شده که قبل از deploy یک هشدار نمایش می‌دهد و منتظر Enter می‌ماند.

---

## ۵. Branch Protection (تنظیم در GitHub)

برای فعال‌سازی، در تنظیمات مخزن GitHub:

**Settings → Branches → Branch protection rules → Add rule → `main`:**

- [x] **Require a pull request before merging**
  - [x] Require approvals: 1
- [x] **Require status checks to pass before merging**
  - [x] `Run Worker Tests`
  - [x] `Deploy to Staging`
- [x] **Do not allow force pushes**
- [x] **Do not allow delete**

**نکته:** Branch protection فقط از GitHub UI قابل تنظیم است و از طریق کد قابل اعمال نیست.

---

## ۶. GitHub Secrets مورد نیاز

در **Settings → Secrets and variables → Actions → Repository secrets:**

| Secret | استفاده | نحوه دریافت |
|--------|---------|-------------|
| `CLOUDFLARE_ACCOUNT_ID` | شناسایی حساب | Cloudflare Dashboard → Workers & Pages |
| `CLOUDFLARE_API_TOKEN` | احراز هویت deploy | Cloudflare → My Profile → API Tokens → Create Token (Edit Workers) |

**تولید API Token:**
1. برو به https://dash.cloudflare.com/profile/api-tokens
2. Create Token → Custom token
3. Permissions: Account → Workers Scripts → Edit
4. Account Resources: Include → All accounts (یا حساب خاص)
5. Create Token → مقدار را در GitHub Secret ذخیره کن

---

## ۷. خلاصه محافظت‌ها

| لایه | محافظت | وضعیت |
|------|--------|--------|
| GitHub Actions | فقط staging، production وجود ندارد | ✅ |
| package.json | `cf:deploy` حذف شد، `cf:deploy:production` با تأیید | ✅ |
| Workflow YAML | هیچ reference‌ای به production ندارد | ✅ |
| Branch Protection | main نیاز به PR + review + CI pass | ⚠️ باید دستی تنظیم شود |
| GitHub Secrets | API Token محدود به Workers | ⚠️ باید دستی تنظیم شود |