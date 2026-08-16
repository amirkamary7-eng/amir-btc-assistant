-- ═══════════════════════════════════════════════════════════════════════════
-- PHASE 1 — Premium Rules + Versioned Acceptance Schema
-- ═══════════════════════════════════════════════════════════════════════════
-- Adds two tables:
--   1. membership_rules          — immutable, versioned rule documents
--   2. membership_rule_acceptances — per-user acceptance records (audit trail)
--
-- And one column on membership_requests:
--   rules_version  — which rules version was active when the request was submitted
--
-- SAFETY:
--   • 100% idempotent (IF NOT EXISTS / ON CONFLICT DO NOTHING)
--   • No DROP, no TRUNCATE, no DELETE of existing data
--   • No FK constraints that would break existing rows (rules_version is nullable)
--   • Rollback: DROP TABLE membership_rules; DROP TABLE membership_rule_acceptances;
--     ALTER TABLE membership_requests DROP COLUMN IF EXISTS rules_version;
--
-- Run against: Supabase PostgreSQL (DATABASE_URL)
-- ═══════════════════════════════════════════════════════════════════════════

-- ─── Table: membership_rules ────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS membership_rules (
  id              TEXT PRIMARY KEY DEFAULT gen_random_uuid()::text,
  version         INTEGER NOT NULL UNIQUE,
  title           TEXT NOT NULL,
  body_markdown   TEXT NOT NULL,
  summary         TEXT,
  status          TEXT NOT NULL DEFAULT 'DRAFT'
                    CHECK (status IN ('DRAFT', 'ACTIVE', 'ARCHIVED')),
  effective_at    TIMESTAMPTZ,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  created_by      TEXT,
  updated_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE UNIQUE INDEX IF NOT EXISTS uq_membership_rules_active
  ON membership_rules (status)
  WHERE status = 'ACTIVE';

CREATE INDEX IF NOT EXISTS idx_membership_rules_status
  ON membership_rules (status);

CREATE INDEX IF NOT EXISTS idx_membership_rules_version
  ON membership_rules (version);

-- ─── Table: membership_rule_acceptances ────────────────────────────────────
CREATE TABLE IF NOT EXISTS membership_rule_acceptances (
  id              TEXT PRIMARY KEY DEFAULT gen_random_uuid()::text,
  telegram_id     TEXT NOT NULL,
  rules_version   INTEGER NOT NULL,
  request_id      TEXT,
  accepted_at     TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  ip              TEXT,
  user_agent      TEXT,
  metadata        JSONB DEFAULT '{}'::jsonb,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE UNIQUE INDEX IF NOT EXISTS uq_acceptance_user_version
  ON membership_rule_acceptances (telegram_id, rules_version);

CREATE INDEX IF NOT EXISTS idx_acceptance_telegram_id
  ON membership_rule_acceptances (telegram_id);

CREATE INDEX IF NOT EXISTS idx_acceptance_rules_version
  ON membership_rule_acceptances (rules_version);

-- ─── Column: membership_requests.rules_version ─────────────────────────────
DO $$ BEGIN
  ALTER TABLE membership_requests ADD COLUMN IF NOT EXISTS rules_version INTEGER;
EXCEPTION WHEN duplicate_column THEN NULL; END $$;

CREATE INDEX IF NOT EXISTS idx_mr_rules_version
  ON membership_requests (rules_version)
  WHERE rules_version IS NOT NULL;

-- ─── updated_at trigger ───────────────────────────────────────────────────
CREATE OR REPLACE FUNCTION membership_rules_set_updated_at()
RETURNS TRIGGER AS $$
BEGIN
  NEW.updated_at = NOW();
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS trg_mrules_updated ON membership_rules;
CREATE TRIGGER trg_mrules_updated BEFORE UPDATE ON membership_rules
  FOR EACH ROW EXECUTE FUNCTION membership_rules_set_updated_at();

-- ═══════════════════════════════════════════════════════════════════════════
-- SEED: Premium Rules v1 (ACTIVE)
-- ═══════════════════════════════════════════════════════════════════════════
INSERT INTO membership_rules (version, title, body_markdown, summary, status, effective_at, created_by)
VALUES (
  1,
  'قوانین عضویت Premium — نسخه ۱',
  E'# قوانین عضویت Premium\n\n## Premium چیست؟\n\nعضویت Premium یک لایه دسترسی ویژه است که در ازای رعایت شرایط عضویت، مزایای اضافه‌تر را در اختیار شما قرار می‌دهد. Premium یک اشتراک پولی نیست؛ بلکه پاداشی است برای کاربرانی که در اکوسیستم AMIRBTC فعال هستند و شرایط عضویت را رعایت می‌کنند.\n\n## مزایای Premium\n\n- سهمیه بالاتر در هشدارهای قیمتی، چت هوش مصنوعی و سایر قابلیت‌های پرمصرف\n- دسترسی به فروشگاه Premium Rewards (خرید با AB Token)\n- دسترسی به فروشگاه Profile Cosmetics (شخصی‌سازی پروفایل با AB Token)\n- نشان Premium در پروفایل\n- اولویت در دریافت قابلیت‌های جدید و کمپین‌های اختصاصی\n\n**توجه:** Premium به معنای نامحدود بودن نیست. برای قابلیت‌های پرهزینه، سهمیه Premium بالاتر از کاربر عادی است اما همچنان محدود است.\n\n## شرایط فعال ماندن Premium\n\n1. حساب کاربری فعال و در دسترس باشد.\n2. عضویت در کانال رسمی AMIRBTC حفظ شود.\n3. شرط صرافی (Exchange Requirement) فعلی رعایت شود.\n\n## شرط صرافی\n\nدر هر زمان، یک صرافی به‌عنوان «صرافی موردنیاز» تعریف می‌شود. در آینده ممکن است صرافی موردنیاز تغییر کند. در صورت تغییر، مهلت تطبیق (Grace Period) به شما داده می‌شود.\n\n## تغییر قوانین\n\nاین قوانین ممکن است در آینده به‌روزرسانی شوند. کاربران جدید باید نسخه جدید را بپذیرند. کاربران فعلی Premium نیازی به پذیرش مجدد ندارند مگر اینکه تغییرات اساسی باشد.\n\n## پذیرش قوانین\n\nبا تأیید این قوانین، شما تأیید می‌کنید که قوانین را خوانده و پذیرفته‌اید و می‌دانید Premium یک مزیت مشروط به رعایت شرایط است، نه یک حق مطلق.',
  'قوانین کامل عضویت Premium — شرایط، مزایا، محدودیت‌ها و پذیرش',
  'ACTIVE',
  NOW(),
  'system'
  )
ON CONFLICT (version) DO NOTHING;

-- Ensure exactly one ACTIVE version
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM membership_rules WHERE status = 'ACTIVE') THEN
    UPDATE membership_rules
    SET status = 'ACTIVE', effective_at = NOW()
    WHERE version = (SELECT MAX(version) FROM membership_rules);
  END IF;
END $$;
