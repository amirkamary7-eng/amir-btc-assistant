// ============================================================
// AI Assistant — Premium Chat UI with typing indicator
// ============================================================

const AssistantUI = {
    sessionId: localStorage.getItem('ai_session') || null,
    history: [],
    open: false,
    sending: false,

    init() {
        this.injectHTML();
        this.bindEvents();
    },

    injectHTML() {
        if (document.getElementById('ai-assistant-root')) return;

        const root = document.createElement('div');
        root.id = 'ai-assistant-root';
        root.className = 'ai-assistant-root';
        root.innerHTML = `
            <div id="ai-speech-bubble" class="ai-speech-bubble" role="status" aria-live="polite">
                <button id="ai-bubble-close" class="ai-bubble-close" type="button" aria-label="بستن">
                    <svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5">
                        <line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/>
                    </svg>
                </button>
                <div class="ai-bubble-header">
                    <div class="ai-bubble-avatar">
                        <svg width="16" height="16" viewBox="0 0 56 56" fill="none">
                            <defs>
                                <radialGradient id="aiBubbleGrad" cx="50%" cy="50%" r="50%">
                                    <stop offset="0%" stop-color="#FFD9A0"/>
                                    <stop offset="100%" stop-color="#F5A623"/>
                                </radialGradient>
                            </defs>
                            <circle cx="28" cy="28" r="7" fill="url(#aiBubbleGrad)"/>
                            <path d="M28 4 L30.5 18 L28 20 L25.5 18 Z" fill="#F5A623" opacity="0.8"/>
                            <path d="M52 28 L38 30.5 L36 28 L38 25.5 Z" fill="#F5A623" opacity="0.8"/>
                            <path d="M28 52 L25.5 38 L28 36 L30.5 38 Z" fill="#F5A623" opacity="0.8"/>
                            <path d="M4 28 L18 25.5 L20 28 L18 30.5 Z" fill="#F5A623" opacity="0.8"/>
                        </svg>
                    </div>
                </div>
                <p class="ai-speech-text" data-i18n-html="ai_welcome_msg">سلام 👋🏻 خوش اومدی
اگر سوالی یا چیزی خواستی من اینجام</p>
                <span class="ai-bubble-tail"></span>
            </div>
            <button id="ai-fab" class="ai-fab" aria-label="AI Assistant">
                <span class="ai-fab-halo"></span>
                <span class="ai-fab-ring"></span>
                <span class="ai-fab-surface">
                    <svg class="ai-icon-core" width="28" height="28" viewBox="0 0 56 56" fill="none">
                        <defs>
                            <radialGradient id="aiCoreGrad" cx="50%" cy="50%" r="50%">
                                <stop offset="0%" stop-color="#FFD9A0"/>
                                <stop offset="60%" stop-color="#F5A623"/>
                                <stop offset="100%" stop-color="#D4881A"/>
                            </radialGradient>
                            <linearGradient id="aiRayGrad" x1="0%" y1="0%" x2="100%" y2="100%">
                                <stop offset="0%" stop-color="#FFE9A0"/>
                                <stop offset="100%" stop-color="#F5A623"/>
                            </linearGradient>
                        </defs>
                        <!-- Central core (digital orb) -->
                        <circle cx="28" cy="28" r="7" fill="url(#aiCoreGrad)"/>
                        <circle cx="28" cy="28" r="4" fill="#020611" opacity="0.4"/>
                        <!-- 4 cardinal rays (N, E, S, W) -->
                        <path d="M28 4 L30.5 18 L28 20 L25.5 18 Z" fill="url(#aiRayGrad)"/>
                        <path d="M52 28 L38 30.5 L36 28 L38 25.5 Z" fill="url(#aiRayGrad)"/>
                        <path d="M28 52 L25.5 38 L28 36 L30.5 38 Z" fill="url(#aiRayGrad)"/>
                        <path d="M4 28 L18 25.5 L20 28 L18 30.5 Z" fill="url(#aiRayGrad)"/>
                        <!-- 4 diagonal accents (NE, SE, SW, NW) -->
                        <path d="M44.97 11.03 L34.5 21.5 L32.5 21.5 L34.5 19.5 Z" fill="url(#aiRayGrad)" opacity="0.7"/>
                        <path d="M44.97 44.97 L34.5 34.5 L34.5 32.5 L36.5 34.5 Z" fill="url(#aiRayGrad)" opacity="0.7"/>
                        <path d="M11.03 44.97 L21.5 34.5 L23.5 34.5 L21.5 36.5 Z" fill="url(#aiRayGrad)" opacity="0.7"/>
                        <path d="M11.03 11.03 L21.5 21.5 L21.5 23.5 L19.5 21.5 Z" fill="url(#aiRayGrad)" opacity="0.7"/>
                    </svg>
                </span>
            </button>
            <div id="ai-panel" class="ai-panel" style="display:none;">
                <div class="ai-panel-header">
                    <div class="ai-panel-title">
                        <div class="ai-avatar-mini">
                            <svg width="22" height="22" viewBox="0 0 56 56" fill="none">
                                <defs>
                                    <radialGradient id="aiAvatarCore" cx="50%" cy="50%" r="50%">
                                        <stop offset="0%" stop-color="#FFD9A0"/>
                                        <stop offset="100%" stop-color="#F5A623"/>
                                    </radialGradient>
                                </defs>
                                <circle cx="28" cy="28" r="7" fill="url(#aiAvatarCore)"/>
                                <path d="M28 4 L30.5 18 L28 20 L25.5 18 Z" fill="#F5A623"/>
                                <path d="M52 28 L38 30.5 L36 28 L38 25.5 Z" fill="#F5A623"/>
                                <path d="M28 52 L25.5 38 L28 36 L30.5 38 Z" fill="#F5A623"/>
                                <path d="M4 28 L18 25.5 L20 28 L18 30.5 Z" fill="#F5A623"/>
                            </svg>
                        </div>
                        <div class="ai-header-text">
                            <span class="ai-header-name" data-i18n="ai_title">دستیار هوشمند</span>
                            <span class="ai-header-status">
                                <span class="ai-status-dot"></span>
                                <span class="ai-status-text" data-i18n="ai_online">آنلاین</span>
                            </span>
                        </div>
                    </div>
                    <button id="ai-close" class="ai-close-btn" aria-label="بستن" data-i18n-aria-label="close">
                        <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                            <line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/>
                        </svg>
                    </button>
                </div>
                <div id="ai-limits" class="ai-limits" role="region" aria-label="سهمیه دستیار هوشمند"></div>
                <div id="ai-messages" class="ai-messages">
                    <div class="ai-empty-state" id="ai-empty-state">
                        <div class="ai-empty-hero">
                            <svg width="48" height="48" viewBox="0 0 56 56" fill="none" class="ai-empty-icon">
                                <defs>
                                    <radialGradient id="aiEmptyCore" cx="50%" cy="50%" r="50%">
                                        <stop offset="0%" stop-color="#FFD9A0"/>
                                        <stop offset="100%" stop-color="#F5A623"/>
                                    </radialGradient>
                                </defs>
                                <circle cx="28" cy="28" r="7" fill="url(#aiEmptyCore)"/>
                                <path d="M28 4 L30.5 18 L28 20 L25.5 18 Z" fill="#F5A623" opacity="0.8"/>
                                <path d="M52 28 L38 30.5 L36 28 L38 25.5 Z" fill="#F5A623" opacity="0.8"/>
                                <path d="M28 52 L25.5 38 L28 36 L30.5 38 Z" fill="#F5A623" opacity="0.8"/>
                                <path d="M4 28 L18 25.5 L20 28 L18 30.5 Z" fill="#F5A623" opacity="0.8"/>
                            </svg>
                        </div>
                        <p class="ai-empty-title" data-i18n="ai_title">دستیار هوشمند AMIRBTC</p>
                        <p class="ai-empty-subtitle" data-i18n="ai_placeholder">درباره بازار، ارزهای دیجیتال، اخبار و اطلاعات روز سؤال کن</p>
                        <div class="ai-suggestions">
                            <button class="ai-suggestion-card" data-prompt="دستیار هوشمند AMIRBTC چیه و چه کارهایی می‌تونه انجام بده؟">
                                <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><circle cx="12" cy="12" r="10"/><path d="M9.09 9a3 3 0 0 1 5.83 1c0 2-3 3-3 3"/><line x1="12" y1="17" x2="12.01" y2="17"/></svg>
                                <span data-i18n="ai_suggestion_1">دستیار هوشمند AMIRBTC چیه و چه کارهایی می‌تونه انجام بده؟</span>
                            </button>
                            <button class="ai-suggestion-card" data-prompt="با AMIRBTC چه اطلاعاتی درباره بازار و ارزها می‌تونم بگیرم؟">
                                <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M3 3v18h18"/><path d="M18.7 8l-5.1 5.2-2.8-2.7L7 14.3"/></svg>
                                <span data-i18n="ai_suggestion_2">با AMIRBTC چه اطلاعاتی درباره بازار و ارزها می‌تونم بگیرم؟</span>
                            </button>
                            <button class="ai-suggestion-card" data-prompt="چطور می‌تونم از بخش اخبار و تحلیل برای پیدا کردن فرصت‌های بازار استفاده کنم؟">
                                <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M4 22h16a2 2 0 0 0 2-2V4a2 2 0 0 0-2-2H8a2 2 0 0 0-2 2v16a2 2 0 0 1-2 2zm0 0a2 2 0 0 1-2-2v-9c0-1.1.9-2 2-2h2"/><path d="M18 14h-8"/><path d="M15 18h-5"/></svg>
                                <span data-i18n="ai_suggestion_3">چطور می‌تونم از بخش اخبار و تحلیل برای پیدا کردن فرصت‌های بازار استفاده کنم؟</span>
                            </button>
                        </div>
                    </div>
                </div>
                <div class="ai-input-area">
                    <div class="ai-composer-attachment" id="ai-composer-attachment" style="display:none;"></div>
                    <div class="ai-input-row">
                        <input type="file" id="ai-file" accept="image/*" hidden>
                        <button id="ai-attach" class="ai-attach-btn" aria-label="پیوست تصویر">
                            <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
                                <path d="M21.44 11.05l-9.19 9.19a6 6 0 0 1-8.49-8.49l9.19-9.19a4 4 0 0 1 5.66 5.66l-9.2 9.19a2 2 0 0 1-2.83-2.83l8.49-8.48"/>
                            </svg>
                        </button>
                        <textarea id="ai-input" class="ai-input" rows="1" placeholder="پیام خود را بنویسید..."></textarea>
                        <button id="ai-send" class="ai-send-btn" aria-label="ارسال">
                            <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
                                <path d="M5 12h14"/><path d="M12 5l7 7-7 7"/>
                            </svg>
                        </button>
                    </div>
                </div>
            </div>
        `;
        document.body.appendChild(root);
        this.initSpeechBubble();
    },

    initSpeechBubble() {
        const bubble = document.getElementById('ai-speech-bubble');
        const closeBtn = document.getElementById('ai-bubble-close');
        if (!bubble) return;
        if (sessionStorage.getItem('ai_welcome_shown') === '1') {
            bubble.classList.add('ai-speech-hidden');
            return;
        }
        // Update text based on language
        const lang = (typeof currentLang !== 'undefined' ? currentLang : 'fa');
        const textEl = bubble.querySelector('.ai-speech-text');
        if (textEl) {
            textEl.textContent = t('ai_welcome_msg');
        }
        // Play subtle notification sound
        this.playWelcomeSound();

        // FIX: unified dismiss function — clears timer, hides bubble, sets state.
        // Both auto-dismiss AND close button use this SAME path.
        const dismissWelcomeBubble = () => {
            // Clear any existing timer (prevents duplicate timer firing)
            if (bubble._dismissTimer) {
                clearTimeout(bubble._dismissTimer);
                bubble._dismissTimer = null;
            }
            // Guard: if already hidden, do nothing (prevents double-dismiss)
            if (bubble.classList.contains('ai-speech-hidden')) return;
            bubble.classList.add('ai-speech-hidden');
            sessionStorage.setItem('ai_welcome_shown', '1');
        };

        // Close button — single click dismisses
        closeBtn?.addEventListener('click', (e) => {
            e.preventDefault();
            e.stopPropagation();
            dismissWelcomeBubble();
        });

        // Auto-dismiss after 5 seconds
        bubble._dismissTimer = window.setTimeout(dismissWelcomeBubble, 5000);

        // FIX: also dismiss when user clicks the FAB (opens chat) — prevents
        // the bubble from lingering after the chat panel opens.
        document.getElementById('ai-fab')?.addEventListener('click', () => {
            if (!bubble.classList.contains('ai-speech-hidden')) {
                dismissWelcomeBubble();
            }
        }, { once: false });
    },

    // PHASE 1: Subtle notification sound for welcome bubble
    // Uses Web Audio API to generate a short, premium notification tone.
    // Fails silently if browser autoplay policy blocks it.
    playWelcomeSound() {
        try {
            const ctx = new (window.AudioContext || window.webkitAudioContext)();
            if (ctx.state === 'suspended') ctx.resume();
            const osc = ctx.createOscillator();
            const gain = ctx.createGain();
            osc.connect(gain);
            gain.connect(ctx.destination);
            osc.frequency.setValueAtTime(880, ctx.currentTime);
            osc.frequency.exponentialRampToValueAtTime(1100, ctx.currentTime + 0.08);
            gain.gain.setValueAtTime(0, ctx.currentTime);
            gain.gain.linearRampToValueAtTime(0.06, ctx.currentTime + 0.02);
            gain.gain.exponentialRampToValueAtTime(0.001, ctx.currentTime + 0.3);
            osc.start(ctx.currentTime);
            osc.stop(ctx.currentTime + 0.3);
        } catch(e) { /* Silent fail — autoplay policy or unsupported */ }
    },

    bindEvents() {
        document.getElementById('ai-fab')?.addEventListener('click', () => this.toggle(true));
        document.getElementById('ai-close')?.addEventListener('click', (e) => { e.preventDefault(); e.stopPropagation(); this.toggle(false); });
        document.getElementById('ai-send')?.addEventListener('click', () => this.send());
        document.getElementById('ai-attach')?.addEventListener('click', () => document.getElementById('ai-file')?.click());
        document.getElementById('ai-file')?.addEventListener('change', (e) => this.handleFile(e));
        document.getElementById('ai-input')?.addEventListener('keydown', (e) => {
            if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); this.send(); }
        });
        // PHASE 7: Suggestion card click handlers
        document.querySelectorAll('.ai-suggestion-card').forEach(card => {
            card.addEventListener('click', () => {
                const prompt = card.dataset.prompt;
                const input = document.getElementById('ai-input');
                if (input && prompt) {
                    input.value = prompt;
                    input.focus();
                    this.hideEmptyState();
                }
            });
        });
        // Input listener to hide empty state on first type
        document.getElementById('ai-input')?.addEventListener('input', () => {
            this.hideEmptyState();
        });

        // Draggable FAB
        const fab = document.getElementById('ai-fab');
        const root = document.getElementById('ai-assistant-root');
        if (fab && root) {
            const savedPos = localStorage.getItem('ai_fab_pos');
            if (savedPos) {
                try {
                    const pos = JSON.parse(savedPos);
                    root.style.right = 'auto';
                    root.style.left = pos.x + 'px';
                    root.style.bottom = pos.y + 'px';
                    root.style.top = 'auto';
                } catch(e) {}
            }
            let isDragging = false, hasMoved = false, startX, startY, startLeft, startBottom;
            fab.addEventListener('pointerdown', (e) => {
                isDragging = true; hasMoved = false;
                startX = e.clientX; startY = e.clientY;
                const rect = root.getBoundingClientRect();
                startLeft = rect.left; startBottom = window.innerHeight - rect.bottom;
                fab.setPointerCapture(e.pointerId); e.preventDefault();
            });
            fab.addEventListener('pointermove', (e) => {
                if (!isDragging) return;
                const dx = e.clientX - startX, dy = e.clientY - startY;
                if (Math.abs(dx) > 5 || Math.abs(dy) > 5) hasMoved = true;
                if (!hasMoved) return;
                const newLeft = Math.max(0, Math.min(window.innerWidth - 60, startLeft + dx));
                const newBottom = Math.max(80, Math.min(window.innerHeight - 80, startBottom - dy));
                root.style.right = 'auto'; root.style.left = newLeft + 'px';
                root.style.bottom = newBottom + 'px'; root.style.top = 'auto';
            });
            fab.addEventListener('pointerup', (e) => {
                if (!isDragging) return; isDragging = false;
                if (hasMoved) {
                    const rect = root.getBoundingClientRect();
                    localStorage.setItem('ai_fab_pos', JSON.stringify({ x: rect.left, y: window.innerHeight - rect.bottom }));
                    e.stopPropagation();
                }
            });
            fab.addEventListener('click', (e) => {
                if (hasMoved) { e.preventDefault(); e.stopPropagation(); hasMoved = false; }
            }, true);
        }
    },

    toggle(show) {
        this.open = show ?? !this.open;
        const panel = document.getElementById('ai-panel');
        const fab = document.getElementById('ai-fab');
        const bubble = document.getElementById('ai-speech-bubble');
        if (panel) panel.style.display = this.open ? 'flex' : 'none';
        if (fab) fab.classList.toggle('ai-fab-hidden', this.open);
        if (bubble && this.open) { bubble.classList.add('ai-speech-hidden'); localStorage.setItem('ai_speech_dismissed', '1'); }
        if (this.open) {
            this.refreshLimits();
            // Welcome bubble is OUTSIDE chat — it's a UI notification, not a conversation message
            document.getElementById('ai-input')?.focus();
        }
    },

    // Welcome is now a floating UI bubble (ai-speech-bubble) that appears
    // next to the FAB, NOT inside chat history. See initSpeechBubble().
    // This ensures: (1) no AI API call, (2) not in conversation, (3) auto-dismiss 5s.

    getContext() {
        const ctx = {};
        // Detect current page from active nav/section
        const activeNav = document.querySelector('.nav-tab.active, .bottom-nav-item.active');
        if (activeNav) {
            const section = activeNav.getAttribute('data-section') || activeNav.getAttribute('data-tab');
            if (section) ctx.page = section;
        }
        // Detect selected coin from coin detail modal
        const coinDetail = document.getElementById('coin-detail-modal');
        if (coinDetail && coinDetail.style.display !== 'none') {
            const coinSymbol = coinDetail.getAttribute('data-coin') || coinDetail.querySelector('[data-coin-symbol]')?.getAttribute('data-coin-symbol');
            if (coinSymbol) ctx.coin = coinSymbol;
        }
        // Detect current news article if on news detail
        const newsDetail = document.getElementById('news-detail-page');
        if (newsDetail && newsDetail.style.display !== 'none') {
            const articleId = newsDetail.getAttribute('data-article-id');
            if (articleId) ctx.article_id = articleId;
        }
        return Object.keys(ctx).length > 0 ? ctx : null;
    },

    async refreshLimits() {
        const el = document.getElementById('ai-limits');
        if (!el || !window.API_BASE || (typeof isGuestUserId === 'function' ? isGuestUserId(getUserId()) : String(getUserId()).startsWith('guest_'))) {
            if (el) el.innerHTML = '';
            return;
        }
        // PHASE 3: Loading state — no hardcoded fallback (prevents 50↔100 flicker)
        el.innerHTML = '<span class="ai-quota-loading">...</span>';
        el.classList.add('ai-quota-loading-state');
        try {
            const data = await apiFetch(`/api/assistant/limits?user_id=${encodeURIComponent(getUserId())}`);
            el.classList.remove('ai-quota-loading-state');
            const used = data.messages_used ?? 0;
            const limit = data.messages_limit;
            // PHASE 3: If limit is null/undefined, stay in loading state
            if (limit == null) {
                el.innerHTML = '<span class="ai-quota-loading">...</span>';
                return;
            }
            // PHASE 4-5: Professional SVG icons + status colors
            const imgUsed = data.images_used ?? 0;
            const imgLimit = data.images_limit ?? 0;
            const isPremium = data.isPremium || false;
            const msgRemaining = limit - used;
            const imgRemaining = imgLimit - imgUsed;
            // PHASE 1 FIX: Status based on REMAINING percentage (not used percentage).
            // Old code used (used/limit) which was BACKWARDS — 18% used = 82% remaining = should be healthy,
            // but old code showed 'critical' (red). Now uses remaining/limit.
            const msgRemainingPct = limit > 0 ? (msgRemaining / limit) : 0;
            const imgRemainingPct = imgLimit > 0 ? (imgRemaining / imgLimit) : 0;
            const msgStatus = msgRemaining === 0 ? 'empty' : msgRemainingPct < 0.2 ? 'critical' : msgRemainingPct < 0.5 ? 'warning' : 'healthy';
            const imgStatus = imgRemaining === 0 ? 'empty' : imgRemainingPct < 0.2 ? 'critical' : imgRemainingPct < 0.5 ? 'warning' : 'healthy';

            el.innerHTML = `
                <div class="ai-quota-row">
                    <button class="ai-quota-pill ai-quota-${msgStatus}" data-quota-type="chat" data-used="${used}" data-limit="${limit}" data-premium="${isPremium}" role="button" tabindex="0" aria-expanded="false" aria-label="سهمیه پیام‌های هوش مصنوعی">
                        <svg class="ai-quota-icon" width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
                            <path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z"/>
                        </svg>
                        <span class="ai-quota-text">${msgRemaining} / ${limit}</span>
                    </button>
                    <button class="ai-quota-pill ai-quota-${imgStatus}" data-quota-type="image" data-used="${imgUsed}" data-limit="${imgLimit}" data-premium="${isPremium}" role="button" tabindex="0" aria-expanded="false" aria-label="سهمیه تصاویر">
                        <svg class="ai-quota-icon" width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
                            <rect x="3" y="3" width="18" height="18" rx="2" ry="2"/>
                            <circle cx="8.5" cy="8.5" r="1.5"/>
                            <polyline points="21 15 16 10 5 21"/>
                        </svg>
                        <span class="ai-quota-text">${imgRemaining} / ${imgLimit}</span>
                    </button>
                </div>
            `;
            // PHASE 6-8: Bind popover events
            el.querySelectorAll('.ai-quota-pill').forEach(pill => {
                pill.addEventListener('click', (e) => this.showQuotaPopover(pill));
                pill.addEventListener('keydown', (e) => {
                    if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); this.showQuotaPopover(pill); }
                });
            });
        } catch (_) {
            // PHASE 3: On error, show nothing (not a fake number)
            el.classList.remove('ai-quota-loading-state');
            el.innerHTML = '';
        }
    },

    // PHASE 6-8: Quota popover
    showQuotaPopover(pill) {
        // Close existing popover
        this.hideQuotaPopover();
        const type = pill.dataset.quotaType;
        const used = parseInt(pill.dataset.used) || 0;
        const limit = parseInt(pill.dataset.limit) || 0;
        const isPremium = pill.dataset.premium === 'true';
        const remaining = limit - used;

        let title, body, remainingLabel;
        if (type === 'chat') {
            title = isPremium ? 'سهمیه پیام‌های Premium' : 'سهمیه پیام‌های هوش مصنوعی';
            body = isPremium
                ? 'با عضویت Premium می‌توانید روزانه تا ۱۰۰ پیام با دستیار هوش مصنوعی گفتگو کنید.'
                : 'این سهمیه تعداد پیام‌هایی را نشان می‌دهد که امروز می‌توانید با دستیار هوش مصنوعی ارسال کنید.';
            remainingLabel = `${remaining} از ${limit} پیام باقی مانده`;
        } else {
            title = isPremium ? 'سهمیه تصاویر Premium' : 'سهمیه تصاویر';
            body = isPremium
                ? 'شما می‌توانید روزانه تا ۱۰ تصویر برای Chat AI ارسال کنید.'
                : 'این سهمیه تعداد تصاویری را نشان می‌دهد که امروز می‌توانید برای Chat AI ارسال کنید.';
            remainingLabel = `${remaining} از ${limit} تصویر باقی مانده`;
        }

        const popover = document.createElement('div');
        popover.className = 'ai-quota-popover';
        popover.id = 'ai-quota-popover';
        popover.setAttribute('role', 'dialog');
        popover.setAttribute('aria-label', title);
        popover.innerHTML = `
            <div class="ai-quota-popover-header">
                <span class="ai-quota-popover-title">${title}</span>
                <button class="ai-quota-popover-close" aria-label="بستن" type="button">
                    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5">
                        <line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/>
                    </svg>
                </button>
            </div>
            <p class="ai-quota-popover-body">${body}</p>
            <div class="ai-quota-popover-remaining">${remainingLabel}</div>
            ${type === 'image' ? '<div class="ai-quota-popover-note">حداکثر حجم هر تصویر: ۱ MB — تصاویر بزرگ‌تر به‌صورت خودکار فشرده می‌شوند.</div>' : ''}
            <div class="ai-quota-popover-reset">سهمیه هر ۲۴ ساعت به‌صورت خودکار بازنشانی می‌شود.</div>
        `;
        // Position relative to pill
        const rect = pill.getBoundingClientRect();
        document.body.appendChild(popover);
        const popRect = popover.getBoundingClientRect();
        let left = rect.left + rect.width / 2 - popRect.width / 2;
        left = Math.max(8, Math.min(window.innerWidth - popRect.width - 8, left));
        let top = rect.bottom + 8;
        // If not enough space below, show above
        if (top + popRect.height > window.innerHeight - 8) {
            top = rect.top - popRect.height - 8;
        }
        popover.style.left = left + 'px';
        popover.style.top = top + 'px';
        pill.setAttribute('aria-expanded', 'true');

        // Close handlers
        popover.querySelector('.ai-quota-popover-close').addEventListener('click', () => this.hideQuotaPopover());
        const escHandler = (e) => { if (e.key === 'Escape') { this.hideQuotaPopover(); document.removeEventListener('keydown', escHandler); } };
        document.addEventListener('keydown', escHandler);
        // Click outside to close
        setTimeout(() => {
            const outsideHandler = (e) => {
                if (!popover.contains(e.target) && !pill.contains(e.target)) {
                    this.hideQuotaPopover();
                    document.removeEventListener('click', outsideHandler);
                }
            };
            document.addEventListener('click', outsideHandler);
        }, 10);
    },

    hideQuotaPopover() {
        const existing = document.getElementById('ai-quota-popover');
        if (existing) existing.remove();
        document.querySelectorAll('.ai-quota-pill').forEach(p => p.setAttribute('aria-expanded', 'false'));
    },

    // ITEM 1: Premium chat bubbles — user right, AI left with avatar
    appendBubble(role, content, imageUrl) {
        const box = document.getElementById('ai-messages');
        if (!box) return;
        // PHASE 7: Hide empty state when first message appears
        this.hideEmptyState();

        const wrapper = document.createElement('div');
        wrapper.className = `ai-msg-row ai-msg-${role}`;

        if (role === 'assistant') {
            // PHASE 3: Custom AI Digital Core avatar (same icon as FAB + header)
            const avatar = document.createElement('div');
            avatar.className = 'ai-msg-avatar';
            const avatarId = 'aiAv' + Date.now() + Math.random().toString(36).slice(2, 6);
            avatar.innerHTML = `<svg width="22" height="22" viewBox="0 0 56 56" fill="none">
                <defs><radialGradient id="${avatarId}" cx="50%" cy="50%" r="50%">
                    <stop offset="0%" stop-color="#FFD9A0"/><stop offset="100%" stop-color="#F5A623"/>
                </radialGradient></defs>
                <circle cx="28" cy="28" r="7" fill="url(#${avatarId})"/>
                <path d="M28 4 L30.5 18 L28 20 L25.5 18 Z" fill="#F5A623"/>
                <path d="M52 28 L38 30.5 L36 28 L38 25.5 Z" fill="#F5A623"/>
                <path d="M28 52 L25.5 38 L28 36 L30.5 38 Z" fill="#F5A623"/>
                <path d="M4 28 L18 25.5 L20 28 L18 30.5 Z" fill="#F5A623"/>
            </svg>`;
            wrapper.appendChild(avatar);
        }

        const bubble = document.createElement('div');
        bubble.className = `ai-msg-bubble ai-msg-bubble-${role}`;
        if (imageUrl) {
            const img = document.createElement('img');
            img.src = imageUrl;
            img.className = 'ai-msg-image';
            img.alt = '';
            bubble.appendChild(img);
        }
        if (content) {
            const text = document.createElement('div');
            text.className = 'ai-msg-text';
            // MARKDOWN FIX: convert basic markdown to HTML for rendering.
            // Previously used textContent → no markdown → user saw raw * ** - chars.
            // Now: safe inline conversion of **bold**, *italic*, bullet points, paragraphs.
            text.innerHTML = AssistantUI.renderMarkdown(content);
            bubble.appendChild(text);
        }
        wrapper.appendChild(bubble);
        box.appendChild(wrapper);

        // Smooth scroll to bottom
        requestAnimationFrame(() => {
            box.scrollTo({ top: box.scrollHeight, behavior: 'smooth' });
        });
    },

    // MARKDOWN FIX: safe markdown-to-HTML renderer for AI chat messages.
    // Converts **bold**, *italic*, bullet points (- ), and paragraphs.
    // Escapes HTML first to prevent XSS, then applies markdown transforms.
    renderMarkdown(text) {
        if (!text) return '';
        // 1. Escape HTML to prevent XSS
        let html = text
            .replace(/&/g, '&amp;')
            .replace(/</g, '&lt;')
            .replace(/>/g, '&gt;');
        // 2. Convert **bold** → <strong>
        html = html.replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>');
        // 3. Convert *italic* → <em> (but not inside <strong>)
        html = html.replace(/\*([^*]+)\*/g, '<em>$1</em>');
        // 4. Convert bullet points (lines starting with - or •) → <ul><li>
        const lines = html.split('\n');
        let result = [];
        let inList = false;
        for (const line of lines) {
            const trimmed = line.trim();
            if (trimmed.startsWith('- ') || trimmed.startsWith('• ')) {
                if (!inList) { result.push('<ul>'); inList = true; }
                result.push('<li>' + trimmed.slice(2) + '</li>');
            } else {
                if (inList) { result.push('</ul>'); inList = false; }
                if (trimmed) result.push('<p>' + trimmed + '</p>');
            }
        }
        if (inList) result.push('</ul>');
        return result.join('');
    },

    // PHASE 7: Empty state management
    hideEmptyState() {
        const empty = document.getElementById('ai-empty-state');
        if (empty) empty.style.display = 'none';
    },

    showEmptyState() {
        const empty = document.getElementById('ai-empty-state');
        if (empty) empty.style.display = '';
    },

    // ITEM 2: Typing indicator — animated dots, "در حال تحلیل..."
    showTyping() {
        const box = document.getElementById('ai-messages');
        if (!box) return;

        // Remove any existing typing indicator
        this.hideTyping();

        const wrapper = document.createElement('div');
        wrapper.className = 'ai-msg-row ai-msg-assistant';
        wrapper.id = 'ai-typing-indicator';

        const avatar = document.createElement('div');
        avatar.className = 'ai-msg-avatar';
        const typingId = 'aiTyping' + Date.now();
        avatar.innerHTML = `<svg width="22" height="22" viewBox="0 0 56 56" fill="none">
            <defs><radialGradient id="${typingId}" cx="50%" cy="50%" r="50%">
                <stop offset="0%" stop-color="#FFD9A0"/><stop offset="100%" stop-color="#F5A623"/>
            </radialGradient></defs>
            <circle cx="28" cy="28" r="7" fill="url(#${typingId})"/>
            <path d="M28 4 L30.5 18 L28 20 L25.5 18 Z" fill="#F5A623"/>
            <path d="M52 28 L38 30.5 L36 28 L38 25.5 Z" fill="#F5A623"/>
            <path d="M28 52 L25.5 38 L28 36 L30.5 38 Z" fill="#F5A623"/>
            <path d="M4 28 L18 25.5 L20 28 L18 30.5 Z" fill="#F5A623"/>
        </svg>`;
        wrapper.appendChild(avatar);

        const bubble = document.createElement('div');
        bubble.className = 'ai-msg-bubble ai-msg-bubble-assistant ai-typing-bubble';
        bubble.innerHTML = `
            <span class="ai-typing-label">در حال تحلیل</span>
            <span class="ai-typing-dots">
                <span class="ai-typing-dot"></span>
                <span class="ai-typing-dot"></span>
                <span class="ai-typing-dot"></span>
            </span>
        `;
        wrapper.appendChild(bubble);
        box.appendChild(wrapper);

        requestAnimationFrame(() => {
            box.scrollTo({ top: box.scrollHeight, behavior: 'smooth' });
        });
    },

    hideTyping() {
        document.getElementById('ai-typing-indicator')?.remove();
    },

    pendingImage: null,
    pendingFileText: null,
    pendingFileMeta: null,
    // PHASE 3: Formalized attachment state machine.
    // pendingAttachment tracks the REAL attachment that sendMessage() will use.
    // States: idle → processing → ready → sending → idle (or error → idle)
    // CRITICAL: Preview is ALWAYS derived from pendingAttachment, never independent.
    pendingAttachment: null, // { status, file, name, type, size, data, originalSize, finalSize, compressed, generation }

    // PHASE 4: Convert Blob/File to Base64 Data URL (what backend expects).
    // Returns a Promise<string> — must be awaited.
    fileToBase64(blob) {
        return new Promise((resolve, reject) => {
            const reader = new FileReader();
            reader.onload = () => resolve(reader.result);
            reader.onerror = () => reject(new Error('FileReader error'));
            reader.readAsDataURL(blob);
        });
    },

    // PHASE 12: Client-side image compression with progressive quality reduction.
    // Handles PNG transparency by keeping PNG format when needed.
    // Returns { blob, originalSize, finalSize, compressed }.
    async compressImage(file) {
        const MAX_SIZE = 1 * 1024 * 1024; // 1MB target
        const MAX_DIMENSION = 1280;
        const originalSize = file.size;

        // If already small enough, return as-is
        if (file.size <= MAX_SIZE) {
            return { blob: file, originalSize, finalSize: file.size, compressed: false };
        }

        return new Promise((resolve, reject) => {
            const img = new Image();
            const reader = new FileReader();
            reader.onload = () => {
                img.src = reader.result;
                img.onload = () => {
                    let { width, height } = img;
                    if (width > MAX_DIMENSION || height > MAX_DIMENSION) {
                        const ratio = Math.min(MAX_DIMENSION / width, MAX_DIMENSION / height);
                        width = Math.round(width * ratio);
                        height = Math.round(height * ratio);
                    }
                    const canvas = document.createElement('canvas');
                    canvas.width = width;
                    canvas.height = height;
                    const ctx = canvas.getContext('2d');
                    ctx.drawImage(img, 0, 0, width, height);

                    // PHASE 13: Check if PNG with transparency — keep PNG if so
                    const isPng = file.type === 'image/png';
                    const qualities = [0.85, 0.75, 0.65, 0.55];
                    let attempt = 0;

                    const tryCompress = () => {
                        if (attempt >= qualities.length) {
                            // All attempts failed — return the last result anyway
                            resolve({ blob: file, originalSize, finalSize: file.size, compressed: false });
                            return;
                        }
                        const quality = qualities[attempt];
                        const mimeType = isPng ? 'image/png' : 'image/jpeg';
                        canvas.toBlob((blob) => {
                            if (!blob) {
                                attempt++;
                                tryCompress();
                                return;
                            }
                            if (blob.size <= MAX_SIZE) {
                                resolve({ blob, originalSize, finalSize: blob.size, compressed: true });
                            } else {
                                attempt++;
                                tryCompress();
                            }
                        }, mimeType, quality);
                    };
                    tryCompress();
                };
                img.onerror = () => resolve({ blob: file, originalSize, finalSize: file.size, compressed: false });
            };
            reader.onerror = () => reject(new Error('FileReader error'));
            reader.readAsDataURL(file);
        });
    },

    // PHASE 9-10: File preview card with size visualization
    // CRITICAL: Preview is built from pendingAttachment (the REAL send state),
    // not from a separate File object. This ensures preview = what gets sent.
    showFilePreview(attachment) {
        // Remove existing preview
        this.removeFilePreview();
        if (!attachment) return;
        const file = attachment.file;
        const originalSize = attachment.originalSize || attachment.size || 0;
        const finalSize = attachment.finalSize || attachment.size || 0;
        const compressed = attachment.compressed || false;
        const status = attachment.status || 'idle';
        const MAX_SIZE = 1 * 1024 * 1024;
        // PHASE 6: When ready, progress bar = 100%. When processing, animated.
        const sizePct = status === 'ready' ? 100 : Math.min(100, (finalSize / MAX_SIZE) * 100);
        // PHASE 10: Three states — healthy (<800KB), warning (800KB-1MB), critical (>1MB)
        let sizeStatus, sizeLabel, sizeColor;
        if (finalSize < 800 * 1024) {
            sizeStatus = 'healthy';
            sizeLabel = 'حجم مناسب';
            sizeColor = '#22c55e';
        } else if (finalSize <= MAX_SIZE) {
            sizeStatus = 'warning';
            sizeLabel = 'نزدیک سقف حجم';
            sizeColor = '#F5A623';
        } else {
            sizeStatus = 'critical';
            sizeLabel = 'بیش از حد مجاز';
            sizeColor = '#ef4444';
        }
        // PHASE 5: If status is 'ready', show ready label instead of size label
        const readyLabel = status === 'ready' ? 'آماده ارسال' : (status === 'error' ? 'خطا در آماده‌سازی' : sizeLabel);
        const readyColor = status === 'ready' ? '#22c55e' : (status === 'error' ? '#ef4444' : sizeColor);

        const formatSize = (bytes) => {
            if (bytes < 1024) return bytes + ' B';
            if (bytes < 1024 * 1024) return (bytes / 1024).toFixed(1) + ' KB';
            return (bytes / (1024 * 1024)).toFixed(2) + ' MB';
        };

        const preview = document.createElement('div');
        preview.id = 'ai-file-preview';
        preview.className = 'ai-file-preview' + (status === 'ready' ? ' ai-file-ready' : '') + (status === 'error' ? ' ai-file-error' : '');
        preview.innerHTML = `
            <div class="ai-file-preview-header">
                <div class="ai-file-preview-thumb"></div>
                <div class="ai-file-preview-info">
                    <div class="ai-file-preview-name">${file.name}</div>
                    <div class="ai-file-preview-size-row">
                        ${compressed ? `<span class="ai-file-size-original">${formatSize(originalSize)}</span> <svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><line x1="5" y1="12" x2="19" y2="12"/><polyline points="12 5 19 12 12 19"/></svg> <span class="ai-file-size-final">${formatSize(finalSize)}</span>` : `<span class="ai-file-size-final">${formatSize(finalSize)}</span>`}
                    </div>
                </div>
            </div>
            <div class="ai-file-size-bar">
                <div class="ai-file-size-bar-fill ai-file-size-${sizeStatus}" style="width:${sizePct}%"></div>
            </div>
            <div class="ai-file-preview-status">
                <span class="ai-file-status-text" style="color:${readyColor}">
                    <svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5">
                        ${status === 'ready' ? '<polyline points="20 6 9 17 4 12"/>' : sizeStatus === 'healthy' ? '<polyline points="20 6 9 17 4 12"/>' : sizeStatus === 'warning' ? '<path d="M12 9v4"/><path d="M12 17h.01"/><path d="M10.29 3.86L1.82 18a2 2 0 0 0 1.71 3h16.94a2 2 0 0 0 1.71-3L13.71 3.86a2 2 0 0 0-3.42 0z"/>' : '<circle cx="12" cy="12" r="10"/><line x1="15" y1="9" x2="9" y2="15"/><line x1="9" y1="9" x2="15" y2="15"/>'}
                    </svg>
                    ${readyLabel}
                </span>
                <div class="ai-file-preview-actions">
                    <button class="ai-file-remove" type="button" aria-label="حذف فایل">
                        <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                            <polyline points="3 6 5 6 21 6"/><path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"/>
                        </svg>
                        حذف
                    </button>
                </div>
            </div>
        `;
        // Load thumbnail from the REAL attachment data (Base64)
        if (attachment.data && file.type.startsWith('image/')) {
            const thumb = preview.querySelector('.ai-file-preview-thumb');
            thumb.style.backgroundImage = `url(${attachment.data})`;
        } else if (file.type.startsWith('image/') && !attachment.data) {
            // Fallback: read file for thumbnail (but attachment.data is the real send state)
            const thumbReader = new FileReader();
            thumbReader.onload = () => {
                const thumb = preview.querySelector('.ai-file-preview-thumb');
                thumb.style.backgroundImage = `url(${thumbReader.result})`;
            };
            thumbReader.readAsDataURL(file);
        }
        // Remove button
        preview.querySelector('.ai-file-remove').addEventListener('click', () => {
            this.clearAttachment();
        });
        // PHASE 7: Insert into composer attachment area (above input, NOT in messages)
        const composerAttach = document.getElementById('ai-composer-attachment');
        if (composerAttach) {
            composerAttach.innerHTML = '';
            composerAttach.appendChild(preview);
            composerAttach.style.display = 'block';
        } else {
            // Fallback: insert before messages (shouldn't happen with correct HTML)
            const messages = document.getElementById('ai-messages');
            messages.parentNode.insertBefore(preview, messages);
        }
    },

    // PHASE 10: Clear attachment completely (remove + reset state)
    clearAttachment() {
        this.pendingAttachment = null;
        this.pendingImage = null;
        this.pendingFileText = null;
        this.pendingFileMeta = null;
        this.removeFilePreview();
        // PHASE 7: Hide composer attachment area
        const composerAttach = document.getElementById('ai-composer-attachment');
        if (composerAttach) composerAttach.style.display = 'none';
        this.updateSendButtonState();
    },

    // PHASE 5: Update send button enabled/disabled based on attachment status
    updateSendButtonState() {
        const sendBtn = document.getElementById('ai-send');
        if (!sendBtn) return;
        const input = document.getElementById('ai-input');
        const hasMessage = input?.value?.trim();
        const attachment = this.pendingAttachment;
        const hasReadyAttachment = attachment && attachment.status === 'ready';
        const isProcessing = attachment && attachment.status === 'processing';
        // Disable if processing (compression in progress)
        if (isProcessing) {
            sendBtn.disabled = true;
            sendBtn.style.opacity = '0.5';
        } else if (hasMessage || hasReadyAttachment) {
            sendBtn.disabled = false;
            sendBtn.style.opacity = '1';
        } else {
            sendBtn.disabled = false;
            sendBtn.style.opacity = '1';
        }
    },

    removeFilePreview() {
        document.getElementById('ai-file-preview')?.remove();
        // PHASE 7: Also hide composer attachment area
        const composerAttach = document.getElementById('ai-composer-attachment');
        if (composerAttach) {
            composerAttach.innerHTML = '';
            composerAttach.style.display = 'none';
        }
    },

    // PHASE 11: Image validation + compression with preview
    // CRITICAL FIX: This function now properly awaits ALL async operations
    // (compression + Base64 conversion) before setting status='ready'.
    // Previously, FileReader.readAsDataURL was not awaited, causing pendingImage
    // to be null when the user clicked Send despite the preview showing.
    async handleFile(e) {
        const file = e.target.files?.[0];
        if (!file) return;

        // PHASE 9: Race condition protection — use generation token
        const generation = Date.now() + '_' + Math.random().toString(36).slice(2, 8);
        this._fileGeneration = generation;

        const MAX_FILE_SIZE = 1 * 1024 * 1024; // 1MB
        let compressionResult = { blob: file, originalSize: file.size, finalSize: file.size, compressed: false };

        // PHASE 3: Set attachment state to 'processing' immediately
        this.pendingAttachment = {
            status: 'processing',
            file: file,
            name: file.name,
            type: file.type,
            size: file.size,
            data: null,
            originalSize: file.size,
            finalSize: file.size,
            compressed: false,
            generation: generation,
        };
        this.updateSendButtonState();

        if (file.type.startsWith('image/') && file.size > MAX_FILE_SIZE) {
            // PHASE 11: Show compression in progress
            this.showCompressionProgress(file);
            try {
                compressionResult = await this.compressImage(file);
                // Check if a newer file was selected (race condition)
                if (this._fileGeneration !== generation) return; // superseded
                this.removeCompressionProgress();
                // If still >1MB after compression, reject
                if (compressionResult.finalSize > MAX_FILE_SIZE) {
                    this.pendingAttachment = { status: 'error', file, name: file.name, type: file.type, size: file.size, data: null, generation };
                    this.showFilePreview(this.pendingAttachment);
                    this.appendBubble('assistant', 'حجم تصویر حتی پس از فشرده‌سازی بیشتر از ۱ مگابایت است');
                    e.target.value = '';
                    this.updateSendButtonState();
                    return;
                }
            } catch (err) {
                if (this._fileGeneration !== generation) return;
                this.removeCompressionProgress();
                this.pendingAttachment = { status: 'error', file, name: file.name, type: file.type, size: file.size, data: null, generation };
                this.showFilePreview(this.pendingAttachment);
                this.appendBubble('assistant', 'خطا در پردازش تصویر');
                e.target.value = '';
                this.updateSendButtonState();
                return;
            }
        } else if (file.size > MAX_FILE_SIZE && !file.type.startsWith('image/')) {
            this.pendingAttachment = null;
            this.appendBubble('assistant', 'حجم فایل نباید بیشتر از ۱ مگابایت باشد');
            e.target.value = '';
            this.updateSendButtonState();
            return;
        }

        // PHASE 4: Convert optimized Blob to Base64 (what backend expects).
        // CRITICAL: This MUST be awaited. Previously was async-without-await.
        if (file.type.startsWith('image/')) {
            try {
                const optimizedBlob = compressionResult.blob || file;
                const base64Data = await this.fileToBase64(optimizedBlob);
                // Check if a newer file was selected (race condition)
                if (this._fileGeneration !== generation) return;
                // PHASE 4: NOW the attachment is truly READY — data is encoded
                this.pendingAttachment = {
                    status: 'ready',
                    file: file,
                    name: file.name,
                    type: optimizedBlob.type || file.type,
                    size: optimizedBlob.size,
                    data: base64Data,
                    originalSize: compressionResult.originalSize,
                    finalSize: compressionResult.finalSize,
                    compressed: compressionResult.compressed,
                    generation: generation,
                };
                // Keep pendingImage in sync (sendMessage reads this for backward compat)
                this.pendingImage = base64Data;
                this.pendingFileMeta = {
                    name: file.name,
                    type: file.type,
                    originalSize: compressionResult.originalSize,
                    finalSize: compressionResult.finalSize,
                    compressed: compressionResult.compressed,
                };
                // PHASE 6: Show preview from the REAL attachment (data is ready)
                this.showFilePreview(this.pendingAttachment);
                this.updateSendButtonState();
            } catch (err) {
                if (this._fileGeneration !== generation) return;
                this.pendingAttachment = { status: 'error', file, name: file.name, type: file.type, size: file.size, data: null, generation };
                this.showFilePreview(this.pendingAttachment);
                this.appendBubble('assistant', 'آماده‌سازی تصویر انجام نشد. لطفاً دوباره تلاش کنید.');
                this.updateSendButtonState();
            }
        } else {
            // Text file — no compression needed
            const reader = new FileReader();
            reader.onload = () => {
                if (this._fileGeneration !== generation) return;
                const text = String(reader.result).slice(0, 3000);
                this.pendingFileText = text;
                this.pendingAttachment = {
                    status: 'ready',
                    file: file,
                    name: file.name,
                    type: file.type,
                    size: file.size,
                    data: text,
                    originalSize: file.size,
                    finalSize: file.size,
                    compressed: false,
                    generation: generation,
                };
                this.updateSendButtonState();
            };
            reader.readAsText(file);
        }
        e.target.value = '';
    },

    showCompressionProgress(file) {
        this.removeFilePreview();
        const preview = document.createElement('div');
        preview.id = 'ai-file-preview';
        preview.className = 'ai-file-preview ai-file-compressing';
        preview.innerHTML = `
            <div class="ai-file-preview-header">
                <div class="ai-file-preview-thumb ai-file-preview-thumb-loading"></div>
                <div class="ai-file-preview-info">
                    <div class="ai-file-preview-name">${file.name}</div>
                    <div class="ai-file-compressing-text">در حال بهینه‌سازی تصویر...</div>
                </div>
            </div>
        `;
        // PHASE 7: Insert into composer attachment area (not above messages)
        const composerAttach = document.getElementById('ai-composer-attachment');
        if (composerAttach) {
            composerAttach.innerHTML = '';
            composerAttach.appendChild(preview);
            composerAttach.style.display = 'block';
        } else {
            const messages = document.getElementById('ai-messages');
            messages.parentNode.insertBefore(preview, messages);
        }
    },

    removeCompressionProgress() {
        // Same as removeFilePreview — just removes the element
        this.removeFilePreview();
    },

    async send() {
        if (this.sending) return;
        const input = document.getElementById('ai-input');
        const message = input?.value?.trim();
        // PHASE 5: Check attachment status — don't send if still processing
        const attachment = this.pendingAttachment;
        const hasReadyAttachment = attachment && attachment.status === 'ready' && attachment.data;
        const isProcessing = attachment && attachment.status === 'processing';
        if (isProcessing) return; // Send disabled during compression
        // Use attachment.data (authoritative) OR pendingImage (backward compat)
        const imageData = hasReadyAttachment ? attachment.data : this.pendingImage;
        if (!message && !imageData) return;
        if (!API_BASE || (typeof isGuestUserId === 'function' ? isGuestUserId(getUserId()) : String(getUserId()).startsWith('guest_'))) {
            alert(typeof t === 'function' ? t('join_guest_hint') : 'Open from Telegram');
            return;
        }

        const userMsg = message || '[تصویر]';
        // PHASE 5: Show image + text in user message bubble BEFORE sending
        if (imageData) {
            this.appendBubble('user', message || '', imageData);
        } else if (message) {
            this.appendBubble('user', message);
        }
        if (input) input.value = '';
        this.sending = true;

        // ITEM 2: Show typing indicator
        this.showTyping();

        let fullMessage = message || 'Describe this image in context of crypto trading.';
        if (this.pendingFileText) {
            fullMessage += `\n\nAttached file content:\n${this.pendingFileText}`;
            this.pendingFileText = null;
        }

        try {
            // PHASE 7: Payload audit — verify attachment is actually in payload
            const payload = {
                message: fullMessage,
                // PHASE FIX: Reduced from 6 → 4 messages (last 2 exchanges).
                // With 4 × 2000 chars = 8000 chars max — well within all provider context windows.
                history: this.history.slice(-8),
                image: imageData || null,
                context: this.getContext ? this.getContext() : null
            };
            // PHASE 7: Payload audit logging (no base64 content, just metadata)
            console.log('[ChatAI] Payload audit:', {
                hasMessage: !!payload.message,
                messageLength: payload.message?.length || 0,
                hasImage: !!payload.image,
                imageType: attachment?.type || 'unknown',
                imageName: attachment?.name || 'unknown',
                imageSize: attachment?.size || 0,
                imageDataLength: payload.image?.length || 0,
                imageCompressed: attachment?.compressed || false,
                attachmentStatus: attachment?.status || 'none',
            });
            // PHASE 6: Do NOT clear pendingImage here — only after success
            // Old code cleared pendingImage before API call, breaking retry on failure

            const data = await apiFetch('/api/assistant/chat', {
                method: 'POST',
                body: JSON.stringify(payload)
            });

            // ITEM 2: Hide typing indicator
            this.hideTyping();

            if (data.status === 'success') {
                this.history.push({ role: 'user', content: userMsg });
                this.history.push({ role: 'assistant', content: data.reply });
                this.appendBubble('assistant', data.reply);
                // PHASE 6: Quota consumed on success — clear attachment + composer
                this.clearAttachment();
            } else {
                // ITEM 5: Better error messages for rate limiting
                let errMsg;
                if (data.reason === 'cooldown') {
                    errMsg = data.message || 'لطفاً چند ثانیه صبر کنید';
                } else if (data.reason === 'daily_message_limit') {
                    errMsg = data.message || 'محدودیت پیام روزانه تمام شده است';
                } else if (data.reason === 'image_too_large') {
                    errMsg = data.message || 'حجم تصویر زیاد است';
                } else if (data.reason === 'daily_image_limit') {
                    errMsg = data.message || 'محدودیت ارسال تصویر تمام شده است';
                } else {
                    errMsg = data.message || data.detail || (typeof t === 'function' ? t('ai_error') : 'Error');
                }
                this.appendBubble('assistant', errMsg);
            }
            this.refreshLimits();
        } catch (e) {
            this.hideTyping();
            // PHASE FIX: Handle 429/503 gracefully — apiFetch throws on non-200.
            // Previously, ALL non-200 responses (including cooldown 429) showed a
            // generic "AI unavailable" message. Now we parse the error body and
            // show the specific reason (cooldown, daily limit, etc.).
            let errMsg = typeof t === 'function' ? t('ai_error') : 'Assistant unavailable';
            if (e && e.status === 429) {
                // Try to parse the response body from the error message
                try {
                    const parsed = JSON.parse(e.message);
                    if (parsed.reason === 'cooldown') {
                        errMsg = parsed.message || 'لطفاً چند ثانیه صبر کنید';
                    } else if (parsed.reason === 'daily_message_limit') {
                        errMsg = parsed.message || 'محدودیت پیام روزانه تمام شده است';
                    } else if (parsed.reason === 'daily_image_limit') {
                        errMsg = parsed.message || 'محدودیت ارسال تصویر تمام شده است';
                    } else if (parsed.message) {
                        errMsg = parsed.message;
                    }
                } catch (_) {
                    // e.message is not JSON — use generic error
                    errMsg = 'لطفاً چند ثانیه صبر کنید و دوباره تلاش کنید';
                }
            } else if (e && e.status === 503) {
                errMsg = typeof t === 'function' ? t('ai_error') : 'AI service temporarily unavailable';
            }
            this.appendBubble('assistant', errMsg);
            console.warn('AI send error:', e.status || 'no-status', e.message?.slice(0, 100));
        } finally {
            this.sending = false;
        }
    }
};

document.addEventListener('DOMContentLoaded', () => AssistantUI.init());
window.AssistantUI = AssistantUI;
