-- R4: Admin Panel Database Schema
-- Run this against the Neon PostgreSQL database

CREATE TABLE IF NOT EXISTS admins (
    id SERIAL PRIMARY KEY,
    telegram_id VARCHAR(64) NOT NULL UNIQUE,
    role VARCHAR(50) NOT NULL DEFAULT 'admin',
    permissions JSONB DEFAULT '[]'::jsonb,
    active BOOLEAN DEFAULT TRUE,
    created_at TIMESTAMPTZ DEFAULT NOW(),
    created_by VARCHAR(64)
);

CREATE TABLE IF NOT EXISTS broadcasts (
    id SERIAL PRIMARY KEY,
    sender_id VARCHAR(64) NOT NULL,
    target_type VARCHAR(50) NOT NULL DEFAULT 'all',
    target_value VARCHAR(255),
    message_type VARCHAR(20) DEFAULT 'text',
    content TEXT NOT NULL,
    status VARCHAR(20) DEFAULT 'pending',
    sent_count INTEGER DEFAULT 0,
    failed_count INTEGER DEFAULT 0,
    created_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS broadcast_logs (
    id SERIAL PRIMARY KEY,
    broadcast_id INTEGER REFERENCES broadcasts(id) ON DELETE SET NULL,
    user_id VARCHAR(64) NOT NULL,
    status VARCHAR(20) DEFAULT 'pending',
    error TEXT,
    sent_at TIMESTAMPTZ
);

CREATE TABLE IF NOT EXISTS rewards (
    id SERIAL PRIMARY KEY,
    user_id VARCHAR(64) NOT NULL,
    prize_type VARCHAR(50) NOT NULL,
    prize_value TEXT,
    status VARCHAR(20) DEFAULT 'pending',
    claimed_at TIMESTAMPTZ,
    created_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS admin_logs (
    id SERIAL PRIMARY KEY,
    admin_id VARCHAR(64) NOT NULL,
    action VARCHAR(100) NOT NULL,
    target_type VARCHAR(50),
    target_id VARCHAR(255),
    details JSONB,
    ip VARCHAR(45),
    created_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_admins_telegram_id ON admins(telegram_id);
CREATE INDEX IF NOT EXISTS idx_admins_active ON admins(active);
CREATE INDEX IF NOT EXISTS idx_broadcasts_sender ON broadcasts(sender_id);
CREATE INDEX IF NOT EXISTS idx_broadcasts_status ON broadcasts(status);
CREATE INDEX IF NOT EXISTS idx_broadcast_logs_broadcast ON broadcast_logs(broadcast_id);
CREATE INDEX IF NOT EXISTS idx_rewards_user ON rewards(user_id);
CREATE INDEX IF NOT EXISTS idx_rewards_status ON rewards(status);
CREATE INDEX IF NOT EXISTS idx_admin_logs_admin ON admin_logs(admin_id);
CREATE INDEX IF NOT EXISTS idx_admin_logs_action ON admin_logs(action);
CREATE INDEX IF NOT EXISTS idx_admin_logs_created ON admin_logs(created_at DESC);