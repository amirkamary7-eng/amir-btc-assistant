// ============================================================
// AB Token Wallet — Frontend Logic
// Handles wallet card in profile, full wallet page, and API calls
// ============================================================

const WalletApp = (() => {
  let walletData = null;
  let claimStatus = null;
  let historyLoading = false;
  let historyOffset = 0;
  let currentWalletTab = 'all'; // all | claim | referral | purchase | redeem
  let _tokenLogo = 'assets/token-logo.png';
  const DAILY_REWARD = 10;

  /** Escape HTML to prevent XSS when rendering dynamic content. */
  function esc(str) {
    if (!str) return '';
    return String(str).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
  }

  /**
   * Get the token logo URL from the DOM (already hash-replaced by build script),
   * falling back to the default path.
   */
  function getTokenLogo() {
    if (_tokenLogo !== 'assets/token-logo.png') return _tokenLogo;
    const img = document.querySelector('#wallet-preview-card .wallet-watermark img');
    if (img && img.src) {
      _tokenLogo = img.src;
    }
    return _tokenLogo;
  }

  // SVG icons (inline, no emojis)
  const ICONS = {
    back: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polyline points="15 18 9 12 15 6"/></svg>',
    arrowRight: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polyline points="9 18 15 12 9 6"/></svg>',
    calendar: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8"><rect x="3" y="4" width="18" height="18" rx="2" ry="2"/><line x1="16" y1="2" x2="16" y2="6"/><line x1="8" y1="2" x2="8" y2="6"/><line x1="3" y1="10" x2="21" y2="10"/></svg>',
    users: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8"><path d="M17 21v-2a4 4 0 0 0-4-4H5a4 4 0 0 0-4 4v2"/><circle cx="9" cy="7" r="4"/><path d="M23 21v-2a4 4 0 0 0-3-3.87"/><path d="M16 3.13a4 4 0 0 1 0 7.75"/></svg>',
    gift: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8"><polyline points="20 12 20 22 4 22 4 12"/><rect x="2" y="7" width="20" height="5"/><line x1="12" y1="22" x2="12" y2="7"/><path d="M12 7H7.5a2.5 2.5 0 0 1 0-5C11 2 12 7 12 7z"/><path d="M12 7h4.5a2.5 2.5 0 0 0 0-5C13 2 12 7 12 7z"/></svg>',
    clock: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8"><circle cx="12" cy="12" r="10"/><polyline points="12 6 12 12 16 14"/></svg>',
    star: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8"><path d="M12 2L9.09 8.26 2 9.27l5.18 5.11L6 21.02 12 17.77l6 3.25-1.18-6.64L22 9.27l-7.09-1.01L12 2z"/></svg>',
    sparkles: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8"><path d="M12 3l1.912 5.813L20 10l-5.18 2.18L12 18l-2.82-5.82L4 10l6.088-1.187L12 3z"/></svg>',
    chart: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8"><line x1="18" y1="20" x2="18" y2="10"/><line x1="12" y1="20" x2="12" y2="4"/><line x1="6" y1="20" x2="6" y2="14"/></svg>',
    shield: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8"><path d="M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10z"/></svg>',
    rocket: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8"><path d="M4.5 16.5c-1.5 1.26-2 5-2 5s3.74-.5 5-2c.71-.84.7-2.13-.09-2.91a2.18 2.18 0 0 0-2.91-.09z"/><path d="M12 15l-3-3a22 22 0 0 1 2-3.95A12.88 12.88 0 0 1 22 2c0 2.72-.78 7.5-6 11a22.35 22.35 0 0 1-4 2z"/><path d="M9 12H4s.55-3.03 2-4c1.62-1.08 5 0 5 0"/><path d="M12 15v5s3.03-.55 4-2c1.08-1.62 0-5 0-5"/></svg>',
    copy: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><rect x="9" y="9" width="13" height="13" rx="2" ry="2"/><path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"/></svg>',
    share: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><circle cx="18" cy="5" r="3"/><circle cx="6" cy="12" r="3"/><circle cx="18" cy="19" r="3"/><line x1="8.59" y1="13.51" x2="15.42" y2="17.49"/><line x1="15.41" y1="6.51" x2="8.59" y2="10.49"/></svg>',
    plus: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><line x1="12" y1="5" x2="12" y2="19"/><line x1="5" y1="12" x2="19" y2="12"/></svg>',
    info: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8"><circle cx="12" cy="12" r="10"/><line x1="12" y1="16" x2="12" y2="12"/><line x1="12" y1="8" x2="12.01" y2="8"/></svg>',
  };

  function formatNumber(n) {
    if (n == null) return '0';
    return Number(n).toLocaleString('en-US');
  }

  function formatTime(isoStr) {
    if (!isoStr) return '';
    const d = new Date(isoStr);
    const now = new Date();
    const diff = now - d;
    if (diff < 60000) return 'Just now';
    if (diff < 3600000) return `${Math.floor(diff / 60000)}m ago`;
    if (diff < 86400000) return `${Math.floor(diff / 3600000)}h ago`;
    if (diff < 604800000) return `${Math.floor(diff / 86400000)}d ago`;
    return d.toLocaleDateString('en-US', { month: 'short', day: 'numeric' });
  }

  function getTxIcon(type) {
    const map = {
      daily_claim: 'claim',
      claim: 'claim',
      referral_reward: 'referral',
      purchase: 'purchase',
      redeem: 'redeem',
    };
    return map[type] || 'other';
  }

  function getTxIconSvg(type) {
    const iconType = getTxIcon(type);
    const svgMap = {
      claim: ICONS.gift,
      referral: ICONS.users,
      purchase: ICONS.chart,
      redeem: ICONS.rocket,
      other: ICONS.info,
    };
    return svgMap[iconType] || ICONS.info;
  }

  function getTxLabel(type) {
    const map = {
      daily_claim: 'Daily Check-in',
      claim: 'Reward Claimed',
      referral_reward: 'Referral Reward',
      purchase: 'Purchase',
      redeem: 'Redemption',
    };
    return map[type] || type;
  }

  // =============================================
  // Profile Card Rendering
  // =============================================
  function renderProfileCard(data) {
    const card = document.getElementById('wallet-preview-card');
    if (!card) return;

    const tier = data.tier || { current: 'Bronze', next: 'Silver', progress: 0, remaining: 1000 };
    const balance = data.balance || 0;

    card.classList.remove('skeleton-loading');
    card.innerHTML = `
      <div class="wallet-watermark"><img src="${getTokenLogo()}" alt=""></div>
      <div class="wallet-preview-top">
        <div class="wallet-preview-logo"><img src="${getTokenLogo()}" alt="AB Token"></div>
        <div class="wallet-preview-info">
          <div class="wallet-preview-title">
            AB Token Wallet
            <span class="tier-badge">${tier.current} Member</span>
          </div>
          <div class="wallet-preview-subtitle">Amir BTC Assistant</div>
        </div>
      </div>
      <div class="wallet-preview-balance">
        <div class="balance-label">Current Balance</div>
        <div class="balance-value">${formatNumber(balance)} <span class="balance-ticker">AB</span></div>
      </div>
      <div class="wallet-preview-progress">
        <div class="progress-info">
          <span>${tier.next ? tier.progress.toFixed(0) + '% To ' + tier.next : 'Max Tier'}</span>
          <span class="progress-pct">${tier.progress.toFixed(0)}%</span>
        </div>
        <div class="wallet-progress-bar">
          <div class="wallet-progress-fill" style="width: 0%"></div>
        </div>
      </div>
      <button class="wallet-open-btn" onclick="WalletApp.openWallet()">
        Open Wallet
        ${ICONS.arrowRight}
      </button>
    `;

    // Animate progress bar
    requestAnimationFrame(() => {
      const fill = card.querySelector('.wallet-progress-fill');
      if (fill) fill.style.width = `${tier.progress}%`;
    });
  }

  function renderProfileCardSkeleton() {
    const card = document.getElementById('wallet-preview-card');
    if (!card) return;
    card.classList.add('skeleton-loading');
    card.innerHTML = `
      <div class="wallet-watermark"><img src="${getTokenLogo()}" alt=""></div>
      <div class="wallet-preview-top">
        <div class="wallet-preview-logo"><img src="${getTokenLogo()}" alt="AB Token"></div>
        <div class="wallet-preview-info">
          <div class="wallet-preview-title">AB Token Wallet</div>
          <div class="wallet-preview-subtitle">Amir BTC Assistant</div>
        </div>
      </div>
      <div class="wallet-preview-balance">
        <div class="balance-label">Current Balance</div>
        <div class="balance-value" style="width:160px;height:34px;">&nbsp;</div>
      </div>
      <div class="wallet-preview-progress">
        <div class="progress-info">
          <span>&nbsp;</span>
          <span>&nbsp;</span>
        </div>
        <div class="wallet-progress-bar">
          <div class="wallet-progress-fill" style="width:0%"></div>
        </div>
      </div>
      <button class="wallet-open-btn" disabled>Open Wallet ${ICONS.arrowRight}</button>
    `;
  }

  // =============================================
  // Full Wallet Page
  // =============================================
  function renderWalletPage(data) {
    const page = document.getElementById('wallet-full-page');
    if (!page) return;

    const tier = data.tier || { current: 'Bronze', next: 'Silver', progress: 0, remaining: 1000 };
    const balance = data.balance || 0;
    const history = data.history || [];

    page.innerHTML = buildWalletHTML(tier, balance, history);

    // Animate elements
    requestAnimationFrame(() => {
      const heroFill = page.querySelector('.tier-bar-fill');
      if (heroFill) heroFill.style.width = `${tier.progress}%`;
    });
  }

  function buildWalletHTML(tier, balance, history) {
    const bannerText = tier.next
      ? `Only <strong>${formatNumber(tier.remaining)} AB</strong> left until ${tier.next}`
      : 'You have reached the highest tier!';

    return `
      <!-- Header -->
      <div class="wallet-page-header">
        <button class="wallet-back-btn" onclick="WalletApp.closeWallet()" aria-label="Back">${ICONS.back}</button>
        <div class="wallet-page-header-info">
          <div class="wallet-page-header-logo"><img src="${getTokenLogo()}" alt="AB"></div>
          <div class="wallet-page-header-text">
            <h2>AB Token Wallet</h2>
            <span><span class="tier-dot"></span> ${tier.current} Member</span>
          </div>
        </div>
      </div>

      <!-- Smart Banner -->
      <div class="wallet-smart-banner">
        ${ICONS.sparkles}
        <p>${bannerText}</p>
      </div>

      <!-- Hero Balance Card -->
      <div class="wallet-hero-card">
        <div class="hero-watermark"><img src="${getTokenLogo()}" alt=""></div>
        <div class="wallet-hero-balance-label">Current Balance</div>
        <div class="wallet-hero-balance-value">${formatNumber(balance)} <span class="hero-ticker">AB</span></div>
        <div class="wallet-hero-divider"></div>
        <div class="wallet-hero-details">
          <div class="wallet-hero-detail-item">
            <div class="detail-label">Available Balance</div>
            <div class="detail-value">${formatNumber(balance)} AB</div>
          </div>
          <div class="wallet-hero-detail-item">
            <div class="detail-label">Member Tier</div>
            <div class="detail-value"><span class="mini-tier-badge">${tier.current}</span></div>
          </div>
          ${tier.next ? `
          <div class="wallet-hero-tier-progress">
            <div class="tier-progress-header">
              <span>Progress To ${tier.next}</span>
              <span class="tier-remaining">${formatNumber(tier.remaining)} AB Remaining</span>
            </div>
            <div class="wallet-hero-tier-bar">
              <div class="tier-bar-fill" style="width: 0%"></div>
            </div>
          </div>` : ''}
        </div>
      </div>

      <!-- Quick Actions -->
      <div class="wallet-quick-actions">
        <button class="wallet-action-btn" onclick="WalletApp.scrollToSection('wallet-earn-section')">
          <div class="wallet-action-icon earn-icon">${ICONS.gift}</div>
          <span>Earn</span>
        </button>
        <button class="wallet-action-btn" onclick="WalletApp.scrollToSection('wallet-referral-section')">
          <div class="wallet-action-icon referral-icon">${ICONS.users}</div>
          <span>Referral</span>
        </button>
        <button class="wallet-action-btn" onclick="WalletApp.scrollToSection('wallet-marketplace-section')">
          <div class="wallet-action-icon rewards-icon">${ICONS.star}</div>
          <span>Rewards</span>
        </button>
        <button class="wallet-action-btn" onclick="WalletApp.scrollToSection('wallet-history-section')">
          <div class="wallet-action-icon history-icon">${ICONS.clock}</div>
          <span>History</span>
        </button>
      </div>

      <!-- Earn Section -->
      <div class="wallet-section" id="wallet-earn-section">
        <div class="wallet-section-header">
          <h3>Earn AB Tokens</h3>
        </div>
        <div class="wallet-earn-grid">
          <div class="wallet-earn-card daily-checkin" id="daily-checkin-card">
            <div class="checkin-icon">${ICONS.calendar}</div>
            <div class="checkin-info">
              <div class="checkin-title">Daily Check-in</div>
              <div class="checkin-reward">+${DAILY_REWARD} AB</div>
            </div>
            <button class="checkin-btn" id="daily-claim-btn" onclick="WalletApp.claimDaily()">Claim</button>
          </div>
          <div class="wallet-earn-card">
            <div class="earn-reward">+5 AB</div>
            <div class="earn-title">Read Analysis</div>
            <div class="earn-desc">View premium analysis reports</div>
          </div>
          <div class="wallet-earn-card">
            <div class="earn-reward">+3 AB</div>
            <div class="earn-title">View News</div>
            <div class="earn-desc">Stay updated with market news</div>
          </div>
          <div class="wallet-earn-card">
            <div class="earn-reward">+10 AB</div>
            <div class="earn-title">Open App Daily</div>
            <div class="earn-desc">Active daily usage reward</div>
          </div>
          <div class="wallet-earn-card">
            <div class="earn-reward">+50 AB</div>
            <div class="earn-title">Invite Friend</div>
            <div class="earn-desc">Earn from each referral</div>
          </div>
        </div>
      </div>

      <!-- Referral Section -->
      <div class="wallet-section" id="wallet-referral-section">
        <div class="wallet-section-header">
          <h3>Referral Program</h3>
        </div>
        <div class="wallet-referral-box">
          <div class="wallet-ref-link-row">
            <input type="text" id="wallet-ref-link" readonly>
            <button class="ref-copy-btn" onclick="WalletApp.copyRefLink()" aria-label="Copy">${ICONS.copy}</button>
            <button class="ref-share-btn-sm" onclick="WalletApp.shareRefLink()" aria-label="Share">${ICONS.share}</button>
          </div>
          <div class="wallet-ref-stats-grid">
            <div class="wallet-ref-stat">
              <div class="stat-label">Invited Users</div>
              <div class="stat-value" id="wallet-ref-invited">0</div>
            </div>
            <div class="wallet-ref-stat">
              <div class="stat-label">Active</div>
              <div class="stat-value" id="wallet-ref-active">0</div>
            </div>
            <div class="wallet-ref-stat">
              <div class="stat-label">Total Earned AB</div>
              <div class="stat-value" id="wallet-ref-earned">0</div>
            </div>
            <div class="wallet-ref-stat">
              <div class="stat-label">Pending Rewards</div>
              <div class="stat-value" id="wallet-ref-pending">0</div>
            </div>
          </div>
        </div>
      </div>

      <!-- Rewards Marketplace -->
      <div class="wallet-section" id="wallet-marketplace-section">
        <div class="wallet-section-header">
          <h3>Rewards Marketplace</h3>
          <button class="section-action">View All</button>
        </div>
        <div class="wallet-marketplace-scroll">
          <div class="wallet-marketplace-card">
            <div class="reward-icon icon-analysis">${ICONS.chart}</div>
            <div class="reward-name">Premium Analysis</div>
            <div class="reward-desc">Unlock access to exclusive premium market analysis reports</div>
            <div class="reward-footer">
              <span class="reward-cost">500 AB</span>
              <span class="reward-status status-available">Available</span>
            </div>
          </div>
          <div class="wallet-marketplace-card">
            <div class="reward-icon icon-vip">${ICONS.shield}</div>
            <div class="reward-name">VIP Features</div>
            <div class="reward-desc">Get VIP status with exclusive features and priority support</div>
            <div class="reward-footer">
              <span class="reward-cost">2,000 AB</span>
              <span class="reward-status status-locked">Locked</span>
            </div>
          </div>
          <div class="wallet-marketplace-card">
            <div class="reward-icon icon-report">${ICONS.star}</div>
            <div class="reward-name">Exclusive Reports</div>
            <div class="reward-desc">Access in-depth research reports and market insights</div>
            <div class="reward-footer">
              <span class="reward-cost">1,000 AB</span>
              <span class="reward-status status-coming">Coming Soon</span>
            </div>
          </div>
          <div class="wallet-marketplace-card">
            <div class="reward-icon icon-future">${ICONS.rocket}</div>
            <div class="reward-name">Future Utilities</div>
            <div class="reward-desc">Upcoming features: staking, trading discounts, and more</div>
            <div class="reward-footer">
              <span class="reward-cost">TBA</span>
              <span class="reward-status status-coming">Coming Soon</span>
            </div>
          </div>
        </div>
      </div>

      <!-- Transaction History -->
      <div class="wallet-section" id="wallet-history-section">
        <div class="wallet-section-header">
          <h3>Transaction History</h3>
        </div>
        <div id="wallet-tx-list" class="wallet-tx-list">
          ${history.length > 0
            ? history.map(tx => buildTxItemHTML(tx)).join('')
            : `<div class="wallet-empty-state">
                <div class="empty-icon"><img src="${getTokenLogo()}" alt="AB"></div>
                <h4>Start earning your first AB Tokens</h4>
                <p>Complete tasks and invite friends to unlock rewards.</p>
              </div>`
          }
        </div>
        ${history.length > 0 && history.length >= 20 ? `
          <div id="wallet-load-more" style="text-align:center;padding:16px;">
            <button class="section-action" onclick="WalletApp.loadMoreHistory()" style="padding:10px 24px;font-size:13px;">Load More</button>
          </div>
        ` : ''}
      </div>
    `;
  }

  function buildTxItemHTML(tx) {
    const isPositive = tx.amount > 0;
    return `
      <div class="wallet-tx-item">
        <div class="wallet-tx-icon tx-${getTxIcon(tx.type)}">${getTxIconSvg(tx.type)}</div>
        <div class="wallet-tx-info">
          <div class="tx-type">${esc(getTxLabel(tx.type))}</div>
          <div class="tx-desc">${esc(tx.description || '')}</div>
        </div>
        <div class="wallet-tx-right">
          <div class="tx-amount ${isPositive ? 'positive' : 'negative'}">${isPositive ? '+' : ''}${formatNumber(tx.amount)} AB</div>
          <div class="tx-time">${esc(formatTime(tx.created_at))}</div>
        </div>
      </div>
    `;
  }

  function buildWalletSkeleton() {
    return `
      <div class="wallet-page-header">
        <button class="wallet-back-btn" onclick="WalletApp.closeWallet()" aria-label="Back">${ICONS.back}</button>
        <div class="wallet-page-header-info">
          <div class="wallet-page-header-logo"><img src="${getTokenLogo()}" alt="AB"></div>
          <div class="wallet-page-header-text">
            <h2>AB Token Wallet</h2>
            <span>Loading...</span>
          </div>
        </div>
      </div>
      <div class="wallet-skeleton">
        <div class="wallet-skeleton-card">
          <div class="wallet-skeleton-line h-sm w-40"></div>
          <div class="wallet-skeleton-line h-lg w-60"></div>
          <div class="wallet-skeleton-line h-sm w-80"></div>
        </div>
        <div class="wallet-skeleton-card">
          <div class="wallet-skeleton-line h-sm w-60"></div>
          <div class="wallet-skeleton-line w-40"></div>
        </div>
        <div class="wallet-skeleton-card">
          <div class="wallet-skeleton-line h-sm w-60"></div>
          <div class="wallet-skeleton-line w-40"></div>
        </div>
        <div class="wallet-skeleton-card">
          <div class="wallet-skeleton-line h-sm w-60"></div>
          <div class="wallet-skeleton-line w-40"></div>
        </div>
      </div>
    `;
  }

  // =============================================
  // API Calls
  // =============================================
  async function fetchWallet() {
    try {
      const data = await window.apiFetch('/api/wallet');
      if (data.status === 'success') {
        walletData = data;
        return data;
      }
    } catch (e) {
      console.warn('WalletApp: fetchWallet error', e);
    }
    return null;
  }

  async function fetchClaimStatus() {
    try {
      const data = await window.apiFetch('/api/wallet/claim');
      if (data.status === 'success') {
        claimStatus = data;
        return data;
      }
    } catch (e) {
      console.warn('WalletApp: fetchClaimStatus error', e);
    }
    return null;
  }

  async function claimDailyRewardAPI() {
    try {
      const data = await window.apiFetch('/api/wallet/claim', { method: 'POST' });
      return data;
    } catch (e) {
      console.warn('WalletApp: claimDailyRewardAPI error', e);
      // apiFetch throws on non-2xx; try to extract the server error body
      try { return JSON.parse(e.message); } catch (_) {}
      return { status: 'error', message: 'Network error' };
    }
  }

  async function fetchHistory(offset = 0) {
    try {
      const data = await window.apiFetch(`/api/wallet/history?offset=${offset}&limit=20`);
      if (data.status === 'success') return data;
    } catch (e) {
      console.warn('WalletApp: fetchHistory error', e);
    }
    return null;
  }

  // =============================================
  // Public Actions
  // =============================================
  async function loadProfileCard() {
    const card = document.getElementById('wallet-preview-card');
    if (!card) return;

    // Guest or pending users — show access-denied state, not skeleton
    const uid = window.getUserId?.();
    if (window.isGuestUserId?.(uid) || window.isPendingTelegramUserId?.(uid) || window.UserContext?.isPending?.()) {
      card.classList.remove('skeleton-loading');
      card.innerHTML = `
        <div class="wallet-watermark"><img src="${getTokenLogo()}" alt=""></div>
        <div class="wallet-preview-top">
          <div class="wallet-preview-logo"><img src="${getTokenLogo()}" alt="AB Token"></div>
          <div class="wallet-preview-info">
            <div class="wallet-preview-title">AB Token Wallet</div>
            <div class="wallet-preview-subtitle">Amir BTC Assistant</div>
          </div>
        </div>
        <div class="wallet-preview-balance">
          <div class="balance-label">Current Balance</div>
          <div class="balance-value" style="opacity:0.5;font-size:14px;">Login to view wallet</div>
        </div>
        <button class="wallet-open-btn" disabled style="opacity:0.5;cursor:default;">
          Open Wallet
          ${ICONS.arrowRight}
        </button>
      `;
      return;
    }

    renderProfileCardSkeleton();
    const data = await fetchWallet();
    if (data) {
      renderProfileCard(data);
    } else {
      // API error or transient failure — show fallback with safe defaults
      // instead of a permanent "Unable to load" error state.
      // New users or temporary DB issues should not break the UI.
      card.classList.remove('skeleton-loading');
      const fallbackData = { balance: 0, tier: { current: 'Bronze', next: 'Silver', progress: 0, remaining: 1000 } };
      renderProfileCard(fallbackData);
    }
  }

  function openWallet() {
    const page = document.getElementById('wallet-full-page');
    if (!page) return;
    // Guard: if still in skeleton/pending state, ignore click to prevent dead state
    const card = document.getElementById('wallet-preview-card');
    if (card?.classList.contains('skeleton-loading')) return;
    page.innerHTML = buildWalletSkeleton();
    page.classList.add('open');
    document.body.style.overflow = 'hidden';

    // Load wallet data
    loadWalletData();
  }

  function closeWallet() {
    const page = document.getElementById('wallet-full-page');
    if (!page) return;
    page.classList.remove('open');
    document.body.style.overflow = '';
    // Refresh profile card
    loadProfileCard();
  }

  async function loadWalletData() {
    const [walletRes, claimRes] = await Promise.all([fetchWallet(), fetchClaimStatus()]);

    if (walletRes) {
      renderWalletPage(walletRes);
      walletData = walletRes;
      // Set referral link
      const user = window.UserContext?.user || window.getTelegramUser?.();
      if (user?.id) {
        const botUsername = window.BOT_USERNAME || '';
        const refInput = document.getElementById('wallet-ref-link');
        if (refInput) refInput.value = `https://t.me/${botUsername}?start=ref_${user.id}`;
      }
      // Load referral stats
      loadWalletReferralStats();
    } else {
      // API error — show fallback with safe defaults instead of permanent error state
      const fallbackData = {
        balance: 0,
        tier: { current: 'Bronze', next: 'Silver', progress: 0, remaining: 1000 },
        history: [],
      };
      renderWalletPage(fallbackData);
    }

    if (claimRes) {
      updateClaimButton(claimRes.claimed_today);
    }
  }

  async function loadWalletReferralStats() {
    try {
      const data = await window.apiFetch('/api/wallet/referral-stats');
      if (data.status === 'success') {
        const invited = document.getElementById('wallet-ref-invited');
        const active = document.getElementById('wallet-ref-active');
        const earned = document.getElementById('wallet-ref-earned');
        const pending = document.getElementById('wallet-ref-pending');
        if (invited) invited.textContent = data.invited || 0;
        if (active) active.textContent = data.active || 0;
        if (earned) earned.textContent = data.earned || 0;
        if (pending) pending.textContent = Math.max(0, (data.invited || 0) - (data.earned || 0));
      }
    } catch (e) {
      // silent fail
    }
  }

  function updateClaimButton(claimed) {
    const btn = document.getElementById('daily-claim-btn');
    const card = document.getElementById('daily-checkin-card');
    if (!btn || !card) return;

    if (claimed) {
      btn.disabled = true;
      btn.textContent = 'Claimed';
      if (!card.querySelector('.earn-claimed-badge')) {
        const badge = document.createElement('span');
        badge.className = 'earn-claimed-badge';
        badge.textContent = 'CLAIMED';
        card.appendChild(badge);
      }
    } else {
      btn.disabled = false;
      btn.textContent = 'Claim';
    }
  }

  async function claimDaily() {
    const btn = document.getElementById('daily-claim-btn');
    if (!btn || btn.disabled) return;

    btn.disabled = true;
    btn.textContent = 'Claiming...';

    const result = await claimDailyRewardAPI();

    if (result.status === 'success') {
      btn.textContent = 'Claimed';
      const card = document.getElementById('daily-checkin-card');
      if (card) card.classList.add('wallet-claim-success');
      setTimeout(() => {
        if (card) card.classList.remove('wallet-claim-success');
      }, 500);
      if (!card?.querySelector('.earn-claimed-badge')) {
        const badge = document.createElement('span');
        badge.className = 'earn-claimed-badge';
        badge.textContent = 'CLAIMED';
        card?.appendChild(badge);
      }
      // Refresh wallet data
      const walletRes = await fetchWallet();
      if (walletRes) renderWalletPage(walletRes);
      // Show success popup
      const tg = window.getTg?.();
      tg?.showPopup?.({ title: 'Success', message: `+${DAILY_REWARD} AB claimed!`, buttons: [{ type: 'ok' }] });
    } else {
      btn.disabled = false;
      btn.textContent = 'Claim';
      const tg = window.getTg?.();
      tg?.showPopup?.({ title: 'Error', message: result.message || 'Failed to claim', buttons: [{ type: 'ok' }] });
    }
  }

  async function loadMoreHistory() {
    if (historyLoading) return;
    historyLoading = true;
    const btn = document.querySelector('#wallet-load-more button');
    if (btn) btn.textContent = 'Loading...';

    historyOffset += 20;
    const result = await fetchHistory(historyOffset);

    if (result && result.transactions.length > 0) {
      const list = document.getElementById('wallet-tx-list');
      // Remove empty state if present
      const empty = list?.querySelector('.wallet-empty-state');
      if (empty) empty.remove();

      const html = result.transactions.map(tx => buildTxItemHTML(tx)).join('');
      list?.insertAdjacentHTML('beforeend', html);

      if (!result.hasMore) {
        const loadMore = document.getElementById('wallet-load-more');
        if (loadMore) loadMore.remove();
      }
    } else {
      historyOffset -= 20;
    }

    if (btn) btn.textContent = 'Load More';
    historyLoading = false;
  }

  function copyRefLink() {
    const input = document.getElementById('wallet-ref-link');
    if (!input || !input.value) return;
    input.select();
    try { navigator.clipboard.writeText(input.value); } catch (e) { document.execCommand('copy'); }
    const tg = window.getTg?.();
    tg?.showPopup?.({ title: 'Copied', message: 'Referral link copied!', buttons: [{ type: 'ok' }] });
  }

  function shareRefLink() {
    const input = document.getElementById('wallet-ref-link');
    if (!input || !input.value) return;
    const link = input.value;
    const text = encodeURIComponent('Join Amir BTC Assistant and earn AB Tokens!');
    const tg = window.getTg?.();
    tg?.openTelegramLink?.(`https://t.me/share/url?url=${encodeURIComponent(link)}&text=${text}`) ||
    window.open(`https://t.me/share/url?url=${encodeURIComponent(link)}&text=${text}`, '_blank');
  }

  function scrollToSection(id) {
    const el = document.getElementById(id);
    if (el) el.scrollIntoView({ behavior: 'smooth', block: 'start' });
  }

  return {
    loadProfileCard,
    openWallet,
    closeWallet,
    claimDaily,
    loadMoreHistory,
    copyRefLink,
    shareRefLink,
    scrollToSection,
    getTokenLogo,
  };
})();

// Expose globally
window.WalletApp = WalletApp;