/**
 * Shared Timezone Helpers — Tehran date/week calculations.
 *
 * WHY THIS EXISTS:
 * Previously there were TWO duplicate Tehran date helpers:
 *   - wallet.js:_getTehranDateString()
 *   - wheel.js:getTehranDateString()
 * Both used the same Intl.DateTimeFormat logic. This shared module eliminates
 * the duplication and provides a single source of truth for Tehran date/week
 * calculations used by wallet, missions, daily check-in, and wheel.
 *
 * WHY TEHRAN (not UTC):
 * Neon/Supabase PostgreSQL CURRENT_DATE uses UTC by default. This causes
 * daily resets at 03:30 Tehran (00:00 UTC) instead of 00:00 Tehran.
 * The wheel system already uses Tehran date (wheel.js:23-24 comment confirms
 * this). Wallet and missions must match.
 *
 * All date calculations here use Intl.DateTimeFormat with timeZone: 'Asia/Tehran'
 * which runs in the Worker (V8 isolate) — server-side, NOT client-side.
 * Client clock cannot manipulate these values.
 */

/**
 * Get today's date in Tehran timezone as YYYY-MM-DD string.
 * @returns {string} e.g. "2026-08-22"
 */
export function getTehranDateString() {
  const fmt = new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Asia/Tehran',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  });
  return fmt.format(new Date());
}

/**
 * Get yesterday's date in Tehran timezone as YYYY-MM-DD string.
 * Used for streak "consecutive day" check (last_claim_date == tehranYesterday
 * means streak continues).
 * @returns {string} e.g. "2026-08-21"
 */
export function getTehranYesterdayString() {
  const yesterday = new Date(Date.now() - 24 * 60 * 60 * 1000);
  const fmt = new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Asia/Tehran',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  });
  return fmt.format(yesterday);
}

/**
 * Get the start of the current week (Saturday) in Tehran timezone as YYYY-MM-DD.
 *
 * Iranian week starts on Saturday (شنبه). JS Date.getDay() returns:
 *   0=Sunday, 1=Monday, ..., 6=Saturday
 * So Saturday = 6, and we need to subtract days back to the most recent Saturday.
 *
 * Algorithm:
 *   - If today is Saturday (6), week_start = today (0 days back)
 *   - If today is Sunday (0), week_start = yesterday (1 day back)
 *   - If today is Monday (1), week_start = 2 days back
 *   - ...
 *   - If today is Friday (5), week_start = 6 days back
 *
 * Formula: daysBack = (dayOfWeek + 1) % 7
 *   Sat(6): (6+1)%7 = 0
 *   Sun(0): (0+1)%7 = 1
 *   Mon(1): (1+1)%7 = 2
 *   Tue(2): (2+1)%7 = 3
 *   Wed(3): (3+1)%7 = 4
 *   Thu(4): (4+1)%7 = 5
 *   Fri(5): (5+1)%7 = 6
 *
 * NOTE: This uses the Tehran date's weekday, NOT the UTC weekday.
 * At 02:00 UTC on a Saturday, Tehran is 06:30 Saturday (Tehran is UTC+3:30).
 * At 21:00 UTC on a Friday, Tehran is 00:30 Saturday (next day in Tehran).
 * So we must compute the weekday using the Tehran date string, not Date.getDay() directly.
 *
 * @returns {string} e.g. "2026-08-22" (the Saturday starting this week in Tehran)
 */
export function getTehranWeekStart() {
  // Get Tehran date components
  const fmt = new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Asia/Tehran',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    weekday: 'short', // 'Sat', 'Sun', etc.
  });
  const now = new Date();
  const parts = fmt.formatToParts(now);
  const yearPart = parts.find(p => p.type === 'year')?.value;
  const monthPart = parts.find(p => p.type === 'month')?.value;
  const dayPart = parts.find(p => p.type === 'day')?.value;
  const weekdayPart = parts.find(p => p.type === 'weekday')?.value;

  // Map weekday to days-back-to-Saturday
  const weekdayMap = {
    'Sat': 0, 'Sun': 1, 'Mon': 2, 'Tue': 3, 'Wed': 4, 'Thu': 5, 'Fri': 6,
  };
  const daysBack = weekdayMap[weekdayPart] ?? 0;

  // Compute week_start by subtracting daysBack from Tehran date
  // We parse Tehran date as UTC midnight (safe because we only do date math, not time)
  const tehranDate = new Date(`${yearPart}-${monthPart}-${dayPart}T00:00:00Z`);
  tehranDate.setUTCDate(tehranDate.getUTCDate() - daysBack);
  const weekStart = tehranDate.toISOString().slice(0, 10);
  return weekStart;
}

/**
 * Get ISO week number for Tehran date (e.g. "2026-W34").
 * Used for analytics/debugging — NOT for idempotency (use week_start date instead).
 * @returns {string} e.g. "2026-W34"
 */
export function getTehranWeekKey() {
  const weekStart = getTehranWeekStart();
  // Parse week_start as UTC date, compute ISO week
  const d = new Date(`${weekStart}T00:00:00Z`);
  // ISO week: Thursday-based
  const thursday = new Date(d);
  thursday.setUTCDate(d.getUTCDate() + 3 - ((d.getUTCDay() + 6) % 7));
  const firstThursday = new Date(Date.UTC(thursday.getUTCFullYear(), 0, 4));
  const week = 1 + Math.round(
    ((thursday - firstThursday) / (7 * 24 * 60 * 60 * 1000))
  );
  return `${thursday.getUTCFullYear()}-W${String(week).padStart(2, '0')}`;
}
