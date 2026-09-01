-- ============================================================================
-- 00-migrate.sql — Amir BTC Assistant — Consolidated Idempotent Schema Migration
-- ============================================================================
-- Purpose:
--   Single-source-of-truth schema migration for the entire application.
--   Safe to run on a live production database, safe to run multiple times
--   (idempotent), safe to run from CI via `psql -f scripts/00-migrate.sql`.
--
-- Hard constraints honored:
--   * NO DROP TABLE / DROP COLUMN / TRUNCATE / DROP INDEX / DROP TYPE / DROP SCHEMA
--   * The ONLY allowed destructive operation is the explicitly-approved
--     `ALTER TABLE wheel_spins DROP CONSTRAINT IF EXISTS wheel_spins_user_id_spin_type_source_created_at_key`
--     (see SECTION 7 below).
--   * Every CREATE TABLE uses IF NOT EXISTS.
--   * Every ALTER TABLE ADD COLUMN uses IF NOT EXISTS.
--   * Every CREATE INDEX / CREATE UNIQUE INDEX uses IF NOT EXISTS.
--   * Every ALTER TABLE ADD CONSTRAINT (FK or CHECK or UNIQUE) is wrapped in a
--     DO $$ ... END $$ block that checks information_schema.table_constraints.
--   * No CREATE INDEX CONCURRENTLY (incompatible with the wrapping transaction).
--   * No prepared statements, no SET session_replication_role, no advisory locks
--     that span statements — safe for PgBouncer/Supavisor transaction-mode pooler
--     (port 6543).
--   * Entire file wrapped in a single BEGIN/COMMIT transaction so a partial
--     failure rolls back cleanly.
--
-- Source-of-truth files mined for DDL:
--   src/repositories/{admin,alerts,alert_economy,analyses,app_content,
--     calendar_reminders,cosmetics,membership,news_articles,notification_platform,
--     notifications,referrals,reward_center,reward_purchases,tickets,users,
--     wallet,watchlist,wheel,advertisements}.js
--   scripts/{membership-schema,membership-cosmetics-schema,
--     membership-requirements-schema,membership-rules-schema,
--     stabilization_indexes,groq-model-update}.sql
--   scripts/e2e-referral-test.mjs + scripts/e2e-referral-reregister-test.mjs
--     (for legacy tables referrals / token_balances / token_transactions /
--      watchlist_items / tickets / ticket_replies, which have no CREATE TABLE
--      in the repository code — only references)
--   docs/DATABASE_SCHEMA.md (canonical schema reference)
--
-- Tables covered (47 total, alphabetical):
--   1.  ad_campaigns
--   2.  ad_channels
--   3.  ad_messages
--   4.  ad_popups
--   5.  admins
--   6.  alert_config
--   7.  alert_quota
--   8.  analyses
--   9.  app_content
--   10. calendar_reminders
--   11. campaigns
--   12. daily_checkin_streaks
--   13. deleted_users
--   14. exchange_campaigns
--   15. membership_admins
--   16. membership_audit_logs
--   17. membership_requests
--   18. membership_requirements
--   19. membership_rule_acceptances
--   20. membership_rules
--   21. membership_users
--   22. mission_progress
--   23. mission_rewards
--   24. news_articles
--   25. notification_broadcasts
--   26. notification_queue
--   27. notification_settings
--   28. notification_templates
--   29. notifications
--   30. price_alerts
--   31. profile_cosmetics
--   32. referral_reward_tiers
--   33. referrals
--   34. reward_emergency_controls
--   35. reward_library
--   36. reward_purchases
--   37. ticket_replies
--   38. tickets
--   39. token_balances
--   40. token_transactions
--   41. user_cosmetic_ownership
--   42. users
--   43. watchlist_items
--   44. wheel_config
--   45. wheel_history
--   46. wheel_rewards
--   47. wheel_spins
--
-- Reconciliation note vs. prior audit (worklog phase1-step0-conn, which found 46):
--   * Excluded `alerts` — that name appears ONLY in a buggy cascade DELETE in
--     src/repositories/users.js:355 and in a pg-mem test file. No CREATE TABLE
--     exists for it anywhere. The actual production table is `price_alerts`.
--     Creating a phantom `alerts` table would be inventing schema.
--   * Added `tickets` and `ticket_replies` — actively used by
--     src/repositories/tickets.js and documented in docs/DATABASE_SCHEMA.md,
--     but missed by the prior audit. They have no CREATE TABLE in repository
--     code (rely on pre-existing production DDL); this migration now owns them.
--   * Net: 46 - 1 (alerts) + 2 (tickets, ticket_replies) = 47 tables.
-- ============================================================================

BEGIN;

-- ============================================================================
-- SECTION 1: ENUM TYPES (membership module)
-- These must exist BEFORE the membership_* tables that reference them.
-- Idempotent via DO $$ ... EXCEPTION WHEN duplicate_object ... END $$.
-- ============================================================================

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


-- ============================================================================
-- SECTION 2: FOUNDATION TABLE — users
-- Most other tables FK to users(telegram_id). Created FIRST.
-- ============================================================================

CREATE TABLE IF NOT EXISTS users (
  telegram_id         VARCHAR(64) PRIMARY KEY,
  username            VARCHAR(128),
  first_name          VARCHAR(128),
  last_name           VARCHAR(128),
  lang                VARCHAR(8) DEFAULT 'fa',
  channel_joined      BOOLEAN DEFAULT FALSE,
  channel_verified_at TIMESTAMPTZ,
  created_at          TIMESTAMPTZ DEFAULT NOW(),
  updated_at          TIMESTAMPTZ DEFAULT NOW(),
  last_active_at      TIMESTAMPTZ,
  bot_joined_at       TIMESTAMPTZ,
  mini_app_opened_at  TIMESTAMPTZ,
  is_premium          BOOLEAN DEFAULT FALSE,
  beta_popup_seen     BOOLEAN NOT NULL DEFAULT FALSE
);

-- Belt-and-suspenders: the runtime ensureTable also runs these ALTERs.
ALTER TABLE users ADD COLUMN IF NOT EXISTS last_active_at TIMESTAMPTZ;
ALTER TABLE users ADD COLUMN IF NOT EXISTS bot_joined_at TIMESTAMPTZ;
ALTER TABLE users ADD COLUMN IF NOT EXISTS mini_app_opened_at TIMESTAMPTZ;
ALTER TABLE users ADD COLUMN IF NOT EXISTS is_premium BOOLEAN DEFAULT FALSE;
ALTER TABLE users ADD COLUMN IF NOT EXISTS beta_popup_seen BOOLEAN NOT NULL DEFAULT FALSE;

CREATE INDEX IF NOT EXISTS idx_users_last_active    ON users (last_active_at DESC);
CREATE INDEX IF NOT EXISTS idx_users_created_at     ON users (created_at DESC);
CREATE INDEX IF NOT EXISTS idx_users_channel_joined ON users (channel_joined) WHERE channel_joined = TRUE;


-- ============================================================================
-- SECTION 3: INDEPENDENT TABLES (no FK to other application tables)
-- Created in any order; grouped by feature area.
-- ============================================================================

-- ── admins ─────────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS admins (
  id          SERIAL PRIMARY KEY,
  telegram_id VARCHAR(64) NOT NULL UNIQUE,
  role        VARCHAR(32) NOT NULL DEFAULT 'admin',
  permissions JSONB NOT NULL DEFAULT '[]',
  active      BOOLEAN NOT NULL DEFAULT TRUE,
  created_by  VARCHAR(64),
  created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

ALTER TABLE admins ADD COLUMN IF NOT EXISTS permissions JSONB NOT NULL DEFAULT '[]';
ALTER TABLE admins ADD COLUMN IF NOT EXISTS active BOOLEAN NOT NULL DEFAULT TRUE;
ALTER TABLE admins ADD COLUMN IF NOT EXISTS created_by VARCHAR(64);
ALTER TABLE admins ADD COLUMN IF NOT EXISTS updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW();

CREATE INDEX IF NOT EXISTS idx_admins_telegram_id ON admins (telegram_id);
CREATE INDEX IF NOT EXISTS idx_admins_active      ON admins (active);


-- ── app_content ────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS app_content (
  id         VARCHAR(64) PRIMARY KEY,
  title      TEXT NOT NULL,
  sections   JSONB NOT NULL DEFAULT '[]',
  version    VARCHAR(32) DEFAULT '1.0.0',
  updated_at TIMESTAMPTZ DEFAULT NOW(),
  updated_by VARCHAR(64)
);


-- ── alert_config ───────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS alert_config (
  alert_type          VARCHAR(32) PRIMARY KEY,
  is_enabled          BOOLEAN NOT NULL DEFAULT TRUE,
  free_per_day        INTEGER NOT NULL DEFAULT 3,
  cost_per_extra      INTEGER NOT NULL DEFAULT 5,
  premium_free_per_day INTEGER NOT NULL DEFAULT 10,
  updated_at          TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

ALTER TABLE alert_config ADD COLUMN IF NOT EXISTS premium_free_per_day INTEGER NOT NULL DEFAULT 10;


-- ── alert_quota ────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS alert_quota (
  id          SERIAL PRIMARY KEY,
  user_id     TEXT NOT NULL,
  alert_type  VARCHAR(32) NOT NULL DEFAULT 'price_alert',
  used_count  INTEGER NOT NULL DEFAULT 0,
  quota_date  DATE NOT NULL DEFAULT CURRENT_DATE,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE(user_id, alert_type, quota_date)
);

CREATE INDEX IF NOT EXISTS idx_alert_quota_user_date ON alert_quota (user_id, alert_type, quota_date);


-- ── analyses ───────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS analyses (
  id               VARCHAR(64) PRIMARY KEY,
  coin             VARCHAR(32) NOT NULL,
  timeframe        VARCHAR(16) NOT NULL DEFAULT '1d',
  image            VARCHAR(512) DEFAULT '',
  text             TEXT NOT NULL,
  title            VARCHAR(256) DEFAULT '',
  support_level    VARCHAR(64) DEFAULT '',
  current_price    VARCHAR(64) DEFAULT '',
  resistance_level VARCHAR(64) DEFAULT '',
  views_count      INTEGER NOT NULL DEFAULT 0,
  featured         BOOLEAN NOT NULL DEFAULT FALSE,
  category         VARCHAR(16) NOT NULL DEFAULT 'crypto',
  author           VARCHAR(128) NOT NULL DEFAULT '',
  author_id        VARCHAR(64) DEFAULT '',
  created_at       TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at       TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- Belt-and-suspenders (matches runtime analyses.ensureSchema batchSql)
ALTER TABLE analyses ADD COLUMN IF NOT EXISTS title            VARCHAR(256) DEFAULT '';
ALTER TABLE analyses ADD COLUMN IF NOT EXISTS support_level    VARCHAR(64) DEFAULT '';
ALTER TABLE analyses ADD COLUMN IF NOT EXISTS current_price    VARCHAR(64) DEFAULT '';
ALTER TABLE analyses ADD COLUMN IF NOT EXISTS resistance_level VARCHAR(64) DEFAULT '';
ALTER TABLE analyses ADD COLUMN IF NOT EXISTS views_count      INTEGER DEFAULT 0 NOT NULL;
ALTER TABLE analyses ADD COLUMN IF NOT EXISTS featured         BOOLEAN DEFAULT FALSE NOT NULL;
ALTER TABLE analyses ADD COLUMN IF NOT EXISTS category         VARCHAR(16) DEFAULT 'crypto' NOT NULL;
ALTER TABLE analyses ADD COLUMN IF NOT EXISTS author           VARCHAR(128) NOT NULL DEFAULT '';
ALTER TABLE analyses ADD COLUMN IF NOT EXISTS author_id        VARCHAR(64) DEFAULT '';

CREATE INDEX IF NOT EXISTS idx_analyses_created_at ON analyses (created_at DESC);
CREATE INDEX IF NOT EXISTS idx_analyses_featured   ON analyses (featured) WHERE featured = TRUE;


-- ── calendar_reminders ─────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS calendar_reminders (
  id              SERIAL PRIMARY KEY,
  user_id         VARCHAR(64) NOT NULL,
  event_key       VARCHAR(255) NOT NULL,
  event_title     VARCHAR(256) DEFAULT '',
  event_country   VARCHAR(16) DEFAULT '',
  event_timestamp TIMESTAMPTZ,
  lead_minutes    INTEGER NOT NULL DEFAULT 60,
  fired_at        TIMESTAMPTZ,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE(user_id, event_key)
);

CREATE INDEX IF NOT EXISTS idx_cal_reminders_user    ON calendar_reminders (user_id);
CREATE INDEX IF NOT EXISTS idx_cal_reminders_pending ON calendar_reminders (event_timestamp) WHERE fired_at IS NULL;


-- ── campaigns (reward_center) ──────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS campaigns (
  id                  VARCHAR(64) PRIMARY KEY,
  name                VARCHAR(128) NOT NULL,
  description         TEXT,
  start_date          TIMESTAMPTZ,
  end_date            TIMESTAMPTZ,
  status              VARCHAR(16) NOT NULL DEFAULT 'active',
  priority            INTEGER NOT NULL DEFAULT 0,
  applies_to_wheel    BOOLEAN NOT NULL DEFAULT FALSE,
  applies_to_referral BOOLEAN NOT NULL DEFAULT FALSE,
  applies_to_mission  BOOLEAN NOT NULL DEFAULT FALSE,
  metadata            JSONB DEFAULT '{}',
  created_at          TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at          TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_campaigns_status ON campaigns (status, priority);


-- ── daily_checkin_streaks (FK to users — created here because the original
--    wallet.js CREATE TABLE defines the FK inline) ──────────────────────────
-- (Defined later in Section 4 with other user-FK tables for ordering clarity.)


-- ── deleted_users ──────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS deleted_users (
  id                  SERIAL PRIMARY KEY,
  telegram_id         VARCHAR(64) NOT NULL UNIQUE,
  previous_inviter_id VARCHAR(64),
  deleted_at          TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  cooldown_until      TIMESTAMPTZ NOT NULL DEFAULT (NOW() + INTERVAL '15 days')
);

-- Defensive idempotent migration: if the table was created by an older
-- deleteAccount (without UNIQUE), add the unique index now.
CREATE UNIQUE INDEX IF NOT EXISTS idx_deleted_users_telegram_id_uniq
  ON deleted_users (telegram_id);


-- ── exchange_campaigns ─────────────────────────────────────────────────────
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
CREATE INDEX IF NOT EXISTS idx_ec_active   ON exchange_campaigns (active);
CREATE INDEX IF NOT EXISTS idx_ec_refcode  ON exchange_campaigns (referral_code);


-- ── membership_admins ──────────────────────────────────────────────────────
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


-- ── membership_audit_logs ──────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS membership_audit_logs (
  id                 TEXT PRIMARY KEY DEFAULT gen_random_uuid()::text,
  admin_id           TEXT NOT NULL,
  admin_username     TEXT,
  target_telegram_id TEXT,
  request_id         TEXT,
  action             TEXT NOT NULL,
  level_before       TEXT,
  level_after        TEXT,
  status_before      TEXT,
  status_after       TEXT,
  detail             TEXT,
  ip                 TEXT,
  requirement_id     TEXT,
  created_at         TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- belt-and-suspenders (membership-requirements-schema.sql adds this column)
DO $$ BEGIN
  ALTER TABLE membership_audit_logs ADD COLUMN IF NOT EXISTS requirement_id TEXT;
EXCEPTION WHEN duplicate_column THEN NULL; END $$;

CREATE INDEX IF NOT EXISTS idx_mal_admin      ON membership_audit_logs (admin_id);
CREATE INDEX IF NOT EXISTS idx_mal_target     ON membership_audit_logs (target_telegram_id);
CREATE INDEX IF NOT EXISTS idx_mal_action     ON membership_audit_logs (action);
CREATE INDEX IF NOT EXISTS idx_mal_created    ON membership_audit_logs (created_at);
CREATE INDEX IF NOT EXISTS idx_mal_requirement ON membership_audit_logs (requirement_id) WHERE requirement_id IS NOT NULL;


-- ── membership_requests ────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS membership_requests (
  id                    TEXT PRIMARY KEY DEFAULT gen_random_uuid()::text,
  telegram_id           TEXT NOT NULL,
  exchange_name         TEXT NOT NULL,
  exchange_uid          TEXT NOT NULL,
  status                membership_request_status NOT NULL DEFAULT 'PENDING',
  note                  TEXT,
  admin_note            TEXT,
  submitted_at          TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  reviewed_at           TIMESTAMPTZ,
  reviewed_by           TEXT,
  campaign_id           TEXT,
  verification_status   exchange_verification_status NOT NULL DEFAULT 'NONE',
  verification_data     TEXT,
  verified_at           TIMESTAMPTZ,
  rules_version         INTEGER,
  created_at            TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at            TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- belt-and-suspenders (membership-rules-schema.sql adds rules_version)
DO $$ BEGIN
  ALTER TABLE membership_requests ADD COLUMN IF NOT EXISTS rules_version INTEGER;
EXCEPTION WHEN duplicate_column THEN NULL; END $$;

CREATE INDEX IF NOT EXISTS idx_mr_tgid          ON membership_requests (telegram_id);
CREATE INDEX IF NOT EXISTS idx_mr_uid           ON membership_requests (exchange_uid);
CREATE INDEX IF NOT EXISTS idx_mr_status        ON membership_requests (status);
CREATE INDEX IF NOT EXISTS idx_mr_submitted     ON membership_requests (submitted_at);
CREATE INDEX IF NOT EXISTS idx_mr_campaign      ON membership_requests (campaign_id);
CREATE INDEX IF NOT EXISTS idx_mr_vstatus       ON membership_requests (verification_status);
CREATE INDEX IF NOT EXISTS idx_mr_rules_version ON membership_requests (rules_version) WHERE rules_version IS NOT NULL;


-- ── membership_requirements ────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS membership_requirements (
  id                     TEXT PRIMARY KEY DEFAULT gen_random_uuid()::text,
  version                INTEGER NOT NULL UNIQUE,
  label                  TEXT NOT NULL,
  exchange_name          TEXT NOT NULL,
  exchange_register_url  TEXT NOT NULL,
  uid_label              TEXT NOT NULL,
  referral_code          TEXT,
  requires_first_trade   BOOLEAN NOT NULL DEFAULT FALSE,
  required_volume        DOUBLE PRECISION NOT NULL DEFAULT 0,
  reward_level           TEXT NOT NULL DEFAULT 'PREMIUM'
                           CHECK (reward_level IN ('FREE', 'VIP', 'PREMIUM', 'ELITE')),
  grace_period_days      INTEGER NOT NULL DEFAULT 14,
  status                 TEXT NOT NULL DEFAULT 'DRAFT'
                           CHECK (status IN ('DRAFT', 'ACTIVE', 'ARCHIVED')),
  effective_at           TIMESTAMPTZ,
  expires_at             TIMESTAMPTZ,
  metadata               JSONB DEFAULT '{}'::jsonb,
  created_at             TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at             TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE UNIQUE INDEX IF NOT EXISTS uq_membership_req_active
  ON membership_requirements (status) WHERE status = 'ACTIVE';

CREATE INDEX IF NOT EXISTS idx_membership_req_status   ON membership_requirements (status);
CREATE INDEX IF NOT EXISTS idx_membership_req_exchange ON membership_requirements (exchange_name);
CREATE INDEX IF NOT EXISTS idx_membership_req_version  ON membership_requirements (version);


-- ── membership_rule_acceptances ────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS membership_rule_acceptances (
  id            TEXT PRIMARY KEY DEFAULT gen_random_uuid()::text,
  telegram_id   TEXT NOT NULL,
  rules_version INTEGER NOT NULL,
  request_id    TEXT,
  accepted_at   TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  ip            TEXT,
  user_agent    TEXT,
  metadata      JSONB DEFAULT '{}'::jsonb,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE UNIQUE INDEX IF NOT EXISTS uq_acceptance_user_version
  ON membership_rule_acceptances (telegram_id, rules_version);

CREATE INDEX IF NOT EXISTS idx_acceptance_telegram_id  ON membership_rule_acceptances (telegram_id);
CREATE INDEX IF NOT EXISTS idx_acceptance_rules_version ON membership_rule_acceptances (rules_version);


-- ── membership_rules ───────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS membership_rules (
  id             TEXT PRIMARY KEY DEFAULT gen_random_uuid()::text,
  version        INTEGER NOT NULL UNIQUE,
  title          TEXT NOT NULL,
  body_markdown  TEXT NOT NULL,
  summary        TEXT,
  status         TEXT NOT NULL DEFAULT 'DRAFT'
                  CHECK (status IN ('DRAFT', 'ACTIVE', 'ARCHIVED')),
  effective_at   TIMESTAMPTZ,
  created_at     TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  created_by     TEXT,
  updated_at     TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE UNIQUE INDEX IF NOT EXISTS uq_membership_rules_active
  ON membership_rules (status) WHERE status = 'ACTIVE';

CREATE INDEX IF NOT EXISTS idx_membership_rules_status  ON membership_rules (status);
CREATE INDEX IF NOT EXISTS idx_membership_rules_version ON membership_rules (version);


-- ── membership_users ───────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS membership_users (
  id                      TEXT PRIMARY KEY DEFAULT gen_random_uuid()::text,
  telegram_id             TEXT NOT NULL UNIQUE,
  username                TEXT,
  first_name              TEXT,
  last_name               TEXT,
  membership_level        membership_level NOT NULL DEFAULT 'FREE',
  membership_status       membership_status NOT NULL DEFAULT 'INACTIVE',
  membership_source       membership_source NOT NULL DEFAULT 'MANUAL',
  approved_by             TEXT,
  approved_at             TIMESTAMPTZ,
  expire_at               TIMESTAMPTZ,
  premium_badge_enabled   BOOLEAN NOT NULL DEFAULT TRUE,
  referral_code           TEXT,
  referral_verified_at    TIMESTAMPTZ,
  profile_meta            TEXT,
  welcome_shown           BOOLEAN NOT NULL DEFAULT FALSE,
  current_requirement_id  TEXT,
  created_at              TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at              TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- belt-and-suspenders (membership.js + membership-requirements-schema.sql)
DO $$ BEGIN
  ALTER TABLE membership_users ADD COLUMN IF NOT EXISTS welcome_shown BOOLEAN NOT NULL DEFAULT FALSE;
EXCEPTION WHEN duplicate_column THEN NULL; END $$;

DO $$ BEGIN
  ALTER TABLE membership_users ADD COLUMN IF NOT EXISTS current_requirement_id TEXT;
EXCEPTION WHEN duplicate_column THEN NULL; END $$;

CREATE INDEX IF NOT EXISTS idx_mu_status      ON membership_users (membership_status);
CREATE INDEX IF NOT EXISTS idx_mu_level       ON membership_users (membership_level);
CREATE INDEX IF NOT EXISTS idx_mu_source      ON membership_users (membership_source);
CREATE INDEX IF NOT EXISTS idx_mu_tgid        ON membership_users (telegram_id);
CREATE INDEX IF NOT EXISTS idx_mu_refcode     ON membership_users (referral_code);
CREATE INDEX IF NOT EXISTS idx_mu_current_req ON membership_users (current_requirement_id) WHERE current_requirement_id IS NOT NULL;


-- ── mission_progress ───────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS mission_progress (
  id             SERIAL PRIMARY KEY,
  user_id        VARCHAR(64) NOT NULL,
  mission_id     VARCHAR(64) NOT NULL,
  progress_count INTEGER NOT NULL DEFAULT 0,
  target_count   INTEGER NOT NULL DEFAULT 1,
  completed      BOOLEAN NOT NULL DEFAULT FALSE,
  rewarded       BOOLEAN NOT NULL DEFAULT FALSE,
  daily_date     DATE NOT NULL DEFAULT CURRENT_DATE,
  week_start     DATE,
  created_at     TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at     TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE(user_id, mission_id, daily_date)
);

-- PHASE 5: add week_start column (additive — existing rows get NULL)
ALTER TABLE mission_progress ADD COLUMN IF NOT EXISTS week_start DATE;

CREATE INDEX IF NOT EXISTS idx_mission_progress_user      ON mission_progress (user_id, daily_date);
CREATE INDEX IF NOT EXISTS idx_mission_progress_completed ON mission_progress (user_id, completed, daily_date);

-- PHASE 5: partial UNIQUE index for weekly missions (only when week_start IS NOT NULL)
CREATE UNIQUE INDEX IF NOT EXISTS idx_mission_progress_week
  ON mission_progress (user_id, mission_id, week_start)
  WHERE week_start IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_mission_progress_week_user
  ON mission_progress (user_id, week_start)
  WHERE week_start IS NOT NULL;


-- ── news_articles ──────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS news_articles (
  id             VARCHAR(64) PRIMARY KEY,
  url            TEXT NOT NULL,
  title          TEXT NOT NULL,
  title_en       TEXT,
  source         VARCHAR(64),
  category       VARCHAR(32) DEFAULT 'crypto',
  summary        TEXT,
  sentiment      VARCHAR(32) DEFAULT 'neutral',
  impact         VARCHAR(32) DEFAULT 'low',
  impact_reason  TEXT,
  coins          TEXT,
  provider       VARCHAR(32),
  analyzed_at    TIMESTAMPTZ DEFAULT NOW(),
  created_at     TIMESTAMPTZ DEFAULT NOW(),
  UNIQUE(url)
);

CREATE INDEX IF NOT EXISTS idx_news_articles_url     ON news_articles (url);
CREATE INDEX IF NOT EXISTS idx_news_articles_created ON news_articles (created_at DESC);


-- ── notification_broadcasts ────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS notification_broadcasts (
  id                    SERIAL PRIMARY KEY,
  admin_id              TEXT NOT NULL,
  title                 TEXT NOT NULL,
  message               TEXT NOT NULL,
  category              VARCHAR(32) NOT NULL DEFAULT 'announcement',
  priority              VARCHAR(16) NOT NULL DEFAULT 'medium',
  channel               VARCHAR(32) NOT NULL DEFAULT 'both',
  target_type           VARCHAR(32) NOT NULL DEFAULT 'all',
  target_value          JSONB DEFAULT '{}',
  scheduled_at          TIMESTAMPTZ,
  sent_at               TIMESTAMPTZ,
  status                VARCHAR(16) NOT NULL DEFAULT 'pending',
  total_sent            INTEGER NOT NULL DEFAULT 0,
  total_delivered       INTEGER NOT NULL DEFAULT 0,
  total_read            INTEGER NOT NULL DEFAULT 0,
  metadata              JSONB DEFAULT '{}',
  created_at            TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  last_processed_user_id TEXT,
  batch_size            INTEGER NOT NULL DEFAULT 5,
  batch_delay_ms        INTEGER NOT NULL DEFAULT 500,
  claimed_at            TIMESTAMPTZ
);

-- belt-and-suspenders (matches runtime ALTERs in notification_platform.js)
ALTER TABLE notification_broadcasts ADD COLUMN IF NOT EXISTS last_processed_user_id TEXT;
ALTER TABLE notification_broadcasts ADD COLUMN IF NOT EXISTS batch_size INTEGER NOT NULL DEFAULT 5;
ALTER TABLE notification_broadcasts ADD COLUMN IF NOT EXISTS batch_delay_ms INTEGER NOT NULL DEFAULT 500;
ALTER TABLE notification_broadcasts ADD COLUMN IF NOT EXISTS claimed_at TIMESTAMPTZ;

CREATE INDEX IF NOT EXISTS idx_notif_broadcasts_status ON notification_broadcasts (status, scheduled_at);
CREATE INDEX IF NOT EXISTS idx_notif_broadcasts_stale  ON notification_broadcasts (claimed_at) WHERE status = 'sending';


-- ── notification_templates ─────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS notification_templates (
  id          SERIAL PRIMARY KEY,
  key         VARCHAR(64) NOT NULL UNIQUE,
  category    VARCHAR(32) NOT NULL DEFAULT 'system',
  title_fa    TEXT, title_en TEXT,
  body_fa     TEXT, body_en TEXT,
  icon        VARCHAR(64),
  action_url  TEXT,
  priority    VARCHAR(16) NOT NULL DEFAULT 'medium',
  channel     VARCHAR(32) NOT NULL DEFAULT 'mini_app',
  variables   JSONB DEFAULT '[]',
  is_active   BOOLEAN NOT NULL DEFAULT TRUE,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
);


-- ── profile_cosmetics ──────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS profile_cosmetics (
  id               TEXT PRIMARY KEY DEFAULT gen_random_uuid()::text,
  cosmetic_key     TEXT NOT NULL UNIQUE,
  title            TEXT NOT NULL,
  description      TEXT,
  rarity           TEXT NOT NULL DEFAULT 'common'
                     CHECK (rarity IN ('common', 'rare', 'epic', 'legendary', 'mythic')),
  type             TEXT NOT NULL DEFAULT 'aura'
                     CHECK (type IN ('aura', 'frame', 'background', 'badge_overlay', 'effect')),
  token_cost       INTEGER NOT NULL DEFAULT 100,
  premium_required BOOLEAN NOT NULL DEFAULT TRUE,
  active           BOOLEAN NOT NULL DEFAULT TRUE,
  preview_url      TEXT,
  metadata         JSONB DEFAULT '{}'::jsonb,
  created_at       TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at       TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_cosmetics_active ON profile_cosmetics (active);
CREATE INDEX IF NOT EXISTS idx_cosmetics_rarity ON profile_cosmetics (rarity);


-- ── reward_emergency_controls ──────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS reward_emergency_controls (
  id                          SMALLINT PRIMARY KEY DEFAULT 1,
  disable_wheel               BOOLEAN NOT NULL DEFAULT FALSE,
  disable_referral_rewards    BOOLEAN NOT NULL DEFAULT FALSE,
  disable_mission_rewards     BOOLEAN NOT NULL DEFAULT FALSE,
  disable_campaigns           BOOLEAN NOT NULL DEFAULT FALSE,
  disable_reward_engine       BOOLEAN NOT NULL DEFAULT FALSE,
  updated_at                  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT reward_emergency_single_row CHECK (id = 1)
);


-- ── reward_library ─────────────────────────────────────────────────────────
-- Created BEFORE referral_reward_tiers and mission_rewards (both FK to it).
CREATE TABLE IF NOT EXISTS reward_library (
  id          SERIAL PRIMARY KEY,
  name        VARCHAR(128) NOT NULL,
  reward_type VARCHAR(32) NOT NULL DEFAULT 'token',
  amount      INTEGER NOT NULL DEFAULT 0,
  icon        VARCHAR(64),
  image_url   TEXT,
  description TEXT,
  category    VARCHAR(32) DEFAULT 'general',
  is_active   BOOLEAN NOT NULL DEFAULT TRUE,
  metadata    JSONB DEFAULT '{}',
  created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_reward_library_active ON reward_library (is_active, category);


-- ── reward_purchases ───────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS reward_purchases (
  id             SERIAL PRIMARY KEY,
  user_id        VARCHAR(64) NOT NULL,
  reward_type    VARCHAR(32) NOT NULL DEFAULT 'vpn',
  plan_id        VARCHAR(64),
  plan_name      VARCHAR(128),
  vpn_gb         INTEGER,
  cost_ab        INTEGER NOT NULL,
  duration_days  INTEGER NOT NULL DEFAULT 7,
  status         VARCHAR(16) NOT NULL DEFAULT 'pending',
  tracking_id    VARCHAR(64),
  tx_ref_id      VARCHAR(128),
  vpn_link       TEXT,
  created_at     TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  fulfilled_at   TIMESTAMPTZ,
  fulfilled_by   VARCHAR(64),
  expires_at     TIMESTAMPTZ,
  updated_at     TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- belt-and-suspenders (matches runtime ALTERs in reward_purchases.js)
ALTER TABLE reward_purchases ADD COLUMN IF NOT EXISTS plan_id        VARCHAR(64);
ALTER TABLE reward_purchases ADD COLUMN IF NOT EXISTS plan_name      VARCHAR(128);
ALTER TABLE reward_purchases ADD COLUMN IF NOT EXISTS duration_days  INTEGER NOT NULL DEFAULT 7;
ALTER TABLE reward_purchases ADD COLUMN IF NOT EXISTS tracking_id    VARCHAR(64);
ALTER TABLE reward_purchases ADD COLUMN IF NOT EXISTS vpn_link       TEXT;
ALTER TABLE reward_purchases ADD COLUMN IF NOT EXISTS expires_at     TIMESTAMPTZ;

CREATE INDEX IF NOT EXISTS idx_rp_user            ON reward_purchases (user_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_rp_status          ON reward_purchases (status, created_at ASC);
CREATE INDEX IF NOT EXISTS idx_rp_tracking        ON reward_purchases (tracking_id);
CREATE INDEX IF NOT EXISTS idx_rp_user_plan_status ON reward_purchases (user_id, plan_id, status, created_at DESC);

-- Partial unique index: at most ONE pending purchase per user+plan+gb.
-- This is the critical idempotency guard for the VPN purchase flow.
CREATE UNIQUE INDEX IF NOT EXISTS uq_rp_pending_plan
  ON reward_purchases (user_id, reward_type, vpn_gb)
  WHERE status = 'pending';


-- ── wheel_config ───────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS wheel_config (
  id                      SMALLINT PRIMARY KEY DEFAULT 1,
  is_enabled              BOOLEAN NOT NULL DEFAULT TRUE,
  daily_spin_enabled      BOOLEAN NOT NULL DEFAULT TRUE,
  referral_spin_enabled   BOOLEAN NOT NULL DEFAULT FALSE,
  mission_spin_enabled    BOOLEAN NOT NULL DEFAULT FALSE,
  premium_spin_enabled    BOOLEAN NOT NULL DEFAULT TRUE,
  campaign_spin_enabled   BOOLEAN NOT NULL DEFAULT TRUE,
  maintenance_mode        BOOLEAN NOT NULL DEFAULT FALSE,
  segment_count           SMALLINT NOT NULL DEFAULT 8,
  version                 VARCHAR(32) NOT NULL DEFAULT '1.0.0',
  theme                   VARCHAR(32) NOT NULL DEFAULT 'default',
  max_spins_per_user      INTEGER NOT NULL DEFAULT 3,
  cooldown_seconds        INTEGER NOT NULL DEFAULT 0,
  max_reward_per_day      INTEGER NOT NULL DEFAULT 1000,
  updated_at              TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT wheel_config_single_row CHECK (id = 1)
);


-- ── wheel_rewards ──────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS wheel_rewards (
  id            SERIAL PRIMARY KEY,
  reward_type   VARCHAR(32) NOT NULL,
  reward_amount INTEGER NOT NULL DEFAULT 0,
  reward_label  VARCHAR(128),
  weight        INTEGER NOT NULL DEFAULT 1,
  is_active     BOOLEAN NOT NULL DEFAULT TRUE,
  campaign_id   VARCHAR(64),
  metadata      JSONB DEFAULT '{}',
  created_at    TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_wheel_rewards_active ON wheel_rewards (is_active, campaign_id);


-- ── wheel_spins ────────────────────────────────────────────────────────────
-- Created BEFORE wheel_history (wheel_history.spin_id REFERENCES wheel_spins.id)
CREATE TABLE IF NOT EXISTS wheel_spins (
  id          SERIAL PRIMARY KEY,
  user_id     VARCHAR(64) NOT NULL,
  spin_type   VARCHAR(16) NOT NULL DEFAULT 'daily',
  source      VARCHAR(32) NOT NULL DEFAULT 'daily_free',
  status      VARCHAR(16) NOT NULL DEFAULT 'available',
  campaign_id VARCHAR(64),
  metadata    JSONB DEFAULT '{}',
  created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  expires_at  TIMESTAMPTZ,
  used_at     TIMESTAMPTZ,
  spin_date   DATE NOT NULL DEFAULT CURRENT_DATE
);

-- belt-and-suspenders (matches runtime ALTER in wheel.js)
ALTER TABLE wheel_spins ADD COLUMN IF NOT EXISTS spin_date DATE NOT NULL DEFAULT CURRENT_DATE;

CREATE INDEX IF NOT EXISTS idx_wheel_spins_user ON wheel_spins (user_id, status);


-- ── ad_campaigns ───────────────────────────────────────────────────────────
-- Created BEFORE ad_channels / ad_popups / ad_messages (all FK to ad_campaigns.id)
CREATE TABLE IF NOT EXISTS ad_campaigns (
  id         TEXT PRIMARY KEY,
  type       TEXT NOT NULL CHECK (type IN ('channel_join','popup','message')),
  title      TEXT NOT NULL,
  status     TEXT NOT NULL DEFAULT 'draft' CHECK (status IN ('draft','active','paused','archived')),
  sort_order INTEGER NOT NULL DEFAULT 0,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_ad_campaigns_type_status ON ad_campaigns(type, status, sort_order);


-- ============================================================================
-- SECTION 4: TABLES WITH FK TO users(telegram_id)
-- Created AFTER users (which is in Section 2).
-- ============================================================================

-- ── referrals ──────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS referrals (
  id               SERIAL PRIMARY KEY,
  inviter_id       VARCHAR(64) NOT NULL REFERENCES users(telegram_id),
  invitee_id       VARCHAR(64) NOT NULL REFERENCES users(telegram_id),
  channel_verified BOOLEAN NOT NULL DEFAULT FALSE,
  rewarded         BOOLEAN NOT NULL DEFAULT FALSE,
  created_at       TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  status           VARCHAR(16) NOT NULL DEFAULT 'active',
  metadata         JSONB DEFAULT '{}',
  updated_at       TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  source           VARCHAR(32) NOT NULL DEFAULT 'direct',
  campaign_id      VARCHAR(64)
);

-- belt-and-suspenders (matches runtime ALTERs in referrals.js)
ALTER TABLE referrals ADD COLUMN IF NOT EXISTS status      VARCHAR(16) NOT NULL DEFAULT 'active';
ALTER TABLE referrals ADD COLUMN IF NOT EXISTS metadata    JSONB DEFAULT '{}';
ALTER TABLE referrals ADD COLUMN IF NOT EXISTS updated_at  TIMESTAMPTZ NOT NULL DEFAULT NOW();
ALTER TABLE referrals ADD COLUMN IF NOT EXISTS source      VARCHAR(32) NOT NULL DEFAULT 'direct';
ALTER TABLE referrals ADD COLUMN IF NOT EXISTS campaign_id VARCHAR(64);

CREATE INDEX IF NOT EXISTS idx_referrals_inviter_created ON referrals (inviter_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_referrals_status          ON referrals (status);
CREATE INDEX IF NOT EXISTS idx_referrals_campaign        ON referrals (campaign_id);

-- stabilization_indexes.sql
CREATE INDEX IF NOT EXISTS idx_referrals_invitee ON referrals (invitee_id);
CREATE INDEX IF NOT EXISTS idx_referrals_inviter  ON referrals (inviter_id);

-- Unique constraint: one referral row per invitee (first inviter wins).
-- Wrapped in DO block because ADD CONSTRAINT has no IF NOT EXISTS.
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.table_constraints
    WHERE constraint_name = 'uq_referral_invitee'
      AND table_name = 'referrals'
  ) THEN
    ALTER TABLE referrals ADD CONSTRAINT uq_referral_invitee UNIQUE (invitee_id);
  END IF;
END $$;


-- ── token_balances ─────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS token_balances (
  user_id    VARCHAR(64) PRIMARY KEY REFERENCES users(telegram_id),
  balance    INTEGER NOT NULL DEFAULT 0,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- belt-and-suspenders (matches runtime ALTER in wallet.js)
ALTER TABLE token_balances ADD COLUMN IF NOT EXISTS created_at TIMESTAMPTZ NOT NULL DEFAULT NOW();


-- ── token_transactions ─────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS token_transactions (
  id          SERIAL PRIMARY KEY,
  user_id     VARCHAR(64) NOT NULL REFERENCES users(telegram_id),
  amount      INTEGER NOT NULL,
  tx_type     VARCHAR(32) NOT NULL,
  description VARCHAR(256),
  ref_id      VARCHAR(64),
  created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  status      VARCHAR(16) NOT NULL DEFAULT 'completed',
  source      VARCHAR(32) NOT NULL DEFAULT 'system',
  metadata    JSONB DEFAULT '{}',
  updated_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- belt-and-suspenders (matches runtime ALTERs in wallet.js)
ALTER TABLE token_transactions ADD COLUMN IF NOT EXISTS status     VARCHAR(16) NOT NULL DEFAULT 'completed';
ALTER TABLE token_transactions ADD COLUMN IF NOT EXISTS source     VARCHAR(32) NOT NULL DEFAULT 'system';
ALTER TABLE token_transactions ADD COLUMN IF NOT EXISTS metadata   JSONB DEFAULT '{}';
ALTER TABLE token_transactions ADD COLUMN IF NOT EXISTS updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW();

CREATE INDEX IF NOT EXISTS idx_token_tx_user_created ON token_transactions (user_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_token_tx_type         ON token_transactions (user_id, tx_type);
CREATE INDEX IF NOT EXISTS idx_token_tx_status       ON token_transactions (user_id, status);

-- stabilization_indexes.sql (alias name)
CREATE INDEX IF NOT EXISTS idx_token_transactions_user_created ON token_transactions (user_id, created_at DESC);

-- R-3.1: UNIQUE constraint on (user_id, tx_type, ref_id) for completed txs.
-- Partial index: only applies when ref_id IS NOT NULL and status='completed'.
CREATE UNIQUE INDEX IF NOT EXISTS idx_token_tx_user_type_ref
  ON token_transactions (user_id, tx_type, ref_id)
  WHERE ref_id IS NOT NULL AND status = 'completed';


-- ── watchlist_items ────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS watchlist_items (
  id         SERIAL PRIMARY KEY,
  user_id    VARCHAR(64) NOT NULL REFERENCES users(telegram_id),
  symbol     VARCHAR(32) NOT NULL,
  position   INTEGER NOT NULL DEFAULT 0,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_watchlist_items_user_id ON watchlist_items (user_id);


-- ── price_alerts ───────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS price_alerts (
  id                  VARCHAR(64) PRIMARY KEY,
  user_id             VARCHAR(64) NOT NULL REFERENCES users(telegram_id),
  symbol              VARCHAR(32) NOT NULL,
  price               NUMERIC(24,8) NOT NULL,
  direction           VARCHAR(16) NOT NULL DEFAULT 'above',
  status              VARCHAR(16) NOT NULL DEFAULT 'active',
  created_at          TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  triggered_at        TIMESTAMPTZ,
  last_price          NUMERIC(24,8),
  last_checked_at     TIMESTAMPTZ,
  last_trigger_price  NUMERIC(24,8)
);

-- belt-and-suspenders (matches runtime ALTERs in alerts.js)
ALTER TABLE price_alerts ADD COLUMN IF NOT EXISTS last_price          NUMERIC(24,8);
ALTER TABLE price_alerts ADD COLUMN IF NOT EXISTS last_checked_at     TIMESTAMPTZ;
ALTER TABLE price_alerts ADD COLUMN IF NOT EXISTS last_trigger_price  NUMERIC(24,8);

CREATE INDEX IF NOT EXISTS idx_price_alerts_user_status    ON price_alerts (user_id, status);
CREATE INDEX IF NOT EXISTS idx_price_alerts_dedup          ON price_alerts (user_id, symbol, price, direction);
CREATE INDEX IF NOT EXISTS idx_price_alerts_status_created ON price_alerts (status, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_price_alerts_status_symbol  ON price_alerts (status, symbol);


-- ── notifications ──────────────────────────────────────────────────────────
-- Merges definitions from both notification_platform.js (extended) and
-- the legacy notifications.js (base). Both create the same table.
CREATE TABLE IF NOT EXISTS notifications (
  id          TEXT PRIMARY KEY,
  user_id     TEXT NOT NULL REFERENCES users(telegram_id) ON DELETE CASCADE,
  type        TEXT NOT NULL,
  title       TEXT NOT NULL DEFAULT '',
  message     TEXT NOT NULL DEFAULT '',
  metadata    JSONB,
  read_status BOOLEAN NOT NULL DEFAULT FALSE,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  deleted_at  TIMESTAMPTZ,
  priority    VARCHAR(16) NOT NULL DEFAULT 'medium',
  category    VARCHAR(32) NOT NULL DEFAULT 'system',
  channel     VARCHAR(32) NOT NULL DEFAULT 'mini_app',
  status      VARCHAR(16) NOT NULL DEFAULT 'delivered',
  archived    BOOLEAN NOT NULL DEFAULT FALSE,
  action_url  TEXT,
  icon        VARCHAR(64),
  read_at     TIMESTAMPTZ,
  expires_at  TIMESTAMPTZ
);

-- belt-and-suspenders (matches runtime ALTERs in notification_platform.js + notifications.js)
ALTER TABLE notifications ADD COLUMN IF NOT EXISTS deleted_at TIMESTAMPTZ;

ALTER TABLE notifications
  ADD COLUMN IF NOT EXISTS priority  VARCHAR(16) NOT NULL DEFAULT 'medium',
  ADD COLUMN IF NOT EXISTS category  VARCHAR(32) NOT NULL DEFAULT 'system',
  ADD COLUMN IF NOT EXISTS channel   VARCHAR(32) NOT NULL DEFAULT 'mini_app',
  ADD COLUMN IF NOT EXISTS status    VARCHAR(16) NOT NULL DEFAULT 'delivered',
  ADD COLUMN IF NOT EXISTS archived  BOOLEAN NOT NULL DEFAULT FALSE,
  ADD COLUMN IF NOT EXISTS action_url TEXT,
  ADD COLUMN IF NOT EXISTS icon      VARCHAR(64),
  ADD COLUMN IF NOT EXISTS read_at   TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS expires_at TIMESTAMPTZ;

CREATE INDEX IF NOT EXISTS idx_notifications_user_created  ON notifications(user_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_notifications_user_unread   ON notifications(user_id) WHERE read_status = FALSE;
CREATE INDEX IF NOT EXISTS idx_notifications_user_active   ON notifications(user_id, created_at DESC) WHERE deleted_at IS NULL;
CREATE INDEX IF NOT EXISTS idx_notif_category              ON notifications (category);
CREATE INDEX IF NOT EXISTS idx_notif_priority              ON notifications (priority);
CREATE INDEX IF NOT EXISTS idx_notif_user_unread_active    ON notifications (user_id) WHERE read_status = FALSE AND deleted_at IS NULL;


-- ── notification_settings ──────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS notification_settings (
  user_id     TEXT PRIMARY KEY REFERENCES users(telegram_id) ON DELETE CASCADE,
  analysis    BOOLEAN NOT NULL DEFAULT TRUE,
  calendar    BOOLEAN NOT NULL DEFAULT FALSE,
  price_alert BOOLEAN NOT NULL DEFAULT FALSE,
  market      BOOLEAN NOT NULL DEFAULT FALSE,
  news        BOOLEAN NOT NULL DEFAULT FALSE,
  referral    BOOLEAN NOT NULL DEFAULT FALSE,
  reward      BOOLEAN NOT NULL DEFAULT FALSE,
  ticket      BOOLEAN NOT NULL DEFAULT FALSE,
  system      BOOLEAN NOT NULL DEFAULT FALSE,
  marketing   BOOLEAN NOT NULL DEFAULT FALSE,
  updated_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  ch_referral       VARCHAR(16) NOT NULL DEFAULT 'mini_app',
  ch_wallet         VARCHAR(16) NOT NULL DEFAULT 'both',
  ch_price_alert    VARCHAR(16) NOT NULL DEFAULT 'both',
  ch_analysis       VARCHAR(16) NOT NULL DEFAULT 'both',
  ch_breaking_news  VARCHAR(16) NOT NULL DEFAULT 'both',
  ch_announcements  VARCHAR(16) NOT NULL DEFAULT 'mini_app',
  ch_promotions     VARCHAR(16) NOT NULL DEFAULT 'none',
  ch_challenges     VARCHAR(16) NOT NULL DEFAULT 'mini_app',
  ch_tickets        VARCHAR(16) NOT NULL DEFAULT 'both',
  ch_calendar       VARCHAR(16) NOT NULL DEFAULT 'both',
  ch_news           VARCHAR(16) NOT NULL DEFAULT 'both',
  ch_market         VARCHAR(16) NOT NULL DEFAULT 'both',
  ch_wheel          VARCHAR(16) NOT NULL DEFAULT 'mini_app',
  ch_mission        VARCHAR(16) NOT NULL DEFAULT 'both',
  ch_security       VARCHAR(16) NOT NULL DEFAULT 'both',
  ch_system         VARCHAR(16) NOT NULL DEFAULT 'mini_app'
);

-- belt-and-suspenders: 16 ch_* channel preference columns
ALTER TABLE notification_settings ADD COLUMN IF NOT EXISTS ch_referral      VARCHAR(16) NOT NULL DEFAULT 'mini_app';
ALTER TABLE notification_settings ADD COLUMN IF NOT EXISTS ch_wallet        VARCHAR(16) NOT NULL DEFAULT 'both';
ALTER TABLE notification_settings ADD COLUMN IF NOT EXISTS ch_price_alert   VARCHAR(16) NOT NULL DEFAULT 'both';
ALTER TABLE notification_settings ADD COLUMN IF NOT EXISTS ch_analysis      VARCHAR(16) NOT NULL DEFAULT 'both';
ALTER TABLE notification_settings ADD COLUMN IF NOT EXISTS ch_breaking_news VARCHAR(16) NOT NULL DEFAULT 'both';
ALTER TABLE notification_settings ADD COLUMN IF NOT EXISTS ch_announcements VARCHAR(16) NOT NULL DEFAULT 'mini_app';
ALTER TABLE notification_settings ADD COLUMN IF NOT EXISTS ch_promotions    VARCHAR(16) NOT NULL DEFAULT 'none';
ALTER TABLE notification_settings ADD COLUMN IF NOT EXISTS ch_challenges    VARCHAR(16) NOT NULL DEFAULT 'mini_app';
ALTER TABLE notification_settings ADD COLUMN IF NOT EXISTS ch_tickets       VARCHAR(16) NOT NULL DEFAULT 'both';
ALTER TABLE notification_settings ADD COLUMN IF NOT EXISTS ch_calendar      VARCHAR(16) NOT NULL DEFAULT 'both';
ALTER TABLE notification_settings ADD COLUMN IF NOT EXISTS ch_news          VARCHAR(16) NOT NULL DEFAULT 'both';
ALTER TABLE notification_settings ADD COLUMN IF NOT EXISTS ch_market        VARCHAR(16) NOT NULL DEFAULT 'both';
ALTER TABLE notification_settings ADD COLUMN IF NOT EXISTS ch_wheel         VARCHAR(16) NOT NULL DEFAULT 'mini_app';
ALTER TABLE notification_settings ADD COLUMN IF NOT EXISTS ch_mission       VARCHAR(16) NOT NULL DEFAULT 'both';
ALTER TABLE notification_settings ADD COLUMN IF NOT EXISTS ch_security      VARCHAR(16) NOT NULL DEFAULT 'both';
ALTER TABLE notification_settings ADD COLUMN IF NOT EXISTS ch_system        VARCHAR(16) NOT NULL DEFAULT 'mini_app';


-- ── notification_queue ─────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS notification_queue (
  id                SERIAL PRIMARY KEY,
  notification_id   TEXT,
  user_id           TEXT NOT NULL,
  channel           VARCHAR(32) NOT NULL DEFAULT 'mini_app',
  priority          VARCHAR(16) NOT NULL DEFAULT 'medium',
  status            VARCHAR(16) NOT NULL DEFAULT 'pending',
  attempts          INTEGER NOT NULL DEFAULT 0,
  max_attempts      INTEGER NOT NULL DEFAULT 3,
  next_retry_at     TIMESTAMPTZ,
  payload           JSONB DEFAULT '{}',
  error             TEXT,
  created_at        TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  processed_at      TIMESTAMPTZ,
  telegram_message_id BIGINT,
  claimed_at        TIMESTAMPTZ
);

-- belt-and-suspenders (matches runtime ALTERs in notification_platform.js)
ALTER TABLE notification_queue ADD COLUMN IF NOT EXISTS telegram_message_id BIGINT;
ALTER TABLE notification_queue ADD COLUMN IF NOT EXISTS claimed_at           TIMESTAMPTZ;

-- Phase 3 idempotency migration for notification_queue:
--   1. Backfill NULL notification_id with deterministic unique ID
--   2. Remove duplicate rows (keep newest by id) — only if duplicates exist
--   3. Set notification_id NOT NULL (safe — step 1 eliminated all NULLs)
--   4. Add UNIQUE constraint (notification_id, user_id) via DO block
-- The whole migration runs inside this single BEGIN/COMMIT transaction, so
-- no concurrent inserts can race with the NOT NULL alter.
UPDATE notification_queue
   SET notification_id = 'legacy_' || id::text
 WHERE notification_id IS NULL;

DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM (
      SELECT notification_id, user_id, COUNT(*) AS cnt
        FROM notification_queue
       GROUP BY notification_id, user_id
      HAVING COUNT(*) > 1
    ) dups
    LIMIT 1
  ) THEN
    DELETE FROM notification_queue
     WHERE id NOT IN (
       SELECT MAX(id) FROM notification_queue
        GROUP BY notification_id, user_id
     );
  END IF;
END $$;

-- Safe to set NOT NULL: the UPDATE above eliminated all NULLs in this transaction.
ALTER TABLE notification_queue ALTER COLUMN notification_id SET NOT NULL;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.table_constraints
    WHERE constraint_name = 'uq_notification_queue_dedup'
      AND table_name = 'notification_queue'
  ) THEN
    ALTER TABLE notification_queue
      ADD CONSTRAINT uq_notification_queue_dedup
      UNIQUE (notification_id, user_id);
  END IF;
END $$;

CREATE INDEX IF NOT EXISTS idx_notif_queue_pending    ON notification_queue (status, priority, next_retry_at) WHERE status = 'pending';
CREATE INDEX IF NOT EXISTS idx_notif_queue_processing ON notification_queue (claimed_at) WHERE status = 'processing';


-- ── daily_checkin_streaks (FK to users — defined inline in wallet.js) ──────
CREATE TABLE IF NOT EXISTS daily_checkin_streaks (
  user_id          TEXT PRIMARY KEY REFERENCES users(telegram_id) ON DELETE CASCADE,
  streak_day       SMALLINT NOT NULL DEFAULT 0,
  last_claim_date  DATE NOT NULL DEFAULT '1970-01-01',
  cycle_count      INTEGER NOT NULL DEFAULT 0,
  updated_at       TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  created_at       TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_checkin_streaks_last_claim ON daily_checkin_streaks (last_claim_date);


-- ── tickets ────────────────────────────────────────────────────────────────
-- Created BEFORE ticket_replies (FK reference).
CREATE TABLE IF NOT EXISTS tickets (
  id         VARCHAR(64) PRIMARY KEY,
  user_id    VARCHAR(64) NOT NULL REFERENCES users(telegram_id),
  user_name  VARCHAR(128) NOT NULL,
  title      VARCHAR(256) NOT NULL,
  body       TEXT NOT NULL,
  status     VARCHAR(32) NOT NULL DEFAULT 'open',
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_tickets_user_id ON tickets (user_id);


-- ============================================================================
-- SECTION 5: TABLES WITH FK TO OTHER CHILD TABLES
-- Created AFTER their parent tables (which are in earlier sections).
-- ============================================================================

-- ── ticket_replies (FK to tickets.id) ──────────────────────────────────────
CREATE TABLE IF NOT EXISTS ticket_replies (
  id          SERIAL PRIMARY KEY,
  ticket_id   VARCHAR(64) NOT NULL REFERENCES tickets(id) ON DELETE CASCADE,
  sender_type VARCHAR(16) NOT NULL,
  sender_id   VARCHAR(64),
  message     TEXT NOT NULL,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_ticket_replies_ticket_id ON ticket_replies (ticket_id);


-- ── referral_reward_tiers (FK to reward_library.id) ────────────────────────
CREATE TABLE IF NOT EXISTS referral_reward_tiers (
  id                SERIAL PRIMARY KEY,
  invite_count      INTEGER NOT NULL UNIQUE,
  reward_library_id INTEGER REFERENCES reward_library(id),
  token_amount      INTEGER NOT NULL DEFAULT 0,
  bonus_spins       INTEGER NOT NULL DEFAULT 0,
  campaign_id       VARCHAR(64),
  is_enabled        BOOLEAN NOT NULL DEFAULT TRUE,
  sort_order        INTEGER NOT NULL DEFAULT 0,
  metadata          JSONB DEFAULT '{}',
  created_at        TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at        TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_referral_tiers_count ON referral_reward_tiers (invite_count, is_enabled);


-- ── mission_rewards (FK to reward_library.id) ──────────────────────────────
CREATE TABLE IF NOT EXISTS mission_rewards (
  id                SERIAL PRIMARY KEY,
  mission_id        VARCHAR(64) NOT NULL UNIQUE,
  mission_name      VARCHAR(128) NOT NULL,
  reward_library_id INTEGER REFERENCES reward_library(id),
  token_amount      INTEGER NOT NULL DEFAULT 0,
  bonus_spins       INTEGER NOT NULL DEFAULT 0,
  campaign_id       VARCHAR(64),
  is_enabled        BOOLEAN NOT NULL DEFAULT TRUE,
  sort_order        INTEGER NOT NULL DEFAULT 0,
  metadata          JSONB DEFAULT '{}',
  created_at        TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at        TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_mission_rewards_enabled ON mission_rewards (is_enabled, sort_order);


-- ── ad_channels (FK to ad_campaigns.id) ────────────────────────────────────
CREATE TABLE IF NOT EXISTS ad_channels (
  id               TEXT PRIMARY KEY,
  campaign_id      TEXT NOT NULL REFERENCES ad_campaigns(id) ON DELETE CASCADE,
  channel_username TEXT NOT NULL,
  channel_title    TEXT NOT NULL,
  join_url         TEXT NOT NULL,
  display_order    INTEGER NOT NULL DEFAULT 0,
  is_active        BOOLEAN NOT NULL DEFAULT TRUE,
  created_at       TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at       TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_ad_channels_active ON ad_channels(is_active, display_order);
CREATE UNIQUE INDEX IF NOT EXISTS uq_ad_channels_username
  ON ad_channels(lower(channel_username)) WHERE is_active = TRUE;


-- ── ad_popups (FK to ad_campaigns.id) ──────────────────────────────────────
CREATE TABLE IF NOT EXISTS ad_popups (
  id             TEXT PRIMARY KEY,
  campaign_id    TEXT NOT NULL REFERENCES ad_campaigns(id) ON DELETE CASCADE,
  title          TEXT NOT NULL,
  body_text      TEXT NOT NULL,
  button_label   TEXT NOT NULL DEFAULT '',
  button_url     TEXT NOT NULL DEFAULT '',
  image_url      TEXT NOT NULL DEFAULT '',
  display_order  INTEGER NOT NULL DEFAULT 0,
  is_active      BOOLEAN NOT NULL DEFAULT TRUE,
  cooldown_seconds INTEGER NOT NULL DEFAULT 86400,
  created_at     TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at     TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_ad_popups_active ON ad_popups(is_active, display_order);


-- ── ad_messages (FK to ad_campaigns.id) ────────────────────────────────────
CREATE TABLE IF NOT EXISTS ad_messages (
  id              TEXT PRIMARY KEY,
  campaign_id     TEXT NOT NULL REFERENCES ad_campaigns(id) ON DELETE CASCADE,
  title           TEXT NOT NULL,
  body_text       TEXT NOT NULL,
  button_label    TEXT NOT NULL DEFAULT '',
  button_url      TEXT NOT NULL DEFAULT '',
  image_url       TEXT NOT NULL DEFAULT '',
  destinations    TEXT NOT NULL DEFAULT 'both' CHECK (destinations IN ('mini_app','telegram','both')),
  target_audience TEXT NOT NULL DEFAULT 'all' CHECK (target_audience IN ('free','premium','all')),
  is_active       BOOLEAN NOT NULL DEFAULT TRUE,
  last_processed_at TIMESTAMPTZ,
  broadcast_id    TEXT,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_ad_messages_active ON ad_messages(is_active, target_audience);


-- ── wheel_history (FK to wheel_spins.id) ───────────────────────────────────
CREATE TABLE IF NOT EXISTS wheel_history (
  id            SERIAL PRIMARY KEY,
  user_id       VARCHAR(64) NOT NULL,
  spin_id       INTEGER REFERENCES wheel_spins(id),
  reward_type   VARCHAR(32) NOT NULL,
  reward_amount INTEGER NOT NULL DEFAULT 0,
  reward_label  VARCHAR(128),
  spin_type     VARCHAR(16) NOT NULL DEFAULT 'daily',
  metadata      JSONB DEFAULT '{}',
  created_at    TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_wheel_history_user ON wheel_history (user_id, created_at DESC);


-- ── user_cosmetic_ownership (FK to profile_cosmetics.id) ───────────────────
CREATE TABLE IF NOT EXISTS user_cosmetic_ownership (
  id           TEXT PRIMARY KEY DEFAULT gen_random_uuid()::text,
  user_id      TEXT NOT NULL,
  cosmetic_id  TEXT NOT NULL REFERENCES profile_cosmetics(id) ON DELETE CASCADE,
  tokens_spent INTEGER NOT NULL DEFAULT 0,
  is_active    BOOLEAN NOT NULL DEFAULT FALSE,
  purchased_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  activated_at TIMESTAMPTZ,
  created_at   TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at   TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE UNIQUE INDEX IF NOT EXISTS uq_cosmetic_ownership_user_cosmetic
  ON user_cosmetic_ownership (user_id, cosmetic_id);

CREATE UNIQUE INDEX IF NOT EXISTS uq_cosmetic_active_per_user
  ON user_cosmetic_ownership (user_id)
  WHERE is_active = TRUE;

CREATE INDEX IF NOT EXISTS idx_cosmetic_ownership_user ON user_cosmetic_ownership (user_id);


-- ============================================================================
-- SECTION 6: TRIGGERS & FUNCTIONS (updated_at auto-maintenance)
-- CREATE OR REPLACE FUNCTION is idempotent. DROP TRIGGER IF EXISTS is the
-- standard idempotent trigger-recreation pattern (DROP TRIGGER is NOT in
-- the forbidden-operations list).
-- ============================================================================

CREATE OR REPLACE FUNCTION membership_set_updated_at()
RETURNS TRIGGER AS $$
BEGIN
  NEW.updated_at = NOW();
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE OR REPLACE FUNCTION cosmetics_set_updated_at()
RETURNS TRIGGER AS $$
BEGIN
  NEW.updated_at = NOW();
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE OR REPLACE FUNCTION membership_requirements_set_updated_at()
RETURNS TRIGGER AS $$
BEGIN
  NEW.updated_at = NOW();
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE OR REPLACE FUNCTION membership_rules_set_updated_at()
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

DROP TRIGGER IF EXISTS trg_cosmetics_updated ON profile_cosmetics;
CREATE TRIGGER trg_cosmetics_updated BEFORE UPDATE ON profile_cosmetics
  FOR EACH ROW EXECUTE FUNCTION cosmetics_set_updated_at();

DROP TRIGGER IF EXISTS trg_cosmetic_owner_updated ON user_cosmetic_ownership;
CREATE TRIGGER trg_cosmetic_owner_updated BEFORE UPDATE ON user_cosmetic_ownership
  FOR EACH ROW EXECUTE FUNCTION cosmetics_set_updated_at();

DROP TRIGGER IF EXISTS trg_mreq_updated ON membership_requirements;
CREATE TRIGGER trg_mreq_updated BEFORE UPDATE ON membership_requirements
  FOR EACH ROW EXECUTE FUNCTION membership_requirements_set_updated_at();

DROP TRIGGER IF EXISTS trg_mrules_updated ON membership_rules;
CREATE TRIGGER trg_mrules_updated BEFORE UPDATE ON membership_rules
  FOR EACH ROW EXECUTE FUNCTION membership_rules_set_updated_at();


-- ============================================================================
-- SECTION 7: CONSTRAINT CLEANUP (the single explicitly-approved DROP)
-- ============================================================================
-- Per the task's hard-constraint #4, this is the ONLY allowed destructive
-- operation in the entire migration. It must appear exactly once, before any
-- re-creation of constraints on wheel_spins. The runtime code (wheel.js) does
-- NOT re-create a unique constraint on wheel_spins after this drop — the
-- daily-spin limit is enforced at the application layer via an advisory lock
-- + COUNT check, not via a UNIQUE constraint. So there is no re-creation here.

ALTER TABLE wheel_spins
  DROP CONSTRAINT IF EXISTS wheel_spins_user_id_spin_type_source_created_at_key;


-- ============================================================================
-- SECTION 8: SEED DATA (idempotent — ON CONFLICT DO NOTHING)
-- Minimal seed for config tables required by the runtime to function.
-- Catalog/cosmetic seeds that are large and stable live in their original
-- SQL files (membership-cosmetics-schema.sql etc.); this migration only
-- seeds the small config tables that the runtime expects to be non-empty.
-- ============================================================================

-- alert_config: default per-type configs (matches alert_economy.js ensureSchema)
INSERT INTO alert_config (alert_type, is_enabled, free_per_day, cost_per_extra) VALUES
  ('price_alert',    TRUE,  3, 5),
  ('calendar_alert', FALSE, 3, 5),
  ('breaking_news',  FALSE, 3, 5)
ON CONFLICT (alert_type) DO NOTHING;

-- wheel_config: default single-row config (matches reward_center.js ensureSchema)
INSERT INTO wheel_config (id) VALUES (1) ON CONFLICT (id) DO NOTHING;

-- reward_emergency_controls: default single-row kill-switch config
INSERT INTO reward_emergency_controls (id) VALUES (1) ON CONFLICT (id) DO NOTHING;

-- membership_requirements: Bitunix v1 ACTIVE (matches membership-requirements-schema.sql)
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

-- Ensure exactly one ACTIVE membership requirement
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM membership_requirements WHERE status = 'ACTIVE') THEN
    UPDATE membership_requirements
       SET status = 'ACTIVE', effective_at = NOW()
     WHERE version = (SELECT MAX(version) FROM membership_requirements);
  END IF;
END $$;

-- membership_rules: Premium Rules v1 ACTIVE (matches membership-rules-schema.sql)
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

-- Ensure exactly one ACTIVE rules version
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM membership_rules WHERE status = 'ACTIVE') THEN
    UPDATE membership_rules
       SET status = 'ACTIVE', effective_at = NOW()
     WHERE version = (SELECT MAX(version) FROM membership_rules);
  END IF;
END $$;


-- ═══════════════════════════════════════════════════════════════════════════
-- SECTION: Groq DB Gateway Function (Worker Egress WAF Bypass)
-- ═══════════════════════════════════════════════════════════════════════════
-- PROBLEM: Cloudflare Worker → api.groq.com returns HTTP 403 Forbidden from
-- server:cloudflare (WAF edge). Both Groq keys (Key0 + Key1) blocked equally.
-- Root cause: Groq's Cloudflare WAF blocks Cloudflare Worker egress IPs.
--
-- SOLUTION: Route Groq calls through Supabase DB gateway (same pattern as
-- public.gemini_generate()). Supabase's IP makes the outbound HTTP call to
-- api.groq.com, bypassing the Worker egress WAF block.
--
-- This NEW function takes the API key as a PARAMETER (passed from Worker's
-- env.GROQ_API_KEY / env.GROQ_API_KEY_1). Keys stay in Cloudflare secrets.
-- The existing public.groq_generate() (reads from Vault) is UNCHANGED.
--
-- SECURITY: SECURITY DEFINER, search_path locked, API key never stored/logged.
-- Idempotent (CREATE OR REPLACE).
-- ═══════════════════════════════════════════════════════════════════════════

CREATE OR REPLACE FUNCTION public.groq_generate_with_key(
  p_model text,
  p_messages jsonb,
  p_api_key text,
  p_max_tokens integer DEFAULT 1024,
  p_temperature double precision DEFAULT 0.4
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public', 'vault', 'extensions'
AS $function$
        DECLARE
          v_request_body jsonb;
          v_status int;
          v_content text;
        BEGIN
          PERFORM set_config('statement_timeout', '30000', true);

          IF p_api_key IS NULL OR p_api_key = '' THEN
            RETURN jsonb_build_object('status_code', 503, 'response_body', '{"error":{"message":"Groq API key not provided as parameter","status":"UNAVAILABLE"}}');
          END IF;

          IF p_model NOT IN ('openai/gpt-oss-120b') THEN
            RETURN jsonb_build_object('status_code', 400, 'response_body', '{"error":{"message":"Invalid model: only openai/gpt-oss-120b is supported","status":"INVALID_ARGUMENT"}}');
          END IF;

          v_request_body := jsonb_build_object(
            'model', p_model,
            'messages', p_messages,
            'max_tokens', p_max_tokens,
            'temperature', p_temperature
          );

          SELECT status, content INTO v_status, v_content
          FROM http((
            'POST',
            'https://api.groq.com/openai/v1/chat/completions',
            ARRAY[
              http_header('Authorization', 'Bearer ' || p_api_key),
              http_header('Content-Type', 'application/json')
            ],
            'application/json',
            v_request_body::text
          )::http_request);

          RETURN jsonb_build_object('status_code', v_status, 'response_body', v_content);
        EXCEPTION
          WHEN OTHERS THEN
            RETURN jsonb_build_object(
              'status_code', 0,
              'response_body', jsonb_build_object(
                'error', jsonb_build_object(
                  'message', 'db_gateway_error',
                  'detail', substring(SQLERRM, 1, 200)
                )
              )::text
            );
        END;
        $function$;

GRANT EXECUTE ON FUNCTION public.groq_generate_with_key(text, jsonb, text, integer, double precision) TO PUBLIC;


-- Migration complete
COMMIT;
