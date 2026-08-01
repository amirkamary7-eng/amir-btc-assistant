-- ═══════════════════════════════════════════════════════════════════════════
-- AMIRBTC Membership Module — Database Schema Migration (Neon / PostgreSQL)
-- ═══════════════════════════════════════════════════════════════════════════
-- Run this against the Neon database (DATABASE_URL).
-- Idempotent: safe to run multiple times (uses IF NOT EXISTS / CREATE TYPE).
-- ═══════════════════════════════════════════════════════════════════════════

-- ─── Enums ──────────────────────────────────────────────────────────────────
DO $$ BEGIN
  CREATE TYPE membership_level AS ENUM ('FREE', 'VIP', 'PREMIUM', 'ELITE');
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
  CREATE TYPE membership_status AS ENUM ('INACTIVE', 'PENDING', 'APPROVED', 'REJECTED', 'SUSPENDED', 'EXPIRED');
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
  CREATE TYPE membership_source AS ENUM ('MANUAL', 'EXCHANGE', 'GIVEAWAY', 'SUBSCRIPTION', 'PARTNER');
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
  CREATE TYPE membership_request_status AS ENUM ('PENDING', 'APPROVED', 'REJECTED');
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
  CREATE TYPE exchange_verification_status AS ENUM ('NONE', 'PENDING', 'VERIFIED', 'FAILED', 'EXPIRED');
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

-- ─── Table: membership_users ────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS membership_users (
  id              TEXT PRIMARY KEY DEFAULT gen_random_uuid()::text,
  telegram_id     TEXT NOT NULL UNIQUE,
  username        TEXT,
  first_name      TEXT,
  last_name       TEXT,
  membership_level     membership_level NOT NULL DEFAULT 'FREE',
  membership_status    membership_status NOT NULL DEFAULT 'INACTIVE',
  membership_source    membership_source NOT NULL DEFAULT 'MANUAL',
  approved_by     TEXT,
  approved_at     TIMESTAMPTZ,
  expire_at       TIMESTAMPTZ,
  -- Phase 3 extension fields
  premium_badge_enabled BOOLEAN NOT NULL DEFAULT TRUE,
  referral_code        TEXT,
  referral_verified_at TIMESTAMPTZ,
  profile_meta         TEXT,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_mu_status   ON membership_users (membership_status);
CREATE INDEX IF NOT EXISTS idx_mu_level    ON membership_users (membership_level);
CREATE INDEX IF NOT EXISTS idx_mu_source   ON membership_users (membership_source);
CREATE INDEX IF NOT EXISTS idx_mu_tgid     ON membership_users (telegram_id);
CREATE INDEX IF NOT EXISTS idx_mu_refcode  ON membership_users (referral_code);

-- ─── Table: membership_requests ────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS membership_requests (
  id              TEXT PRIMARY KEY DEFAULT gen_random_uuid()::text,
  telegram_id     TEXT NOT NULL,
  exchange_name   TEXT NOT NULL,
  exchange_uid    TEXT NOT NULL,
  status          membership_request_status NOT NULL DEFAULT 'PENDING',
  note            TEXT,
  admin_note      TEXT,
  submitted_at    TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  reviewed_at     TIMESTAMPTZ,
  reviewed_by     TEXT,
  -- Phase 3 extension fields
  campaign_id           TEXT,
  verification_status   exchange_verification_status NOT NULL DEFAULT 'NONE',
  verification_data     TEXT,
  verified_at           TIMESTAMPTZ,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_mr_tgid     ON membership_requests (telegram_id);
CREATE INDEX IF NOT EXISTS idx_mr_uid      ON membership_requests (exchange_uid);
CREATE INDEX IF NOT EXISTS idx_mr_status   ON membership_requests (status);
CREATE INDEX IF NOT EXISTS idx_mr_submitted ON membership_requests (submitted_at);
CREATE INDEX IF NOT EXISTS idx_mr_campaign  ON membership_requests (campaign_id);
CREATE INDEX IF NOT EXISTS idx_mr_vstatus   ON membership_requests (verification_status);

-- ─── Table: membership_audit_logs ──────────────────────────────────────────
CREATE TABLE IF NOT EXISTS membership_audit_logs (
  id              TEXT PRIMARY KEY DEFAULT gen_random_uuid()::text,
  admin_id        TEXT NOT NULL,
  admin_username  TEXT,
  target_telegram_id TEXT,
  request_id      TEXT,
  action          TEXT NOT NULL,
  level_before    TEXT,
  level_after     TEXT,
  status_before   TEXT,
  status_after    TEXT,
  detail          TEXT,
  ip              TEXT,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_mal_admin   ON membership_audit_logs (admin_id);
CREATE INDEX IF NOT EXISTS idx_mal_target  ON membership_audit_logs (target_telegram_id);
CREATE INDEX IF NOT EXISTS idx_mal_action  ON membership_audit_logs (action);
CREATE INDEX IF NOT EXISTS idx_mal_created ON membership_audit_logs (created_at);

-- ─── Table: membership_admins ──────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS membership_admins (
  id          TEXT PRIMARY KEY DEFAULT gen_random_uuid()::text,
  telegram_id TEXT NOT NULL UNIQUE,
  username    TEXT,
  first_name  TEXT,
  last_name   TEXT,
  role        TEXT NOT NULL DEFAULT 'ADMIN',
  active      BOOLEAN NOT NULL DEFAULT TRUE,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_ma_tgid ON membership_admins (telegram_id);
CREATE INDEX IF NOT EXISTS idx_ma_role ON membership_admins (role);

-- ─── Table: exchange_campaigns (Phase 3) ────────────────────────────────────
CREATE TABLE IF NOT EXISTS exchange_campaigns (
  id              TEXT PRIMARY KEY DEFAULT gen_random_uuid()::text,
  name            TEXT NOT NULL,
  exchange_name   TEXT NOT NULL,
  required_volume DOUBLE PRECISION NOT NULL DEFAULT 0,
  reward_level    membership_level NOT NULL DEFAULT 'VIP',
  lifetime        BOOLEAN NOT NULL DEFAULT TRUE,
  starts_at       TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  ends_at         TIMESTAMPTZ,
  active          BOOLEAN NOT NULL DEFAULT TRUE,
  referral_code   TEXT,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_ec_exchange ON exchange_campaigns (exchange_name);
CREATE INDEX IF NOT EXISTS idx_ec_active    ON exchange_campaigns (active);
CREATE INDEX IF NOT EXISTS idx_ec_refcode   ON exchange_campaigns (referral_code);

-- ─── updated_at trigger ────────────────────────────────────────────────────
CREATE OR REPLACE FUNCTION membership_set_updated_at()
RETURNS TRIGGER AS $$
BEGIN
  NEW.updated_at = NOW();
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS trg_mu_updated ON membership_users;
CREATE TRIGGER trg_mu_updated BEFORE UPDATE ON membership_users
  FOR EACH ROW EXECUTE FUNCTION membership_set_updated_at();

DROP TRIGGER IF EXISTS trg_mr_updated ON membership_requests;
CREATE TRIGGER trg_mr_updated BEFORE UPDATE ON membership_requests
  FOR EACH ROW EXECUTE FUNCTION membership_set_updated_at();

DROP TRIGGER IF EXISTS trg_ma_updated ON membership_admins;
CREATE TRIGGER trg_ma_updated BEFORE UPDATE ON membership_admins
  FOR EACH ROW EXECUTE FUNCTION membership_set_updated_at();

DROP TRIGGER IF EXISTS trg_ec_updated ON exchange_campaigns;
CREATE TRIGGER trg_ec_updated BEFORE UPDATE ON exchange_campaigns
  FOR EACH ROW EXECUTE FUNCTION membership_set_updated_at();

-- ═══════════════════════════════════════════════════════════════════════════
-- Seed: ensure the default admin (from ADMIN_TELEGRAM_ID) is present.
-- Run AFTER setting ADMIN_TELEGRAM_ID env var, OR manually insert your admin.
-- ═══════════════════════════════════════════════════════════════════════════
-- INSERT INTO membership_admins (telegram_id, username, role, active)
-- VALUES ('900000001', 'amir_admin', 'SUPER_ADMIN', TRUE)
-- ON CONFLICT (telegram_id) DO NOTHING;
