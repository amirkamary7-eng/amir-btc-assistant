/**
 * Alert Economy Controller — Admin + User endpoints
 *
 * Admin: manage alert config (enable/disable, free_per_day, cost_per_extra)
 * User: check quota status
 * Internal: checkQuota + incrementQuota used by alert creation flow
 */

export function createAlertEconomyHandlers(deps) {
  const {
    jsonResponse,
    authenticateTelegramRequest,
    requireAdmin,
    safeDbErrorResponse,
    safeError,
    isDatabaseConfigured,
    alertEconomyRepo,
    economyService,
    membershipAuthority,
  } = deps;

  // ── Admin: Get all alert configs ──
  async function handleListConfigs(request, env) {
    const { error: authErr } = await requireAdmin(request, env, 'manage_rewards');
    if (authErr) return authErr;
    try {
      const configs = await alertEconomyRepo.getAllConfigs(env);
      return jsonResponse({ status: 'success', configs }, {}, env);
    } catch (e) { return safeDbErrorResponse(e, {}, env); }
  }

  // ── Admin: Update alert config ──
  // FIX: add input validation — allowlist alert types, validate numeric fields.
  async function handleUpdateConfig(request, env, alertType) {
    const { error: authErr } = await requireAdmin(request, env, 'manage_rewards');
    if (authErr) return authErr;
    // FIX: validate alertType against allowlist
    const ALLOWED_TYPES = ['price_alert', 'calendar_alert', 'breaking_news'];
    if (!ALLOWED_TYPES.includes(String(alertType))) {
      return jsonResponse({ status: 'error', message: 'Invalid alert type' }, { status: 422 }, env);
    }
    const body = await request.json().catch(() => ({}));
    // FIX: validate numeric fields
    const validated = {};
    const numFields = ['free_per_day', 'cost_per_extra', 'premium_free_per_day'];
    for (const f of numFields) {
      if (body[f] !== undefined) {
        const n = Number(body[f]);
        if (!Number.isFinite(n) || n < 0 || n > 1000) {
          return jsonResponse({ status: 'error', message: `Invalid value for ${f}` }, { status: 422 }, env);
        }
        validated[f] = Math.floor(n);
      }
    }
    if (body.is_enabled !== undefined) validated.is_enabled = Boolean(body.is_enabled);
    try {
      const config = await alertEconomyRepo.updateConfig(env, alertType, validated);
      return jsonResponse({ status: 'success', config }, {}, env);
    } catch (e) { return safeDbErrorResponse(e, {}, env); }
  }

  // ── Admin: Get dashboard ──
  async function handleDashboard(request, env) {
    const { error: authErr } = await requireAdmin(request, env, 'manage_rewards');
    if (authErr) return authErr;
    try {
      const dashboard = await alertEconomyRepo.getDashboard(env);
      return jsonResponse({ status: 'success', dashboard }, {}, env);
    } catch (e) { return safeDbErrorResponse(e, {}, env); }
  }

  // ── User: Get quota status ──
  async function handleQuotaStatus(request, env) {
    const authState = await authenticateTelegramRequest(request, env);
    if (authState.error) return authState.error;
    try {
      const url = new URL(request.url);
      const alertType = url.searchParams.get('type') || 'price_alert';
      // FIX: resolve premium tier so getQuotaStatus uses the correct quota
      let isPremium = false;
      if (membershipAuthority) {
        try { isPremium = await membershipAuthority.isPremium(env, authState.user.id); } catch { isPremium = false; }
      }
      const status = await alertEconomyRepo.getQuotaStatus(env, authState.user.id, alertType, isPremium);
      return jsonResponse({ status: 'success', ...status }, {}, env);
    } catch (e) { return safeDbErrorResponse(e, {}, env); }
  }

  return Object.freeze({
    handleListConfigs,
    handleUpdateConfig,
    handleDashboard,
    handleQuotaStatus,
  });
}
