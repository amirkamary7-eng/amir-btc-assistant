// ============================================================
// AI Assistant — floating UI, chat, file/image support
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
        root.innerHTML = `
            <button id="ai-fab" class="ai-fab" aria-label="AI Assistant">
                <svg width="26" height="26" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8">
                    <path d="M12 2a2 2 0 0 1 2 2c0 .74-.4 1.39-1 1.73V7h1a7 7 0 0 1 7 7h1a1 1 0 0 1 1 1v3a1 1 0 0 1-1 1h-1.07A7.001 7.001 0 0 1 5.07 19H4a1 1 0 0 1-1-1v-3a1 1 0 0 1 1-1h1a7 7 0 0 1 7-7h1V5.73c-.6-.34-1-.99-1-1.73a2 2 0 0 1 2-2z"/>
                    <circle cx="9" cy="14" r="1"/><circle cx="15" cy="14" r="1"/>
                </svg>
            </button>
            <div id="ai-panel" class="ai-panel" style="display:none;">
                <div class="ai-panel-header">
                    <div class="ai-panel-title">
                        <span class="ai-dot"></span>
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
                    <input type="file" id="ai-file" accept="image/*,.txt,.pdf,.csv" hidden>
                    <button id="ai-attach" class="ai-attach-btn" title="Attach">
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
    },

    bindEvents() {
        document.getElementById('ai-fab')?.addEventListener('click', () => this.toggle(true));
        document.getElementById('ai-close')?.addEventListener('click', () => this.toggle(false));
        document.getElementById('ai-send')?.addEventListener('click', () => this.send());
        document.getElementById('ai-attach')?.addEventListener('click', () => document.getElementById('ai-file')?.click());
        document.getElementById('ai-file')?.addEventListener('change', (e) => this.handleFile(e));
        document.getElementById('ai-input')?.addEventListener('keydown', (e) => {
            if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); this.send(); }
        });
    },

    toggle(show) {
        this.open = show ?? !this.open;
        const panel = document.getElementById('ai-panel');
        const fab = document.getElementById('ai-fab');
        if (panel) panel.style.display = this.open ? 'flex' : 'none';
        if (fab) fab.classList.toggle('ai-fab-hidden', this.open);
        if (this.open) {
            this.refreshLimits();
            document.getElementById('ai-input')?.focus();
        }
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

    appendBubble(role, content, imageUrl) {
        const box = document.getElementById('ai-messages');
        if (!box) return;
        const div = document.createElement('div');
        div.className = `ai-bubble ai-bubble-${role}`;
        if (imageUrl) {
            div.innerHTML = `<img src="${imageUrl}" class="ai-bubble-img" alt="">`;
        }
        const text = document.createElement('div');
        text.className = 'ai-bubble-text';
        text.textContent = content;
        div.appendChild(text);
        box.appendChild(div);
        box.scrollTop = box.scrollHeight;
    },

    pendingImage: null,

    handleFile(e) {
        const file = e.target.files?.[0];
        if (!file) return;
        if (file.type.startsWith('image/')) {
            const reader = new FileReader();
            reader.onload = () => {
                this.pendingImage = reader.result;
                this.appendBubble('user', `[${file.name}]`, reader.result);
            };
            reader.readAsDataURL(file);
        } else {
            const reader = new FileReader();
            reader.onload = () => {
                const text = String(reader.result).slice(0, 3000);
                this.pendingFileText = text;
                this.appendBubble('user', `[File: ${file.name}]\n${text.slice(0, 200)}...`);
            };
            reader.readAsText(file);
        }
        e.target.value = '';
    },

    pendingFileText: null,

    async send() {
        if (this.sending) return;
        const input = document.getElementById('ai-input');
        const message = input?.value?.trim();
        if (!message && !this.pendingImage) return;
        if (!API_BASE || (typeof isGuestUserId === 'function' ? isGuestUserId(getUserId()) : String(getUserId()).startsWith('guest_'))) {
            alert(typeof t === 'function' ? t('join_guest_hint') : 'Open from Telegram');
            return;
        }

        const userMsg = message || '[Image]';
        if (message) this.appendBubble('user', message);
        if (input) input.value = '';
        this.sending = true;

        let fullMessage = message || 'Describe this image in context of crypto trading.';
        if (this.pendingFileText) {
            fullMessage += `\n\nAttached file content:\n${this.pendingFileText}`;
            this.pendingFileText = null;
        }

        try {
            const payload = {
                user_id: getUserId(),
                message: fullMessage,
                history: this.history.slice(-6),
                image: this.pendingImage || null
            };
            this.pendingImage = null;

            const data = await apiFetch('/api/assistant/chat', {
                method: 'POST',
                body: JSON.stringify(payload)
            });

            if (data.status === 'success') {
                this.history.push({ role: 'user', content: userMsg });
                this.history.push({ role: 'assistant', content: data.reply });
                this.appendBubble('assistant', data.reply);
            } else {
                const errMsg = data.reason === 'cooldown'
                    ? (typeof t === 'function' ? t('ai_cooldown') : 'Please wait a few seconds')
                    : (data.reason === 'daily_message_limit' ? (typeof t === 'function' ? t('ai_limit') : 'Daily limit reached') : (data.detail || 'Error'));
                this.appendBubble('assistant', errMsg);
            }
            this.refreshLimits();
        } catch (e) {
            this.appendBubble('assistant', typeof t === 'function' ? t('ai_error') : 'Assistant unavailable');
            console.warn('AI send error:', e);
        } finally {
            this.sending = false;
        }
    }
};

document.addEventListener('DOMContentLoaded', () => AssistantUI.init());
window.AssistantUI = AssistantUI;
