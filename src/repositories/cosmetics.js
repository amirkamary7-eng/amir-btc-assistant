/**
 * Cosmetics Repository — Profile Cosmetics catalog + ownership.
 *
 * Ownership model:
 *   - One row per (user, cosmetic) — UNIQUE prevents re-purchase
 *   - Only ONE active cosmetic per user — partial unique index on is_active=TRUE
 *   - Activation is atomic: deactivate previous + activate new in one transaction
 */

export function createCosmeticsRepository(deps) {
  const { queryDb, queryDbTransaction, isDatabaseConfigured } = deps;

  let _schemaVerified = false;

  async function ensureSchema(env) {
    if (_schemaVerified) return;
    try {
      await queryDb(env, 'SELECT 1 FROM profile_cosmetics LIMIT 1');
      _schemaVerified = true;
    } catch (e) {
      console.warn('[cosmetics] schema check failed — run scripts/membership-cosmetics-schema.sql:', e.message || e);
    }
  }

  async function getCatalog(env) {
    if (!isDatabaseConfigured(env)) return [];
    try {
      const result = await queryDb(env,
        `SELECT id, cosmetic_key, title, description, rarity, type, token_cost,
                premium_required, active, preview_url, metadata
         FROM profile_cosmetics
         WHERE active = TRUE
         ORDER BY token_cost ASC`
      );
      return result.rows;
    } catch (e) {
      console.warn('[cosmetics] getCatalog failed:', e.message || e);
      return [];
    }
  }

  async function getById(env, cosmeticId) {
    try {
      const result = await queryDb(env,
        `SELECT id, cosmetic_key, title, description, rarity, type, token_cost,
                premium_required, active, preview_url, metadata
         FROM profile_cosmetics
         WHERE id = $1 AND active = TRUE
         LIMIT 1`,
        [String(cosmeticId)]
      );
      return result.rows[0] || null;
    } catch (e) {
      console.warn('[cosmetics] getById failed:', e.message || e);
      return null;
    }
  }

  async function getOwned(env, userId) {
    if (!isDatabaseConfigured(env)) return [];
    try {
      const result = await queryDb(env,
        `SELECT o.cosmetic_id, o.tokens_spent, o.is_active, o.purchased_at, o.activated_at,
                c.cosmetic_key, c.title, c.rarity, c.type, c.metadata
         FROM user_cosmetic_ownership o
         JOIN profile_cosmetics c ON c.id = o.cosmetic_id
         WHERE o.user_id = $1
         ORDER BY o.purchased_at DESC`,
        [String(userId)]
      );
      return result.rows;
    } catch (e) {
      console.warn('[cosmetics] getOwned failed:', e.message || e);
      return [];
    }
  }

  async function getActive(env, userId) {
    if (!isDatabaseConfigured(env)) return null;
    try {
      const result = await queryDb(env,
        `SELECT o.cosmetic_id, c.cosmetic_key, c.title, c.rarity, c.type, c.metadata,
                o.activated_at
         FROM user_cosmetic_ownership o
         JOIN profile_cosmetics c ON c.id = o.cosmetic_id
         WHERE o.user_id = $1 AND o.is_active = TRUE
         LIMIT 1`,
        [String(userId)]
      );
      return result.rows[0] || null;
    } catch (e) {
      console.warn('[cosmetics] getActive failed:', e.message || e);
      return null;
    }
  }

  async function getOwnership(env, userId, cosmeticId) {
    try {
      const result = await queryDb(env,
        `SELECT id, cosmetic_id, tokens_spent, is_active, purchased_at
         FROM user_cosmetic_ownership
         WHERE user_id = $1 AND cosmetic_id = $2
         LIMIT 1`,
        [String(userId), String(cosmeticId)]
      );
      return result.rows[0] || null;
    } catch (e) {
      console.warn('[cosmetics] getOwnership failed:', e.message || e);
      return null;
    }
  }

  async function createOwnership(env, userId, cosmeticId, tokensSpent) {
    try {
      const result = await queryDb(env,
        `INSERT INTO user_cosmetic_ownership (user_id, cosmetic_id, tokens_spent)
         VALUES ($1, $2, $3)
         ON CONFLICT (user_id, cosmetic_id) DO NOTHING
         RETURNING id, cosmetic_id, tokens_spent, is_active, purchased_at`,
        [String(userId), String(cosmeticId), Number(tokensSpent) || 0]
      );
      if (result.rows.length > 0) {
        return { ownership: result.rows[0], created: true };
      }
      const existing = await getOwnership(env, userId, cosmeticId);
      return { ownership: existing, created: false };
    } catch (e) {
      console.warn('[cosmetics] createOwnership failed:', e.message || e);
      throw e;
    }
  }

  async function activate(env, userId, cosmeticId) {
    try {
      const results = await queryDbTransaction(env, [
        {
          sql: `UPDATE user_cosmetic_ownership
                SET is_active = FALSE, activated_at = NULL, updated_at = NOW()
                WHERE user_id = $1 AND is_active = TRUE`,
          params: [String(userId)],
        },
        {
          sql: `UPDATE user_cosmetic_ownership
                SET is_active = TRUE, activated_at = NOW(), updated_at = NOW()
                WHERE user_id = $1 AND cosmetic_id = $2
                RETURNING id`,
          params: [String(userId), String(cosmeticId)],
        },
      ]);
      return results[1]?.rows?.length > 0;
    } catch (e) {
      console.warn('[cosmetics] activate failed:', e.message || e);
      return false;
    }
  }

  return Object.freeze({
    ensureSchema,
    getCatalog,
    getById,
    getOwned,
    getActive,
    getOwnership,
    createOwnership,
    activate,
  });
}
