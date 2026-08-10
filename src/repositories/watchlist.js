/**
 * Watchlist Repository — Data Access Layer
 *
 * Responsible ONLY for database operations related to user watchlists.
 * No HTTP concerns, no business logic — just SQL queries and data normalization.
 *
 * Dependencies are injected via the factory function to avoid circular imports.
 */
export function createWatchlistRepository(deps) {
  const { queryDb, queryDbTransaction, ensureUserRow } = deps;

  // PHASE 2 SAFE OPTIMIZATION: Per-user watchlist cache with 30s TTL.
  // getSymbols is called on every bootstrap + /api/users/me + /api/watchlist GET.
  // Watchlist changes rarely (only on PUT /api/watchlist). Cache invalidated in replace().
  // FIFO eviction (max 500 users) to bound memory.
  const _WATCHLIST_CACHE_TTL_MS = 30 * 1000; // 30 seconds
  const _WATCHLIST_CACHE_MAX = 500;
  const _watchlistCache = new Map(); // userId -> { value, expiresAt }

  function _invalidateWatchlistCache(userId) {
    if (userId) {
      _watchlistCache.delete(String(userId));
    } else {
      _watchlistCache.clear();
    }
  }

  function _setWatchlistCache(userId, value) {
    const key = String(userId);
    if (_watchlistCache.size >= _WATCHLIST_CACHE_MAX) {
      // FIFO eviction — delete the oldest entry
      const firstKey = _watchlistCache.keys().next().value;
      if (firstKey) _watchlistCache.delete(firstKey);
    }
    _watchlistCache.set(key, { value, expiresAt: Date.now() + _WATCHLIST_CACHE_TTL_MS });
  }

  /**
   * Retrieve all watchlist symbols for a user, ordered by position.
   * Returns an array of uppercase symbol strings.
   */
  async function getSymbols(env, userId) {
    // PHASE 2 SAFE OPTIMIZATION: Check per-user cache first (30s TTL).
    const tid = String(userId);
    const now = Date.now();
    const cached = _watchlistCache.get(tid);
    if (cached !== undefined && now < cached.expiresAt) {
      return cached.value;
    }

    const result = await queryDb(
      env,
      `
        SELECT symbol
        FROM watchlist_items
        WHERE user_id = $1
        ORDER BY position ASC, id ASC
      `,
      [tid],
    );
    const symbols = result.rows.map((row) => String(row.symbol).toUpperCase());
    _setWatchlistCache(tid, symbols);
    return symbols;
  }

  /**
   * Replace all watchlist items for a user with the given symbols.
   * Ensures the user row exists, deletes old items, inserts new ones,
   * and returns the freshly-read symbol list.
   */
  async function replace(env, userId, symbols) {
    await ensureUserRow(env, userId);

    // DB-005 FIX: Wrap DELETE + INSERT + UPDATE in a single transaction.
    // Previously: DELETE committed first, then INSERT ran separately.
    // If INSERT failed (constraint, DB error), the user's watchlist was
    // permanently empty (DELETE already committed). Now: all-or-nothing.
    const queries = [
      { sql: 'DELETE FROM watchlist_items WHERE user_id = $1', params: [String(userId)] },
    ];

    if (symbols.length > 0) {
      const params = [String(userId)];
      const values = symbols.map((_, i) => `($1, $${i + 2}, $${i + 2 + symbols.length}, NOW())`);
      for (const sym of symbols) params.push(sym);
      for (let i = 0; i < symbols.length; i++) params.push(i);
      queries.push({
        sql: `INSERT INTO watchlist_items (user_id, symbol, position, created_at) VALUES ${values.join(', ')}`,
        params,
      });
    }

    queries.push({
      sql: 'UPDATE users SET updated_at = NOW() WHERE telegram_id = $1',
      params: [String(userId)],
    });

    await queryDbTransaction(env, queries);

    // PHASE 2 SAFE OPTIMIZATION: Invalidate cache for this user, then populate
    // with the fresh data from getSymbols (avoids 1 extra DB read on next access).
    _invalidateWatchlistCache(userId);
    return getSymbols(env, userId);
  }

  return Object.freeze({ getSymbols, replace });
}