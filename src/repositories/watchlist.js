/**
 * Watchlist Repository — Data Access Layer
 *
 * Responsible ONLY for database operations related to user watchlists.
 * No HTTP concerns, no business logic — just SQL queries and data normalization.
 *
 * Dependencies are injected via the factory function to avoid circular imports.
 */
export function createWatchlistRepository(deps) {
  const { queryDb, ensureUserRow } = deps;

  /**
   * Retrieve all watchlist symbols for a user, ordered by position.
   * Returns an array of uppercase symbol strings.
   */
  async function getSymbols(env, userId) {
    const result = await queryDb(
      env,
      `
        SELECT symbol
        FROM watchlist_items
        WHERE user_id = $1
        ORDER BY position ASC, id ASC
      `,
      [String(userId)],
    );
    return result.rows.map((row) => String(row.symbol).toUpperCase());
  }

  /**
   * Replace all watchlist items for a user with the given symbols.
   * Ensures the user row exists, deletes old items, inserts new ones,
   * and returns the freshly-read symbol list.
   */
  async function replace(env, userId, symbols) {
    await ensureUserRow(env, userId);
    await queryDb(env, 'DELETE FROM watchlist_items WHERE user_id = $1', [String(userId)]);
    if (symbols.length > 0) {
      const params = [String(userId)];
      const values = symbols.map((_, i) => `($1, $${i + 2}, $${i + 2 + symbols.length}, NOW())`);
      for (const sym of symbols) params.push(sym);
      for (let i = 0; i < symbols.length; i++) params.push(i);
      await queryDb(
        env,
        `INSERT INTO watchlist_items (user_id, symbol, position, created_at) VALUES ${values.join(', ')}`,
        params,
      );
    }
    await queryDb(env, 'UPDATE users SET updated_at = NOW() WHERE telegram_id = $1', [String(userId)]);
    return getSymbols(env, userId);
  }

  return Object.freeze({ getSymbols, replace });
}