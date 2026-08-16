-- ═══════════════════════════════════════════════════════════════════════════
-- PHASE 5 — Profile Cosmetics Schema
-- ═══════════════════════════════════════════════════════════════════════════
-- Adds two tables for the Profile Cosmetics system:
--   1. profile_cosmetics        — catalog of purchasable cosmetic styles
--   2. user_cosmetic_ownership  — per-user ownership + active state
--
-- SAFETY:
--   • 100% idempotent (IF NOT EXISTS / ON CONFLICT DO NOTHING)
--   • No DROP, no TRUNCATE, no DELETE of existing data
--   • Rollback: DROP TABLE profile_cosmetics; DROP TABLE user_cosmetic_ownership;
-- ═══════════════════════════════════════════════════════════════════════════

CREATE TABLE IF NOT EXISTS profile_cosmetics (
  id              TEXT PRIMARY KEY DEFAULT gen_random_uuid()::text,
  cosmetic_key    TEXT NOT NULL UNIQUE,
  title           TEXT NOT NULL,
  description     TEXT,
  rarity          TEXT NOT NULL DEFAULT 'common'
                    CHECK (rarity IN ('common', 'rare', 'epic', 'legendary', 'mythic')),
  type            TEXT NOT NULL DEFAULT 'aura'
                    CHECK (type IN ('aura', 'frame', 'background', 'badge_overlay', 'effect')),
  token_cost      INTEGER NOT NULL DEFAULT 100,
  premium_required BOOLEAN NOT NULL DEFAULT TRUE,
  active          BOOLEAN NOT NULL DEFAULT TRUE,
  preview_url     TEXT,
  metadata        JSONB DEFAULT '{}'::jsonb,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_cosmetics_active ON profile_cosmetics (active);
CREATE INDEX IF NOT EXISTS idx_cosmetics_rarity ON profile_cosmetics (rarity);

CREATE TABLE IF NOT EXISTS user_cosmetic_ownership (
  id              TEXT PRIMARY KEY DEFAULT gen_random_uuid()::text,
  user_id         TEXT NOT NULL,
  cosmetic_id     TEXT NOT NULL REFERENCES profile_cosmetics(id) ON DELETE CASCADE,
  tokens_spent    INTEGER NOT NULL DEFAULT 0,
  is_active       BOOLEAN NOT NULL DEFAULT FALSE,
  purchased_at    TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  activated_at    TIMESTAMPTZ,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE UNIQUE INDEX IF NOT EXISTS uq_cosmetic_ownership_user_cosmetic
  ON user_cosmetic_ownership (user_id, cosmetic_id);

CREATE UNIQUE INDEX IF NOT EXISTS uq_cosmetic_active_per_user
  ON user_cosmetic_ownership (user_id)
  WHERE is_active = TRUE;

CREATE INDEX IF NOT EXISTS idx_cosmetic_ownership_user ON user_cosmetic_ownership (user_id);

CREATE OR REPLACE FUNCTION cosmetics_set_updated_at()
RETURNS TRIGGER AS $$
BEGIN
  NEW.updated_at = NOW();
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS trg_cosmetics_updated ON profile_cosmetics;
CREATE TRIGGER trg_cosmetics_updated BEFORE UPDATE ON profile_cosmetics
  FOR EACH ROW EXECUTE FUNCTION cosmetics_set_updated_at();

DROP TRIGGER IF EXISTS trg_cosmetic_owner_updated ON user_cosmetic_ownership;
CREATE TRIGGER trg_cosmetic_owner_updated BEFORE UPDATE ON user_cosmetic_ownership
  FOR EACH ROW EXECUTE FUNCTION cosmetics_set_updated_at();

-- ═══════════════════════════════════════════════════════════════════════════
-- SEED: 10 Initial Cosmetics (5 rarities)
-- ═══════════════════════════════════════════════════════════════════════════
INSERT INTO profile_cosmetics (cosmetic_key, title, description, rarity, type, token_cost, premium_required, active, metadata)
VALUES
  ('golden_aura', 'Golden Aura', 'هاله طلایی نرم', 'common', 'aura', 100, TRUE, TRUE,
    '{"css_class":"profile-cosmetic--golden-aura","color":"#d4af37"}'::jsonb),
  ('ice', 'Ice', 'هاله یخی آبی', 'common', 'aura', 100, TRUE, TRUE,
    '{"css_class":"profile-cosmetic--ice","color":"#7dd3fc"}'::jsonb),
  ('energy', 'Energy', 'انرژی پالس الکتریکی', 'rare', 'aura', 500, TRUE, TRUE,
    '{"css_class":"profile-cosmetic--energy","color":"#a855f7"}'::jsonb),
  ('lava', 'Lava', 'مواد مذاب نارنجی-قرمز', 'rare', 'aura', 500, TRUE, TRUE,
    '{"css_class":"profile-cosmetic--lava","color":"#f97316"}'::jsonb),
  ('cyber', 'Cyber', 'شبکه نئونی سایبرپانک', 'epic', 'aura', 1500, TRUE, TRUE,
    '{"css_class":"profile-cosmetic--cyber","color":"#22d3ee"}'::jsonb),
  ('nebula', 'Nebula', 'فضای عمیق بنفش', 'epic', 'aura', 1500, TRUE, TRUE,
    '{"css_class":"profile-cosmetic--nebula","color":"#8b5cf6"}'::jsonb),
  ('galaxy', 'Galaxy', 'موج ستاره‌ای', 'legendary', 'aura', 5000, TRUE, TRUE,
    '{"css_class":"profile-cosmetic--galaxy","color":"#6366f1"}'::jsonb),
  ('gold_frame', 'Gold Frame', 'قاب طلایی تزئینی', 'legendary', 'frame', 5000, TRUE, TRUE,
    '{"css_class":"profile-cosmetic--gold-frame","color":"#fbbf24"}'::jsonb),
  ('royal', 'Royal', 'بنفش سلطنتی + تاج', 'mythic', 'aura', 10000, TRUE, TRUE,
    '{"css_class":"profile-cosmetic--royal","color":"#7c3aed"}'::jsonb),
  ('legendary', 'Legendary', 'تروفی نهایت', 'mythic', 'aura', 10000, TRUE, TRUE,
    '{"css_class":"profile-cosmetic--legendary","color":"#f59e0b"}'::jsonb)
ON CONFLICT (cosmetic_key) DO NOTHING;
