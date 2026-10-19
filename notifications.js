// ============================================================
// Standardized Notification System — sound on ALL notifications, dedup
// ============================================================

// ============================================================================
//#region AudioContext مشترک (PERF-12 / Phase 40)
// ============================================================================
// PERF FIX: playSound() previously created a NEW AudioContext on EVERY call
// and never closed it. Browsers cap simultaneous AudioContexts (~6 in
// Chrome/Safari), so after roughly six notifications the sound silently died
// mid-session, and each leaked context kept a native audio graph in memory.
//
// Fix: ONE lazily-created module-level context, reused for every play, with
// explicit state handling (per the fix requirements — never ignore
// suspended/closed states or browser limits):
//   - lazy creation on first play (respects autoplay policies: no AudioContext
//     is constructed until the user actually receives a notification)
//   - 'suspended' → ctx.resume() before scheduling (Chrome autoplay policy
//     starts contexts suspended without a user gesture; notification flows
//     ARE user-gesture-driven, so resume is legitimate)
//   - 'closed' → recreate (pagehide closed it; pageshow/bfcache restore path)
//   - creation failure (browser limit hit / unsupported) → fall back to
//     creating a fresh context per play, preserving the old audible behavior
//     instead of silencing notifications
//   - 'pagehide' → close() so the context never leaks across page lifetime
//     (bfcache restore re-creates it lazily on the next play)
let _sharedAudioCtx = null;

function _getSharedAudioCtx() {
    try {
        const AudioCtx = window.AudioContext || window.webkitAudioContext;
        if (!AudioCtx) return null;
        if (_sharedAudioCtx && _sharedAudioCtx.state === 'closed') {
            // Closed on pagehide (or by the browser) — a closed context can
            // never be resumed; drop it so the next branch creates a fresh one.
            _sharedAudioCtx = null;
        }
        if (!_sharedAudioCtx) {
            _sharedAudioCtx = new AudioCtx();
        }
        if (_sharedAudioCtx.state === 'suspended') {
            // Autoplay policy may hand us a suspended context — resume it so
            // oscillators are actually audible. Never ignore this state.
            const p = _sharedAudioCtx.resume();
            if (p && typeof p.catch === 'function') {
                p.catch(() => { /* resume rejected → scheduling still attempted below */ });
            }
        }
        return _sharedAudioCtx;
    } catch (e) {
        // Creation failed (browser context cap, unsupported environment, …).
        // Signal the caller to use the legacy per-play context so
        // notifications remain audible exactly as before the fix.
        return null;
    }
}

// Close the shared context when the page is hidden for good (tab close,
// navigation). bfcache keeps the JS state frozen; on restore the context is
// 'closed'-state-checked and re-created lazily by the next play.
if (typeof window !== 'undefined' && typeof window.addEventListener === 'function') {
    window.addEventListener('pagehide', () => {
        try {
            if (_sharedAudioCtx && _sharedAudioCtx.state !== 'closed') {
                const p = _sharedAudioCtx.close();
                _sharedAudioCtx = null; // drop the reference immediately
                if (p && typeof p.catch === 'function') p.catch(() => {});
            }
        } catch (e) { /* best-effort cleanup */ }
    });
}
//#endregion

// Schedules the two-tone notification chime (660/880 Hz sine, same envelope
// as the pre-PERF-12 implementation) on the given AudioContext. Extracted
// verbatim from the old playSound() body — pure scheduling, no lifecycle
// logic, so the audible behavior is byte-for-byte identical.
function _scheduleNotificationTone(ctx) {
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
}

// ============================================================================
//#region مرکز نوتیفیکیشن
// ============================================================================
const NotificationCenter = {
    _recentKeys: new Map(),
    DEDUP_MS: 10000,
    MAX: 50,

    playSound() {
        try {
            const ctx = _getSharedAudioCtx();
            if (!ctx) {
                // Fallback (unsupported browser or context-cap hit): legacy
                // per-play context, preserving the pre-fix audible behavior.
                const AudioCtx = window.AudioContext || window.webkitAudioContext;
                if (!AudioCtx) return;
                const fallbackCtx = new AudioCtx();
                _scheduleNotificationTone(fallbackCtx);
                return;
            }
            _scheduleNotificationTone(ctx);
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
