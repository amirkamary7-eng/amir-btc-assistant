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
                    <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5">
                        <line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/>
                    </svg>
                </button>
                <p class="ai-speech-text">چطور می‌تونم کمکتون کنم؟ سوالی دارید بپرسید ✨</p>
                <span class="ai-bubble-tail"></span>
            </div>
            <button id="ai-fab" class="ai-fab" aria-label="AI Assistant">
                <span class="ai-fab-glow"></span>
                <svg class="ai-fab-icon" width="28" height="28" viewBox="0 0 24 24" fill="none">
                    <defs>
                        <linearGradient id="aiFabGrad" x1="0%" y1="0%" x2="100%" y2="100%">
                            <stop offset="0%" stop-color="#FFE9A0"/>
                            <stop offset="50%" stop-color="#F5A623"/>
                            <stop offset="100%" stop-color="#D4881A"/>
                        </linearGradient>
                    </defs>
                    <path d="M12 2.5c.9 0 1.6.7 1.6 1.6 0 .6-.3 1.1-.8 1.4v1.1h.9c3.5 0 6.3 2.8 6.3 6.3v.5c.6 0 1 .4 1 1v1.5c0 .6-.4 1-1 1h-.5c-.8 2.2-2.8 3.8-5.2 3.8H8.5c-2.4 0-4.4-1.6-5.2-3.8H3c-.6 0-1-.4-1-1V14c0-.6.4-1 1-1v-.5c0-3.5 2.8-6.3 6.3-6.3h.9V5.5c-.5-.3-.8-.8-.8-1.4 0-.9.7-1.6 1.6-1.6z" fill="url(#aiFabGrad)"/>
                    <circle cx="9" cy="13.5" r="1.1" fill="#0d1828"/>
                    <circle cx="15" cy="13.5" r="1.1" fill="#0d1828"/>
                    <path d="M9.5 16.5c.8.6 1.7.9 2.5.9s1.7-.3 2.5-.9" stroke="#0d1828" stroke-width="1.2" stroke-linecap="round"/>
                </svg>
            </button>
            <div id="ai-panel" class="ai-panel" style="display:none;">
                <div class="ai-panel-header">
                    <div class="ai-panel-title">
                        <div class="ai-avatar-mini">
                            <svg width="20" height="20" viewBox="0 0 24 24" fill="none">
                                <defs>
                                    <linearGradient id="aiAvatarGrad" x1="0%" y1="0%" x2="100%" y2="100%">
                                        <stop offset="0%" stop-color="#FFE9A0"/>
                                        <stop offset="100%" stop-color="#F5A623"/>
                                    </linearGradient>
                                </defs>
                                <path d="M12 2.5c.9 0 1.6.7 1.6 1.6 0 .6-.3 1.1-.8 1.4v1.1h.9c3.5 0 6.3 2.8 6.3 6.3v.5c.6 0 1 .4 1 1v1.5c0 .6-.4 1-1 1h-.5c-.8 2.2-2.8 3.8-5.2 3.8H8.5c-2.4 0-4.4-1.6-5.2-3.8H3c-.6 0-1-.4-1-1V14c0-.6.4-1 1-1v-.5c0-3.5 2.8-6.3 6.3-6.3h.9V5.5c-.5-.3-.8-.8-.8-1.4 0-.9.7-1.6 1.6-1.6z" fill="url(#aiAvatarGrad)"/>
                            </svg>
                        </div>
                        <span data-i18n="ai_title">دستیار هوشمند</span>
                    </div>
                    <button id="ai-close" class="ai-close-btn" aria-label="Close">
                        <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                            <line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/>
                        </svg>
                    </button>
                </div>
                <div id="ai-limits" class="ai-limits"></div>
                <div id="ai-messages" class="ai-messages"></div>
                <div class="ai-input-area">
                    <input type="file" id="ai-file" accept="image/*" hidden>
                    <button id="ai-attach" class="ai-attach-btn" title="Attach image">
                        <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                            <path d="M21.44 11.05l-9.19 9.19a6 6 0 0 1-8.49-8.49l9.19-9.19a4 4 0 0 1 5.66 5.66l-9.2 9.19a2 2 0 0 1-2.83-2.83l8.49-8.48"/>
                        </svg>
                    </button>
                    <textarea id="ai-input" class="ai-input" rows="1" placeholder="پیام خود را بنویسید..."></textarea>
                    <button id="ai-send" class="ai-send-btn">
                        <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                            <line x1="22" y1="2" x2="11" y2="13"/><polygon points="22 2 15 22 11 13 2 9 22 2"/>
                        </svg>
                    </button>
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
        if (localStorage.getItem('ai_speech_dismissed') === '1') {
            bubble.classList.add('ai-speech-hidden');
            return;
        }
        const dismiss = () => {
            if (bubble.classList.contains('ai-speech-hidden')) return;
            bubble.classList.add('ai-speech-hidden');
            localStorage.setItem('ai_speech_dismissed', '1');
        };
        closeBtn?.addEventListener('click', (e) => { e.preventDefault(); e.stopPropagation(); dismiss(); });
        window.setTimeout(dismiss, 8000);
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
        if (this.open) { this.refreshLimits(); document.getElementById('ai-input')?.focus(); }
    },

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
            if (el) el.innerText = '';
            return;
        }
        try {
            const data = await apiFetch(`/api/assistant/limits?user_id=${encodeURIComponent(getUserId())}`);
            const used = data.messages_used ?? 0;
            const limit = data.messages_limit ?? 50;
            el.innerText = typeof t === 'function'
                ? `${used}/${limit} ${t('ai_messages_today')}`
                : `${used}/${limit} messages today`;
        } catch (_) {}
    },

    // ITEM 1: Premium chat bubbles — user right, AI left with avatar
    appendBubble(role, content, imageUrl) {
        const box = document.getElementById('ai-messages');
        if (!box) return;

        const wrapper = document.createElement('div');
        wrapper.className = `ai-msg-row ai-msg-${role}`;

        if (role === 'assistant') {
            // AI avatar
            const avatar = document.createElement('div');
            avatar.className = 'ai-msg-avatar';
            avatar.innerHTML = `<svg width="20" height="20" viewBox="0 0 24 24" fill="none">
                <defs><linearGradient id="aiB${Date.now()}" x1="0%" y1="0%" x2="100%" y2="100%">
                    <stop offset="0%" stop-color="#FFE9A0"/><stop offset="100%" stop-color="#F5A623"/>
                </linearGradient></defs>
                <path d="M12 2.5c.9 0 1.6.7 1.6 1.6 0 .6-.3 1.1-.8 1.4v1.1h.9c3.5 0 6.3 2.8 6.3 6.3v.5c.6 0 1 .4 1 1v1.5c0 .6-.4 1-1 1h-.5c-.8 2.2-2.8 3.8-5.2 3.8H8.5c-2.4 0-4.4-1.6-5.2-3.8H3c-.6 0-1-.4-1-1V14c0-.6.4-1 1-1v-.5c0-3.5 2.8-6.3 6.3-6.3h.9V5.5c-.5-.3-.8-.8-.8-1.4 0-.9.7-1.6 1.6-1.6z" fill="url(#aiB${Date.now()})"/>
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
            text.textContent = content;
            bubble.appendChild(text);
        }
        wrapper.appendChild(bubble);
        box.appendChild(wrapper);

        // Smooth scroll to bottom
        requestAnimationFrame(() => {
            box.scrollTo({ top: box.scrollHeight, behavior: 'smooth' });
        });
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
        avatar.innerHTML = `<svg width="20" height="20" viewBox="0 0 24 24" fill="none">
            <defs><linearGradient id="aiTyping" x1="0%" y1="0%" x2="100%" y2="100%">
                <stop offset="0%" stop-color="#FFE9A0"/><stop offset="100%" stop-color="#F5A623"/>
            </linearGradient></defs>
            <path d="M12 2.5c.9 0 1.6.7 1.6 1.6 0 .6-.3 1.1-.8 1.4v1.1h.9c3.5 0 6.3 2.8 6.3 6.3v.5c.6 0 1 .4 1 1v1.5c0 .6-.4 1-1 1h-.5c-.8 2.2-2.8 3.8-5.2 3.8H8.5c-2.4 0-4.4-1.6-5.2-3.8H3c-.6 0-1-.4-1-1V14c0-.6.4-1 1-1v-.5c0-3.5 2.8-6.3 6.3-6.3h.9V5.5c-.5-.3-.8-.8-.8-1.4 0-.9.7-1.6 1.6-1.6z" fill="url(#aiTyping)"/>
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

    // ITEM 6: Image validation — max 1MB before upload
    handleFile(e) {
        const file = e.target.files?.[0];
        if (!file) return;

        // ITEM 6 FIX: Validate file size (max 1MB)
        const MAX_FILE_SIZE = 1 * 1024 * 1024; // 1MB
        if (file.size > MAX_FILE_SIZE) {
            this.appendBubble('assistant', '❌ حجم فایل نباید بیشتر از ۱ مگابایت باشد');
            e.target.value = '';
            return;
        }

        if (file.type.startsWith('image/')) {
            const reader = new FileReader();
            reader.onload = () => {
                this.pendingImage = reader.result;
                this.appendBubble('user', '', reader.result);
            };
            reader.readAsDataURL(file);
        } else {
            const reader = new FileReader();
            reader.onload = () => {
                const text = String(reader.result).slice(0, 3000);
                this.pendingFileText = text;
                this.appendBubble('user', `📎 ${file.name}\n${text.slice(0, 200)}...`);
            };
            reader.readAsText(file);
        }
        e.target.value = '';
    },

    async send() {
        if (this.sending) return;
        const input = document.getElementById('ai-input');
        const message = input?.value?.trim();
        if (!message && !this.pendingImage) return;
        if (!API_BASE || (typeof isGuestUserId === 'function' ? isGuestUserId(getUserId()) : String(getUserId()).startsWith('guest_'))) {
            alert(typeof t === 'function' ? t('join_guest_hint') : 'Open from Telegram');
            return;
        }

        const userMsg = message || '[تصویر]';
        if (message) this.appendBubble('user', message);
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
            const payload = {
                message: fullMessage,
                // PHASE FIX: Reduced from 6 → 4 messages (last 2 exchanges).
                // With 4 × 2000 chars = 8000 chars max — well within all provider context windows.
                history: this.history.slice(-4),
                image: this.pendingImage || null,
                context: this.getContext ? this.getContext() : null
            };
            this.pendingImage = null;

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
            } else {
                // ITEM 5: Better error messages for rate limiting
                let errMsg;
                if (data.reason === 'cooldown') {
                    errMsg = `⏳ ${data.message || 'لطفاً چند ثانیه صبر کنید'}`;
                } else if (data.reason === 'daily_message_limit') {
                    errMsg = `📊 ${data.message || 'محدودیت پیام روزانه تمام شده است'}`;
                } else if (data.reason === 'image_too_large') {
                    errMsg = `❌ ${data.message || 'حجم تصویر زیاد است'}`;
                } else if (data.reason === 'daily_image_limit') {
                    errMsg = `📊 ${data.message || 'محدودیت ارسال تصویر تمام شده است'}`;
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
                        errMsg = `⏳ ${parsed.message || 'لطفاً چند ثانیه صبر کنید'}`;
                    } else if (parsed.reason === 'daily_message_limit') {
                        errMsg = `📊 ${parsed.message || 'محدودیت پیام روزانه تمام شده است'}`;
                    } else if (parsed.reason === 'daily_image_limit') {
                        errMsg = `📊 ${parsed.message || 'محدودیت ارسال تصویر تمام شده است'}`;
                    } else if (parsed.message) {
                        errMsg = parsed.message;
                    }
                } catch (_) {
                    // e.message is not JSON — use generic error
                    errMsg = '⏳ لطفاً چند ثانیه صبر کنید و دوباره تلاش کنید';
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
