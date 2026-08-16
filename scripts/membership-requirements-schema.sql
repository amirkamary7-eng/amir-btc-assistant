-- ═══════════════════════════════════════════════════════════════════════════
-- PHASE 2 — Membership Requirements + Exchange Decoupling
-- ═══════════════════════════════════════════════════════════════════════════
-- Adds the membership_requirements table — a data-driven, versioned exchange
-- requirement system. Replaces the hard-coded SUPPORTED_EXCHANGES array and
-- the hard-coded "Bitunix" literal in the frontend.
--
-- SAFETY:
--   • 100% idempotent (IF NOT EXISTS / ON CONFLICT DO NOTHING)
--   • No DROP, no TRUNCATE, no DELETE of existing data
--   • No FK constraints that break existing rows (columns nullable)
--   • Seeds Bitunix as the ACTIVE requirement — zero behavior change
--   • Rollback: DROP TABLE membership_requirements;
--     ALTER TABLE membership_users DROP COLUMN IF EXISTS current_requirement_id;
--     ALTER TABLE membership_audit_logs DROP COLUMN IF EXISTS requirement_id;
-- ═══════════════════════════════════════════════════════════════════════════

CREATE TABLE IF NOT EXISTS membership_requirements (
  id                      TEXT PRIMARY KEY DEFAULT gen_random_uuid()::text,
  version                 INTEGER NOT NULL UNIQUE,
  label                   TEXT NOT NULL,
  exchange_name           TEXT NOT NULL,
  exchange_register_url   TEXT NOT NULL,
  uid_label               TEXT NOT NULL,
  referral_code           TEXT,
  requires_first_trade    BOOLEAN NOT NULL DEFAULT FALSE,
  required_volume         DOUBLE PRECISION NOT NULL DEFAULT 0,
  reward_level            TEXT NOT NULL DEFAULT 'PREMIUM'
                            CHECK (reward_level IN ('FREE', 'VIP', 'PREMIUM', 'ELITE')),
  grace_period_days       INTEGER NOT NULL DEFAULT 14,
  status                  TEXT NOT NULL DEFAULT 'DRAFT'
                            CHECK (status IN ('DRAFT', 'ACTIVE', 'ARCHIVED')),
  effective_at            TIMESTAMPTZ,
  expires_at              TIMESTAMPTZ,
  metadata                JSONB DEFAULT '{}'::jsonb,
  created_at              TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at              TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE UNIQUE INDEX IF NOT EXISTS uq_membership_req_active
  ON membership_requirements (status)
  WHERE status = 'ACTIVE';

CREATE INDEX IF NOT EXISTS idx_membership_req_status
  ON membership_requirements (status);

CREATE INDEX IF NOT EXISTS idx_membership_req_exchange
  ON membership_requirements (exchange_name);

CREATE INDEX IF NOT EXISTS idx_membership_req_version
  ON membership_requirements (version);

-- ─── Column: membership_users.current_requirement_id ───────────────────────
DO $$ BEGIN
  ALTER TABLE membership_users ADD COLUMN IF NOT EXISTS current_requirement_id TEXT;
EXCEPTION WHEN duplicate_column THEN NULL; END $$;

CREATE INDEX IF NOT EXISTS idx_mu_current_req
  ON membership_users (current_requirement_id)
  WHERE current_requirement_id IS NOT NULL;

-- ─── Column: membership_audit_logs.requirement_id ──────────────────────────
DO $$ BEGIN
  ALTER TABLE membership_audit_logs ADD COLUMN IF NOT EXISTS requirement_id TEXT;
EXCEPTION WHEN duplicate_column THEN NULL; END $$;

CREATE INDEX IF NOT EXISTS idx_mal_requirement
  ON membership_audit_logs (requirement_id)
  WHERE requirement_id IS NOT NULL;

-- ─── updated_at trigger ────────────────────────────────────────────────────
CREATE OR REPLACE FUNCTION membership_requirements_set_updated_at()
RETURNS TRIGGER AS $$
BEGIN
  NEW.updated_at = NOW();
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS trg_mreq_updated ON membership_requirements;
CREATE TRIGGER trg_mreq_updated BEFORE UPDATE ON membership_requirements
  FOR EACH ROW EXECUTE FUNCTION membership_requirements_set_updated_at();

-- ═══════════════════════════════════════════════════════════════════════════
-- SEED: Bitunix Requirement v1 (ACTIVE) — matches EXACT current behavior
-- ═══════════════════════════════════════════════════════════════════════════
INSERT INTO membership_requirements (
  version, label, exchange_name, exchange_register_url, uid_label,
  referral_code, requires_first_trade, required_volume, reward_level,
  grace_period_days, status, effective_at, metadata
)
VALUES (
  1,
  'Bitunix + First Trade',
  'Bitunix',
  'https://www.bitunix.com/register?vipCode=AMIRBTC',
  'شناسه کاربری Bitunix خود را وارد کنید',
  'AMIRBTC',
  TRUE,
  0,
  'PREMIUM',
  14,
  'ACTIVE',
  NOW(),
  '{"timeline_step_1":"ثبت‌نام از طریق لینک رسمی Bitunix","timeline_step_3":"واریز اولیه به حساب صرافی","timeline_step_4":"انجام اولین معامله (First Trade)","button_text":"ثبت‌نام در Bitunix"}'::jsonb
)
ON CONFLICT (version) DO NOTHING;

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM membership_requirements WHERE status = 'ACTIVE') THEN
    UPDATE membership_requirements
    SET status = 'ACTIVE', effective_at = NOW()
    WHERE version = (SELECT MAX(version) FROM membership_requirements);
  END IF;
END $$;
