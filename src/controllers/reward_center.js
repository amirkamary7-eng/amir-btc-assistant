/**
 * Reward Center Controller — HTTP Layer
 *
 * Admin endpoints for managing the entire Reward Center:
 * - Overview / Analytics
 * - Lucky Wheel config + rewards CRUD
 * - Reward Library CRUD
 * - Referral Reward Tiers CRUD
 * - Mission Rewards CRUD
 * - Campaigns CRUD
 * - Emergency Controls
 *
 * All endpoints require admin authentication with 'manage_rewards' permission.
 */

export function createRewardCenterHandlers(deps) {
  const {
    jsonResponse,
    requireAdmin,
    readJsonBody,
    safeDbErrorResponse,
    safeError,
    isDatabaseConfigured,
    buildBodyFieldValidationError,
    normalizeOptionalString,
    getClientIp,
    adminRepo: logAdminActionRepo,
    rewardCenterRepo,
  } = deps;

  function _log(env, admin, action, targetType, targetId, details) {
    if (!logAdminActionRepo?.logAdminAction) return Promise.resolve();
    return logAdminActionRepo.logAdminAction(env, {
      admin_id: String(admin.telegram_id),
      action, target_type: targetType, target_id: String(targetId),
      details: details || {}, ip: null,
    }).catch(() => {});
  }

  // ═══════════════════════════════════════════════════════════
  // OVERVIEW
  // ═══════════════════════════════════════════════════════════

  async function handleOverview(request, env) {
    const { error: authErr } = await requireAdmin(request, env, 'manage_rewards');
    if (authErr) return authErr;
    try {
      const data = await rewardCenterRepo.getOverview(env);
      return jsonResponse({ status: 'success', overview: data }, {}, env);
    } catch (e) {
      console.warn(safeError('reward-center-overview', e));
      return safeDbErrorResponse(e, {}, env);
    }
  }

  // ═══════════════════════════════════════════════════════════
  // ANALYTICS
  // ═══════════════════════════════════════════════════════════

  async function handleAnalytics(request, env) {
    const { error: authErr } = await requireAdmin(request, env, 'manage_rewards');
    if (authErr) return authErr;
    try {
      const url = new URL(request.url);
      const range = url.searchParams.get('range') || '7d';
      const data = await rewardCenterRepo.getAnalytics(env, { range });
      return jsonResponse({ status: 'success', analytics: data }, {}, env);
    } catch (e) {
      console.warn(safeError('reward-center-analytics', e));
      return safeDbErrorResponse(e, {}, env);
    }
  }

  // ═══════════════════════════════════════════════════════════
  // WHEEL CONFIG
  // ═══════════════════════════════════════════════════════════

  async function handleGetWheelConfig(request, env) {
    const { error: authErr } = await requireAdmin(request, env, 'manage_rewards');
    if (authErr) return authErr;
    try {
      const config = await rewardCenterRepo.getWheelConfig(env);
      return jsonResponse({ status: 'success', config }, {}, env);
    } catch (e) {
      return safeDbErrorResponse(e, {}, env);
    }
  }

  async function handleUpdateWheelConfig(request, env) {
    const { error: authErr, admin } = await requireAdmin(request, env, 'manage_rewards');
    if (authErr) return authErr;
    const bodyResult = await readJsonBody(request, 102400, env);
    if (bodyResult.error) return bodyResult.error;
    const payload = bodyResult.payload;
    if (!payload || typeof payload !== 'object') {
      return jsonResponse(buildBodyFieldValidationError('body', 'type_error', 'Input should be a valid object', payload), { status: 422 }, env);
    }
    try {
      const config = await rewardCenterRepo.updateWheelConfig(env, payload);
      await _log(env, admin, 'update_wheel_config', 'wheel_config', '1', payload);
      return jsonResponse({ status: 'success', config }, {}, env);
    } catch (e) {
      return safeDbErrorResponse(e, {}, env);
    }
  }

  // ═══════════════════════════════════════════════════════════
  // WHEEL REWARDS CRUD
  // ═══════════════════════════════════════════════════════════

  async function handleListWheelRewards(request, env) {
    const { error: authErr } = await requireAdmin(request, env, 'manage_rewards');
    if (authErr) return authErr;
    try {
      const url = new URL(request.url);
      const campaignId = url.searchParams.get('campaign_id') || null;
      const activeOnly = url.searchParams.get('active') === 'true';
      const rewards = await rewardCenterRepo.listWheelRewards(env, { campaignId, activeOnly });
      return jsonResponse({ status: 'success', rewards, total: rewards.length }, {}, env);
    } catch (e) { return safeDbErrorResponse(e, {}, env); }
  }

  async function handleCreateWheelReward(request, env) {
    const { error: authErr, admin } = await requireAdmin(request, env, 'manage_rewards');
    if (authErr) return authErr;
    const bodyResult = await readJsonBody(request, 102400, env);
    if (bodyResult.error) return bodyResult.error;
    const payload = bodyResult.payload;
    try {
      const reward = await rewardCenterRepo.createWheelReward(env, payload);
      await _log(env, admin, 'create_wheel_reward', 'wheel_reward', reward?.id, payload);
      return jsonResponse({ status: 'success', reward }, {}, env);
    } catch (e) { return safeDbErrorResponse(e, {}, env); }
  }

  async function handleUpdateWheelReward(request, env, rewardId) {
    const { error: authErr, admin } = await requireAdmin(request, env, 'manage_rewards');
    if (authErr) return authErr;
    const bodyResult = await readJsonBody(request, 102400, env);
    if (bodyResult.error) return bodyResult.error;
    try {
      const reward = await rewardCenterRepo.updateWheelReward(env, rewardId, bodyResult.payload);
      if (!reward) return jsonResponse({ status: 'error', message: 'Reward not found' }, { status: 404 }, env);
      await _log(env, admin, 'update_wheel_reward', 'wheel_reward', rewardId, bodyResult.payload);
      return jsonResponse({ status: 'success', reward }, {}, env);
    } catch (e) { return safeDbErrorResponse(e, {}, env); }
  }

  async function handleDeleteWheelReward(request, env, rewardId) {
    const { error: authErr, admin } = await requireAdmin(request, env, 'manage_rewards');
    if (authErr) return authErr;
    try {
      const ok = await rewardCenterRepo.deleteWheelReward(env, rewardId);
      if (!ok) return jsonResponse({ status: 'error', message: 'Reward not found' }, { status: 404 }, env);
      await _log(env, admin, 'delete_wheel_reward', 'wheel_reward', rewardId, {});
      return jsonResponse({ status: 'success' }, {}, env);
    } catch (e) { return safeDbErrorResponse(e, {}, env); }
  }

  // ═══════════════════════════════════════════════════════════
  // REWARD LIBRARY CRUD
  // ═══════════════════════════════════════════════════════════

  async function handleListLibrary(request, env) {
    const { error: authErr } = await requireAdmin(request, env, 'manage_rewards');
    if (authErr) return authErr;
    try {
      const url = new URL(request.url);
      const category = url.searchParams.get('category') || null;
      const activeOnly = url.searchParams.get('active') === 'true';
      const items = await rewardCenterRepo.listRewardLibrary(env, { category, activeOnly });
      return jsonResponse({ status: 'success', library: items, total: items.length }, {}, env);
    } catch (e) { return safeDbErrorResponse(e, {}, env); }
  }

  async function handleCreateLibraryItem(request, env) {
    const { error: authErr, admin } = await requireAdmin(request, env, 'manage_rewards');
    if (authErr) return authErr;
    const bodyResult = await readJsonBody(request, 102400, env);
    if (bodyResult.error) return bodyResult.error;
    try {
      const item = await rewardCenterRepo.createLibraryItem(env, bodyResult.payload);
      await _log(env, admin, 'create_library_item', 'reward_library', item?.id, bodyResult.payload);
      return jsonResponse({ status: 'success', item }, {}, env);
    } catch (e) { return safeDbErrorResponse(e, {}, env); }
  }

  async function handleUpdateLibraryItem(request, env, itemId) {
    const { error: authErr, admin } = await requireAdmin(request, env, 'manage_rewards');
    if (authErr) return authErr;
    const bodyResult = await readJsonBody(request, 102400, env);
    if (bodyResult.error) return bodyResult.error;
    try {
      const item = await rewardCenterRepo.updateLibraryItem(env, itemId, bodyResult.payload);
      if (!item) return jsonResponse({ status: 'error', message: 'Item not found' }, { status: 404 }, env);
      await _log(env, admin, 'update_library_item', 'reward_library', itemId, bodyResult.payload);
      return jsonResponse({ status: 'success', item }, {}, env);
    } catch (e) { return safeDbErrorResponse(e, {}, env); }
  }

  async function handleDeleteLibraryItem(request, env, itemId) {
    const { error: authErr, admin } = await requireAdmin(request, env, 'manage_rewards');
    if (authErr) return authErr;
    try {
      const ok = await rewardCenterRepo.deleteLibraryItem(env, itemId);
      if (!ok) return jsonResponse({ status: 'error', message: 'Item not found' }, { status: 404 }, env);
      await _log(env, admin, 'delete_library_item', 'reward_library', itemId, {});
      return jsonResponse({ status: 'success' }, {}, env);
    } catch (e) { return safeDbErrorResponse(e, {}, env); }
  }

  // ═══════════════════════════════════════════════════════════
  // REFERRAL REWARD TIERS CRUD
  // ═══════════════════════════════════════════════════════════

  async function handleListReferralTiers(request, env) {
    const { error: authErr } = await requireAdmin(request, env, 'manage_rewards');
    if (authErr) return authErr;
    try {
      const tiers = await rewardCenterRepo.listReferralTiers(env);
      return jsonResponse({ status: 'success', tiers, total: tiers.length }, {}, env);
    } catch (e) { return safeDbErrorResponse(e, {}, env); }
  }

  async function handleCreateReferralTier(request, env) {
    const { error: authErr, admin } = await requireAdmin(request, env, 'manage_rewards');
    if (authErr) return authErr;
    const bodyResult = await readJsonBody(request, 102400, env);
    if (bodyResult.error) return bodyResult.error;
    try {
      const tier = await rewardCenterRepo.createReferralTier(env, bodyResult.payload);
      await _log(env, admin, 'create_referral_tier', 'referral_tier', tier?.id, bodyResult.payload);
      return jsonResponse({ status: 'success', tier }, {}, env);
    } catch (e) { return safeDbErrorResponse(e, {}, env); }
  }

  async function handleUpdateReferralTier(request, env, tierId) {
    const { error: authErr, admin } = await requireAdmin(request, env, 'manage_rewards');
    if (authErr) return authErr;
    const bodyResult = await readJsonBody(request, 102400, env);
    if (bodyResult.error) return bodyResult.error;
    try {
      const tier = await rewardCenterRepo.updateReferralTier(env, tierId, bodyResult.payload);
      if (!tier) return jsonResponse({ status: 'error', message: 'Tier not found' }, { status: 404 }, env);
      await _log(env, admin, 'update_referral_tier', 'referral_tier', tierId, bodyResult.payload);
      return jsonResponse({ status: 'success', tier }, {}, env);
    } catch (e) { return safeDbErrorResponse(e, {}, env); }
  }

  async function handleDeleteReferralTier(request, env, tierId) {
    const { error: authErr, admin } = await requireAdmin(request, env, 'manage_rewards');
    if (authErr) return authErr;
    try {
      const ok = await rewardCenterRepo.deleteReferralTier(env, tierId);
      if (!ok) return jsonResponse({ status: 'error', message: 'Tier not found' }, { status: 404 }, env);
      await _log(env, admin, 'delete_referral_tier', 'referral_tier', tierId, {});
      return jsonResponse({ status: 'success' }, {}, env);
    } catch (e) { return safeDbErrorResponse(e, {}, env); }
  }

  // ═══════════════════════════════════════════════════════════
  // MISSION REWARDS CRUD
  // ═══════════════════════════════════════════════════════════

  async function handleListMissionRewards(request, env) {
    const { error: authErr } = await requireAdmin(request, env, 'manage_rewards');
    if (authErr) return authErr;
    try {
      const missions = await rewardCenterRepo.listMissionRewards(env);
      return jsonResponse({ status: 'success', missions, total: missions.length }, {}, env);
    } catch (e) { return safeDbErrorResponse(e, {}, env); }
  }

  async function handleCreateMissionReward(request, env) {
    const { error: authErr, admin } = await requireAdmin(request, env, 'manage_rewards');
    if (authErr) return authErr;
    const bodyResult = await readJsonBody(request, 102400, env);
    if (bodyResult.error) return bodyResult.error;
    try {
      const mission = await rewardCenterRepo.createMissionReward(env, bodyResult.payload);
      await _log(env, admin, 'create_mission_reward', 'mission_reward', mission?.id, bodyResult.payload);
      return jsonResponse({ status: 'success', mission }, {}, env);
    } catch (e) { return safeDbErrorResponse(e, {}, env); }
  }

  async function handleUpdateMissionReward(request, env, missionId) {
    const { error: authErr, admin } = await requireAdmin(request, env, 'manage_rewards');
    if (authErr) return authErr;
    const bodyResult = await readJsonBody(request, 102400, env);
    if (bodyResult.error) return bodyResult.error;
    try {
      const mission = await rewardCenterRepo.updateMissionReward(env, missionId, bodyResult.payload);
      if (!mission) return jsonResponse({ status: 'error', message: 'Mission not found' }, { status: 404 }, env);
      await _log(env, admin, 'update_mission_reward', 'mission_reward', missionId, bodyResult.payload);
      return jsonResponse({ status: 'success', mission }, {}, env);
    } catch (e) { return safeDbErrorResponse(e, {}, env); }
  }

  async function handleDeleteMissionReward(request, env, missionId) {
    const { error: authErr, admin } = await requireAdmin(request, env, 'manage_rewards');
    if (authErr) return authErr;
    try {
      const ok = await rewardCenterRepo.deleteMissionReward(env, missionId);
      if (!ok) return jsonResponse({ status: 'error', message: 'Mission not found' }, { status: 404 }, env);
      await _log(env, admin, 'delete_mission_reward', 'mission_reward', missionId, {});
      return jsonResponse({ status: 'success' }, {}, env);
    } catch (e) { return safeDbErrorResponse(e, {}, env); }
  }

  // ═══════════════════════════════════════════════════════════
  // CAMPAIGNS CRUD
  // ═══════════════════════════════════════════════════════════

  async function handleListCampaigns(request, env) {
    const { error: authErr } = await requireAdmin(request, env, 'manage_rewards');
    if (authErr) return authErr;
    try {
      const url = new URL(request.url);
      const activeOnly = url.searchParams.get('active') === 'true';
      const campaigns = await rewardCenterRepo.listCampaigns(env, { activeOnly });
      return jsonResponse({ status: 'success', campaigns, total: campaigns.length }, {}, env);
    } catch (e) { return safeDbErrorResponse(e, {}, env); }
  }

  async function handleCreateCampaign(request, env) {
    const { error: authErr, admin } = await requireAdmin(request, env, 'manage_rewards');
    if (authErr) return authErr;
    const bodyResult = await readJsonBody(request, 102400, env);
    if (bodyResult.error) return bodyResult.error;
    try {
      const campaign = await rewardCenterRepo.createCampaign(env, bodyResult.payload);
      await _log(env, admin, 'create_campaign', 'campaign', campaign?.id, bodyResult.payload);
      return jsonResponse({ status: 'success', campaign }, {}, env);
    } catch (e) { return safeDbErrorResponse(e, {}, env); }
  }

  async function handleUpdateCampaign(request, env, campaignId) {
    const { error: authErr, admin } = await requireAdmin(request, env, 'manage_rewards');
    if (authErr) return authErr;
    const bodyResult = await readJsonBody(request, 102400, env);
    if (bodyResult.error) return bodyResult.error;
    try {
      const campaign = await rewardCenterRepo.updateCampaign(env, campaignId, bodyResult.payload);
      if (!campaign) return jsonResponse({ status: 'error', message: 'Campaign not found' }, { status: 404 }, env);
      await _log(env, admin, 'update_campaign', 'campaign', campaignId, bodyResult.payload);
      return jsonResponse({ status: 'success', campaign }, {}, env);
    } catch (e) { return safeDbErrorResponse(e, {}, env); }
  }

  async function handleDeleteCampaign(request, env, campaignId) {
    const { error: authErr, admin } = await requireAdmin(request, env, 'manage_rewards');
    if (authErr) return authErr;
    try {
      const ok = await rewardCenterRepo.deleteCampaign(env, campaignId);
      if (!ok) return jsonResponse({ status: 'error', message: 'Campaign not found' }, { status: 404 }, env);
      await _log(env, admin, 'delete_campaign', 'campaign', campaignId, {});
      return jsonResponse({ status: 'success' }, {}, env);
    } catch (e) { return safeDbErrorResponse(e, {}, env); }
  }

  // ═══════════════════════════════════════════════════════════
  // EMERGENCY CONTROLS
  // ═══════════════════════════════════════════════════════════

  async function handleGetEmergencyControls(request, env) {
    const { error: authErr } = await requireAdmin(request, env, 'manage_rewards');
    if (authErr) return authErr;
    try {
      const controls = await rewardCenterRepo.getEmergencyControls(env);
      return jsonResponse({ status: 'success', controls }, {}, env);
    } catch (e) { return safeDbErrorResponse(e, {}, env); }
  }

  async function handleUpdateEmergencyControls(request, env) {
    const { error: authErr, admin } = await requireAdmin(request, env, 'manage_rewards');
    if (authErr) return authErr;
    const bodyResult = await readJsonBody(request, 102400, env);
    if (bodyResult.error) return bodyResult.error;
    try {
      const controls = await rewardCenterRepo.updateEmergencyControls(env, bodyResult.payload);
      await _log(env, admin, 'update_emergency_controls', 'emergency_controls', '1', bodyResult.payload);
      return jsonResponse({ status: 'success', controls }, {}, env);
    } catch (e) { return safeDbErrorResponse(e, {}, env); }
  }

  return Object.freeze({
    handleOverview,
    handleAnalytics,
    handleGetWheelConfig,
    handleUpdateWheelConfig,
    handleListWheelRewards,
    handleCreateWheelReward,
    handleUpdateWheelReward,
    handleDeleteWheelReward,
    handleListLibrary,
    handleCreateLibraryItem,
    handleUpdateLibraryItem,
    handleDeleteLibraryItem,
    handleListReferralTiers,
    handleCreateReferralTier,
    handleUpdateReferralTier,
    handleDeleteReferralTier,
    handleListMissionRewards,
    handleCreateMissionReward,
    handleUpdateMissionReward,
    handleDeleteMissionReward,
    handleListCampaigns,
    handleCreateCampaign,
    handleUpdateCampaign,
    handleDeleteCampaign,
    handleGetEmergencyControls,
    handleUpdateEmergencyControls,
  });
}
