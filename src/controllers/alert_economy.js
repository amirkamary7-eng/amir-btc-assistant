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
  async function handleUpdateConfig(request, env, alertType) {
    const { error: authErr } = await requireAdmin(request, env, 'manage_rewards');
    if (authErr) return authErr;
    const body = await request.json().catch(() => ({}));
    try {
      const config = await alertEconomyRepo.updateConfig(env, alertType, body);
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
      const status = await alertEconomyRepo.getQuotaStatus(env, authState.user.id, alertType);
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
