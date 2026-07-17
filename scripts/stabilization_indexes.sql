-- Stabilization Phase 4: Performance Indexes
-- These indexes cover the most frequently queried patterns.
-- Safe to run multiple times (IF NOT EXISTS).

-- 1. Watchlist: queried by user_id on every page load + tab switch
CREATE INDEX IF NOT EXISTS idx_watchlist_items_user_id ON watchlist_items (user_id);

-- 2. Price alerts: list active alerts for user (every 15s poll)
CREATE INDEX IF NOT EXISTS idx_price_alerts_user_status ON price_alerts (user_id, status);

-- 3. Price alerts: dedup check on create (user_id, symbol, price, direction)
CREATE INDEX IF NOT EXISTS idx_price_alerts_dedup ON price_alerts (user_id, symbol, price, direction);

-- 4. Token transactions: wallet history (user_id, created_at DESC)
CREATE INDEX IF NOT EXISTS idx_token_transactions_user_created ON token_transactions (user_id, created_at DESC);

-- 5. Sessions: online count + cleanup (last_heartbeat)
CREATE INDEX IF NOT EXISTS idx_sessions_last_heartbeat ON sessions (last_heartbeat);

-- 6. Tickets: user's ticket list
CREATE INDEX IF NOT EXISTS idx_tickets_user_id ON tickets (user_id);

-- 7. Notifications: user's notifications
CREATE INDEX IF NOT EXISTS idx_notifications_user_read ON notifications (user_id, is_read, created_at DESC);

-- 8. Referrals: lookup by invitee_id (channel verification flow)
CREATE INDEX IF NOT EXISTS idx_referrals_invitee ON referrals (invitee_id);