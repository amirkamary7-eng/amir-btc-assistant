# Deploy Security Policy

> هدف: جلوگیری کامل از خراب شدن production با یک commit اشتباه

---

## ۰. وضعیت واقعی (SEC-09 FIX — Phase 20)

این سند قبلاً با رفتار واقعی workflowها تناقض داشت (ادعای «production فقط دستی»
در حالی که `deploy-production.yml` از ابتدا روی push به main به‌صورت خودکار
دیپلوی می‌کرد). از Phase 20 این سند با رفتار واقعی هماهنگ شده است.

**نکته مهم درباره GitHub Environment:** در زمان نگارش، محیط‌های `Production` و
`staging` در مخزن **وجود دارند اما هیچ Protection Rule (تأییدیه/محدودیت
branch) روی آن‌ها فعال نیست** و workflowها فعلاً به هیچ Environmentای reference
نمی‌دهند. افزودن `environment:` به jobها بدون فعال‌سازی Protection از سمت مالک،
«محافظت» ایجاد نمی‌کند — فقط پس از تنظیم دستی Protection معنا پیدا می‌کند.

---

## ۱. قوانین کلی

| قانون | توضیح | وضعیت |
|--------|--------|--------|
| **تست اجباری** | بدون pass شدن `npm test` هیچ deployای (staging یا production) انجام نمی‌شود | ✅ در هر دو workflow به‌صورت strict needs-chain |
| **سطح دسترسی توکن** | هر دو workflow با `permissions: contents: read` اجرا می‌شوند (least-privilege GITHUB_TOKEN) | ✅ Phase 20 (SEC-09) |
| **بدون عبور از تست** | ورودی `skip_tests` از workflow حذف شد (۰ استفاده در ۶۵۱ اجرای تاریخچه — API-verified)؛ dispatch دستی هم همیشه تست را اجرا می‌کند | ✅ Phase 20 (SEC-09) |
| **main محافظت‌شده** | direct push ممنوع، فقط از طریق PR | ⚠️ **فعال نیست** — نیازمند تنظیم دستی (بخش ۵) |

---

## ۲. مسیرهای Deploy (واقعی)

```
GitHub push → main (فایل‌های non-doc)
    │
    ├── Deploy Staging workflow
    │       ├── npm test ──→ FAIL → stops here
    │       └── npm test ──→ PASS → wrangler deploy --env staging
    │                                 └── amir-btc-assistant-api-staging (خودکار)
    │
    └── Deploy Production workflow (parallel)
            ├── npm test ──→ FAIL → stops here
            ├── migrate-db (psql -f scripts/00-migrate.sql روی SUPABASE_DATABASE_URL
            │               + بررسی‌های idempotency و schema) ──→ FAIL → deployها BLOCK
            ├── deploy-worker ──→ wrangler deploy --env production
            ├── deploy-pages  ──→ wrangler pages deploy + rollout promote
            └── verify ──→ probingهای http روی Worker/Pages production

workflow_dispatch (دستی، فقط Deploy Production)
    └── همان زنجیره؛ تست همیشه اجرا می‌شود (skip_tests حذف شده)

Local (فقط توسط اپراتور)
    └── npm run cf:deploy:production (هشدار تعاملی + تأیید)
```

**تفاوت Staging و Production:**

| | Deploy Staging | Deploy Production |
|---|---|---|
| Trigger | push به main (non-doc) + — | push به main (non-doc) + workflow_dispatch |
| تست | `npm test` (gate) | `npm test` (gate) |
| Migration DB | ندارد | `scripts/00-migrate.sql` (idempotent، ۲بار اجرا: atomic + idempotency test) |
| خروجی | Worker staging | Worker production + Pages production + verify probes |
| Secrets | `CLOUDFLARE_ACCOUNT_ID`, `CLOUDFLARE_API_TOKEN` | همان‌ها + `SUPABASE_DATABASE_URL` |
| Concurrency | `deploy-staging` (cancel-in-progress) | `deploy-production` (queue) |

---

## ۳. GitHub Actions — هر دو workflow

فایل‌ها: `.github/workflows/deploy-staging.yml` و `.github/workflows/deploy-production.yml`

- **توسط:** push به main (فایل‌های non-doc) — production از طریق workflow_dispatch هم قابل اجراست
- **مرحله ۱:** `npm test` — اگر fail شود، هیچ deployای انجام نمی‌شود
- **مرحله ۲ (فقط production):** migrate-db → deploy-worker و deploy-pages → verify
- **permissions:** `contents: read` (هر دو workflow، Phase 20)
- **skip_tests:** حذف شده — dispatch دستی همیشه تست را اجرا می‌کند
- **اجرای workflowها در این فاز ممنوع:** هیچ deploy واقعی نباید صرفاً برای «تست
  workflow» انجام شود؛ اعتبارسنجی ساختاری توسط
  `tests/deploy-workflow-security-sec09-test.cjs` پوشش داده می‌شود.

---

## ۴. اسکریپت‌های package.json

| اسکریپت | عملکرد | خطر |
|---------|--------|------|
| `npm test` | run test suite | امن |
| `npm run cf:dev` | اجرای محلی | امن |
| `npm run cf:deploy:staging` | deploy به staging | امن |
| `npm run cf:deploy:production` | **هشدار تعاملی + تأیید** | نیاز به تأیید دستی |

---

## ۵. تنظیمات دستی مالک (از کد قابل اعمال نیستند)

این موارد **هیچ‌کدام از داخل workflow YAML یا کد فعال نمی‌شوند** و باید در
GitHub UI تنظیم شوند. تا پیش از فعال‌سازی، وضعیت فعلی «بدون این محافظت‌ها»
است و صادقانه همین‌طور گزارش می‌شود:

1. **Branch protection روی `main`** — در زمان نگارش **فعال نیست**:
   Settings → Branches → Branch protection rules → Add rule → `main`
   - [ ] Require a pull request before merging (approvals: 1)
   - [ ] Require status checks: `Run Worker Tests`
   - [ ] Do not allow force pushes / deletions
2. **GitHub Environment protection** — محیط‌های `Production`/`staging` موجود
   اما **بدون Protection Rule** هستند. برای تأییدیه قبل از deploy:
   Settings → Environments → `Production` → Required reviewers + deployment
   branch policy (فقط `main`). سپس در workflow به jobهای deploy اضافه شود:
   ```yaml
   deploy-worker:
     environment: Production   # پس از فعال‌سازی Protection معنا پیدا می‌کند
   ```
   تا Protection فعال نشده باشد، این خط «محافظت» ایجاد نمی‌کند — فقط history
   می‌سازد؛ به همین دلیل در Phase 20 به workflow اضافه نشد.
3. **GITHUB_TOKEN default permissions** — تنظیم repo-level:
   Settings → Actions → General → Workflow permissions → **Read repository
   contents** (با وجود `permissions:` صریح در workflowها، این تنظیم برای
   workflowهای آینده safety-net است.)

---

## ۶. GitHub Secrets مورد نیاز

در **Settings → Secrets and variables → Actions → Repository secrets:**

| Secret | استفاده | نحوه دریافت |
|--------|---------|-------------|
| `CLOUDFLARE_ACCOUNT_ID` | شناسایی حساب | Cloudflare Dashboard → Workers & Pages |
| `CLOUDFLARE_API_TOKEN` | احراز هویت deploy (Worker + Pages + API rollout) | Cloudflare → My Profile → API Tokens (Workers Scripts Edit + Cloudflare Pages Edit) |
| `SUPABASE_DATABASE_URL` | اجرای migration روی production DB (فقط job migrate-db) | Supabase → Project Settings → Database → Connection string (URI) |

**تولید API Token:**
1. برو به https://dash.cloudflare.com/profile/api-tokens
2. Create Token → Custom token
3. Permissions: Account → Workers Scripts → Edit (+ Pages → Edit برای deploy-pages)
4. Account Resources: Include → حساب مربوطه
5. Create Token → مقدار را در GitHub Secret ذخیره کن

**نگهداری `SUPABASE_DATABASE_URL`:** هرگز در log چاپ نمی‌شود (psql با `-X -q`
اجرا می‌شود و URL echo نمی‌شود؛ بعد از هر step با `unset` پاک می‌شود).

---

## ۷. امنیت دیتابیس و نقش‌ها (SEC-10 — Phase 20)

مدل واقعی دسترسی (مستند، بدون تغییر زنده):

- Worker با **یک نقش واحد** (`amirbtc_worker` — شواهد F-02 و اتصال‌های فعال)
  از طریق Hyperdrive/PgPool به دیتابیس وصل می‌شود؛ مالکیت داده در
  **لایه اپلیکیشن** با predicateهای `WHERE telegram_id = ...` اعمال می‌شود.
- `scripts/00-migrate.sql` (در CI توسط job migrate-db اجرا می‌شود):
  - هیچ `GRANT` به `anon`/`authenticated` ندارد؛
  - `REVOKE EXECUTE ... FROM PUBLIC` روی `groq_generate_with_key` + GRANT
    گاردشده به `amirbtc_worker` (F-02) دارد.
- `scripts/01-revoke-anon-authenticated.sql` (**دستی، در CI نیست**):
  REVOKE ALL روی همه جدول‌های schema public از `anon`/`authenticated` +
  REVOKE EXECUTE از PUBLIC روی دو تابع Groq. idempotent و rollback-safe.
  **اجرای خودکار آن روی دیتابیس زنده عمداً فعال نشده است.**

**Runbook دستی 01-revoke (فقط با تأیید مالک/DBA):**

1. در Supabase SQL Editor (یا psql با connection string مالک) اجرا شود؛
   transaction داخلی دارد و idempotent است.
2. پس از هر deploy که جدول جدیدی به `00-migrate.sql` اضافه کرده، دوباره
   اجرا شود (REVOKE اسکیمابه‌اسکیماست اما فقط جدول‌های موجود هنگام اجرا را
   می‌پوشاند).
3. کوئری‌های Verification در انتهای خود فایل آمده است (انتظار: ۰ ردیف
   privilege برای anon/authenticated).
4. Rollback در صورت خطای اپلیکیشن: اسکریپت Rollback انتهای فایل.

**RLS (Row Level Security):** در هیچ migrationای وجود ندارد و فعال‌سازی آن
**موضوع یک تصمیم مالک/DBA است، نه یک تغییر کد**: نقش Worker تک‌نقشی است،
policyهای per-user نیازمند plumbing `SET LOCAL` در کل زنجیره queryDb است، و
وضعیت BYPASSRLS/مالکیت جدول‌ها در schema زنده بدون کوئری مستقیم قابل تأیید
نیست. تست `tests/db-privileges-structural-sec10-test.cjs` این invariantها را
قفل کرده است (بدون GRANT به anon/authenticated، بدون اجرای خودکار 01-revoke
در CI، بدون RLS/POLICY در migrationها) تا هر تغییر آینده آگاهانه و بازبینی‌شده
باشد.

---

## ۸. خلاصه محافظت‌ها

| لایه | محافظت | وضعیت |
|------|--------|--------|
| GitHub Actions permissions | `contents: read` در هر دو workflow | ✅ Phase 20 |
| GitHub Actions تست | strict needs-chain؛ skip_tests حذف | ✅ Phase 20 |
| Migration gate | deployها نیاز به موفقیت migrate-db دارند | ✅ |
| Migration safety | static DDL guards + idempotency re-run در CI | ✅ |
| Branch Protection | main نیاز به PR + review + CI pass | ⚠️ **باید دستی تنظیم شود (فعلاً خاموش)** |
| Environment Protection | تأییدیه قبل از deploy production | ⚠️ **باید دستی تنظیم شود (فعلاً خاموش)** |
| GitHub Secrets | API Token محدود؛ SUPABASE URL هرگز در log نیست | ✅ (scope توکن قابل‌تأیید از داشبورد نیست) |
| DB least-privilege | 01-revoke دستی + F-02 در 00-migrate | ⚠️ اجرای 01-revoke روی live نیازمند تأیید مالک |
