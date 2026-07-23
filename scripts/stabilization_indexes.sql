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

-- 5. [REMOVED] Sessions: online count uses KV cache only. No SQL queries hit this table.
-- CREATE INDEX IF NOT EXISTS idx_sessions_last_heartbeat ON sessions (last_heartbeat);

-- 6. Tickets: user's ticket list
CREATE INDEX IF NOT EXISTS idx_tickets_user_id ON tickets (user_id);

-- 7. [REMOVED] Notifications: column is `read_status`, not `is_read`.
--    Runtime ensureTable() in src/repositories/notifications.js already creates:
--    - idx_notifications_user_created ON notifications(user_id, created_at DESC)
--    - idx_notifications_user_unread ON notifications(user_id) WHERE read_status = FALSE
-- CREATE INDEX IF NOT EXISTS idx_notifications_user_read ON notifications (user_id, is_read, created_at DESC);

-- 8. Referrals: lookup by invitee_id (channel verification + reward flow in worker-proxy.js)
CREATE INDEX IF NOT EXISTS idx_referrals_invitee ON referrals (invitee_id);

-- 9. [NEW] Referrals: lookup by inviter_id (stats page, wallet referral history in src/repositories/referrals.js)
CREATE INDEX IF NOT EXISTS idx_referrals_inviter ON referrals (inviter_id);