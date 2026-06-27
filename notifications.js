// ============================================================
// Standardized Notification System — sound on ALL notifications, dedup
// ============================================================

// ============================================================================
//#region مرکز نوتیفیکیشن
// ============================================================================
const NotificationCenter = {
    _recentKeys: new Map(),
    DEDUP_MS: 10000,
    MAX: 50,

    playSound() {
        try {
            const AudioCtx = window.AudioContext || window.webkitAudioContext;
            if (!AudioCtx) return;
            const ctx = new AudioCtx();
            [660, 880].forEach((freq, i) => {
                const osc = ctx.createOscillator();
                const gain = ctx.createGain();
                osc.connect(gain);
                gain.connect(ctx.destination);
                osc.frequency.value = freq;
                osc.type = 'sine';
                const start = ctx.currentTime + i * 0.12;
                gain.gain.setValueAtTime(0.0001, start);
                gain.gain.exponentialRampToValueAtTime(0.2, start + 0.02);
                gain.gain.exponentialRampToValueAtTime(0.0001, start + 0.28);
                osc.start(start);
                osc.stop(start + 0.3);
            });
        } catch (e) {
            console.warn('Notification sound failed:', e);
        }
    },

    _dedupKey(title, body) {
        return `${title}::${body}`.slice(0, 200);
    },

    isDuplicate(title, body) {
        const key = this._dedupKey(title, body);
        const last = this._recentKeys.get(key);
        if (last && Date.now() - last < this.DEDUP_MS) return true;
        this._recentKeys.set(key, Date.now());
        if (this._recentKeys.size > 100) {
            const cutoff = Date.now() - this.DEDUP_MS * 2;
            for (const [k, t] of this._recentKeys) {
                if (t < cutoff) this._recentKeys.delete(k);
            }
        }
        return false;
    },

    add(title, body, options = {}) {
        const { sendToTelegram = true, playSound = true, silent = false } = options;
        if (this.isDuplicate(title, body)) return null;

        const notif = {
            id: Date.now().toString() + Math.random().toString(36).slice(2, 6),
            title,
            body,
            read: false,
            date: new Date().toISOString()
        };

        const list = JSON.parse(localStorage.getItem('notifications') || '[]');
        list.unshift(notif);
        const trimmed = list.slice(0, this.MAX);
        localStorage.setItem('notifications', JSON.stringify(trimmed));

        if (playSound && !silent) this.playSound();

        if (typeof updateNotifBadge === 'function') updateNotifBadge();

        if (sendToTelegram && typeof notifyTelegram === 'function') {
            const userId = typeof getUserId === 'function' ? getUserId() : null;
            if (userId && !(typeof isGuestUserId === 'function' ? isGuestUserId(userId) : String(userId).startsWith('guest_'))) {
                notifyTelegram(`🔔 ${title}\n${body}`).catch(e => console.warn('notifyTelegram:', e));
            }
        }

        return notif;
    }
};

//#endregion

// ============================================================================
//#region ثبت سراسری
// ============================================================================
window.NotificationCenter = NotificationCenter;
//#endregion
