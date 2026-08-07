/**
 * NotificationService — SINGLE ENTRY POINT for all notification producers.
 *
 * Phase 1 (Foundation): This service is a thin wrapper around the existing
 * notificationPlatformRepo.dispatch(). It establishes a single, centralized
 * entry point so that all producers call NotificationService.create() instead
 * of reaching directly into the repository.
 *
 * Future phases will migrate the internal logic (queue, idempotency, crash
 * recovery, etc.) INTO this service, but the public API (create) will remain
 * stable — producers will not need to change again.
 *
 * @param {object} deps
 *   - notificationPlatformRepo: the repository with dispatch/sendNotification
 */
export function createNotificationService(deps) {
  const { notificationPlatformRepo } = deps;

  if (!notificationPlatformRepo) {
    throw new Error('createNotificationService: notificationPlatformRepo is required');
  }

  /**
   * Create and dispatch a notification.
   *
   * This is the SINGLE ENTRY POINT that all producers must call.
   * Internally delegates to notificationPlatformRepo.dispatch() which:
   *   1. Resolves template (if templateKey provided)
   *   2. Checks user preference (ch_<category>)
   *   3. Inserts in-app notification
   *   4. Enqueues Telegram delivery
   *
   * @param {object} env - Worker env
   * @param {object} opts
   *   @param {string} opts.userId         - Recipient Telegram ID (required)
   *   @param {string} [opts.templateKey]  - Resolve title/message/category from template
   *   @param {string} [opts.category]     - Notification category (default 'system')
   *   @param {string} [opts.title]        - Notification title
   *   @param {string} [opts.message]      - Notification body
   *   @param {string} [opts.priority]     - low|medium|high|critical (default 'medium')
   *   @param {string} [opts.channel]      - mini_app|telegram|both (default per category)
   *   @param {object} [opts.metadata]     - Arbitrary JSON metadata
   *   @param {string} [opts.icon]         - Icon name
   *   @param {string} [opts.actionUrl]    - Deep-link/action URL
   *   @param {object} [opts.telegramExtra] - Rich Telegram fields: { reply_markup, parse_mode, disable_web_page_preview }
   *   @param {boolean} [opts.skipInApp]    - If true, only enqueue Telegram (no in-app INSERT)
   *   @param {string} [opts.dedupKey]      - If provided, notification id is deterministic (idempotent)
   *   @param {boolean} [opts.forceChannel] - If true, ignore user preference (admin/system critical only)
   * @returns {Promise<{id: string|null, status: string}>}
   *   status: 'delivered' | 'filtered' | 'skipped' | 'error'
   */
  async function create(env, opts, pool = null) {
    return notificationPlatformRepo.dispatch(env, opts, pool);
  }

  return Object.freeze({
    create,
  });
}
