/**
 * Historical News Articles Cleanup Script (Phase 7)
 * ================================================
 * Scans news_articles table for summaries that fail the NEW Persian validation
 * (CJK zero-tolerance + segment-based English check + whitelist).
 *
 * Usage:
 *   Dry-run:  node scripts/cleanup-invalid-summaries.cjs
 *   Execute:  node scripts/cleanup-invalid-summaries.cjs --execute
 *
 * Requirements:
 *   - DATABASE_URL or SUPABASE_DATABASE_URL env var must be set
 *   - Connects directly to PostgreSQL (NOT through Worker)
 *
 * What it does:
 *   1. Reads all news_articles with non-null summaries
 *   2. Runs validatePersianOutput on each summary
 *   3. Reports invalid summaries (dry-run)
 *   4. If --execute: clears invalid summaries (SET summary = NULL)
 *   5. If --execute: invalidates corresponding KV cache keys (news:ai:{hash})
 *
 * Safety:
 *   - Default is dry-run (no changes)
 *   - Shows affected count before executing
 *   - Only clears summary column — does NOT delete the article row
 *   - Article metadata (title, url, source, etc.) is preserved
 */

const { Pool } = require('pg');
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

// ─── Persian validation (mirrors worker-proxy.js) ─────────────────────
const PERSIAN_WHITELIST_TOKENS = new Set([
  'BTC', 'ETH', 'USDT', 'USDC', 'XRP', 'SOL', 'BNB', 'DOGE', 'ADA', 'AVAX',
  'DOT', 'MATIC', 'LINK', 'UNI', 'ATOM', 'LTC', 'BCH', 'XLM', 'ALGO', 'NEAR',
  'APT', 'ARB', 'OP', 'INJ', 'TIA', 'SEI', 'SUI', 'PEPE', 'WIF', 'BONK',
  'TAO', 'TRUMP', 'FET', 'RNDR', 'RENDER', 'STX', 'HBAR', 'VET', 'THETA',
  'SAND', 'MANA', 'AXS', 'GALA', 'CHZ', 'ENJ', 'FLOW', 'ICP', 'FIL', 'AR',
  'ETC', 'XMR', 'DASH', 'ZEC', 'NEO', 'IOTA', 'EOS', 'XTZ', 'RUNE', 'AAVE',
  'CRV', 'SUSHI', 'COMP', 'SNX', 'MKR', 'LDO', 'RPL', 'IMX', 'GRT', 'LRC',
  'KSM', 'GLMR', 'MOVR', 'ACALA', 'STRK', 'MANTA', 'PYTH', 'JTO', 'W',
  'WBTC', 'WETH', 'CBETH', 'STETH', 'RETH', 'USD', 'EUR', 'JPY', 'GBP',
  'ETF', 'GDP', 'CPI', 'PPI', 'FOMC', 'OPEC', 'SEC', 'FED', 'ECB', 'IMF',
  'WEF', 'KYC', 'AML', 'TVL', 'APR', 'APY', 'ROI', 'ICO', 'IEO', 'AMM',
  'LP', 'YTD', 'Q1', 'Q2', 'Q3', 'Q4', 'NFT', 'DAO', 'DEX', 'CEX', 'DEFI',
  'IPO', 'FDA', 'CFTC', 'FinCEN',
  'API', 'AI', 'URL', 'HTTP', 'HTTPS', 'HTML', 'CSS', 'JS', 'SDK', 'UI',
  'UX', 'OS', 'ID', 'IP', 'DNS', 'SSL', 'TLS', 'VPN', 'DAPP', 'SaaS',
  'P2P', 'B2B', 'B2C', 'RSS', 'JSON', 'XML', 'CSV',
]);

function isWhitelistedToken(word) {
  const cleaned = word.replace(/^[^a-zA-Z0-9]+|[^a-zA-Z0-9]+$/g, '');
  if (PERSIAN_WHITELIST_TOKENS.has(cleaned)) return true;
  if (cleaned.length >= 2 && cleaned.length <= 6 && cleaned === cleaned.toUpperCase() && /^[A-Z]+$/.test(cleaned)) return true;
  return false;
}

function validatePersianOutput(text, opts = {}) {
  const minLength = opts.minLength ?? 200;
  if (!text || typeof text !== 'string') return { valid: false, reason: 'empty_or_null' };
  const trimmed = text.trim();
  if (trimmed.length < minLength) return { valid: false, reason: 'too_short' };
  const lowerTrimmed = trimmed.toLowerCase();
  const errorPatterns = ['error:', 'sorry, i cannot', 'i am unable to', 'rate limit', 'quota exceeded', 'service unavailable', 'internal server error', '{"error"', '{"status": "error', 'http 4', 'http 5', 'undefined', '[object object]', 'null'];
  for (const pattern of errorPatterns) {
    if (lowerTrimmed.startsWith(pattern) || lowerTrimmed === pattern) return { valid: false, reason: 'provider_error_string' };
  }
  let persianChars = 0, cjkChars = 0, totalChars = 0, whitespace = 0;
  for (const ch of trimmed) {
    const code = ch.codePointAt(0);
    totalChars++;
    if ((code >= 0x0600 && code <= 0x06FF) || (code >= 0x0750 && code <= 0x077F)) persianChars++;
    else if ((code >= 0x4E00 && code <= 0x9FFF) || (code >= 0x3400 && code <= 0x4DBF) || (code >= 0xF900 && code <= 0xFAFF) || (code >= 0x2E80 && code <= 0x2EFF) || (code >= 0x3000 && code <= 0x303F) || (code >= 0x3040 && code <= 0x309F) || (code >= 0x30A0 && code <= 0x30FF)) cjkChars++;
    else if (code === 0x20 || code === 0x09 || code === 0x0A || code === 0x0D) whitespace++;
  }
  const nonWhitespaceChars = totalChars - whitespace;
  if (nonWhitespaceChars === 0) return { valid: false, reason: 'only_whitespace' };
  const persianRatio = persianChars / nonWhitespaceChars;
  if (cjkChars > 0) return { valid: false, reason: 'cjk_contamination' };
  if (persianRatio < 0.25) return { valid: false, reason: 'insufficient_persian' };
  const segments = trimmed.split(/[.!?؟。\n\r]+/).map(s => s.trim()).filter(s => s.length >= 10);
  for (const segment of segments) {
    const words = segment.split(/\s+/);
    let segmentAsciiLetters = 0, segmentNonWhitespace = 0;
    for (const word of words) {
      if (!isWhitelistedToken(word)) {
        for (const ch of word) {
          const code = ch.codePointAt(0);
          if ((code >= 0x41 && code <= 0x5A) || (code >= 0x61 && code <= 0x7A)) segmentAsciiLetters++;
          if (code !== 0x20 && code !== 0x09 && code !== 0x0A && code !== 0x0D) segmentNonWhitespace++;
        }
      }
    }
    if (segmentNonWhitespace > 0 && (segmentAsciiLetters / segmentNonWhitespace) > 0.40) {
      return { valid: false, reason: 'english_contamination_in_segment' };
    }
  }
  return { valid: true, reason: 'ok' };
}

// ─── URL hash (mirrors worker-proxy.js hashUrl) ───────────────────────
function hashUrl(url) {
  // Simple hash (DJB2-style) matching the worker's hashUrl
  let hash = 5381;
  for (let i = 0; i < url.length; i++) {
    hash = ((hash << 5) + hash) + url.charCodeAt(i);
    hash = hash & 0xFFFFFFFF;
  }
  return (hash >>> 0).toString(36);
}

// ─── Main ─────────────────────────────────────────────────────────────
async function main() {
  const isExecute = process.argv.includes('--execute');
  const dbUrl = process.env.DATABASE_URL || process.env.SUPABASE_DATABASE_URL || process.env.NEON_DATABASE_URL;

  if (!dbUrl) {
    console.error('❌ No DATABASE_URL or SUPABASE_DATABASE_URL env var found.');
    console.error('   Set it to your Supabase/Neon PostgreSQL connection string.');
    process.exit(1);
  }

  console.log(`\n${isExecute ? '⚠️  EXECUTE MODE' : '🔍 DRY-RUN MODE'} — Historical News Summary Cleanup\n`);

  const pool = new Pool({ connectionString: dbUrl, ssl: { rejectUnauthorized: false } });

  try {
    // 1. Count total articles with summaries
    const countResult = await pool.query('SELECT COUNT(*) FROM news_articles WHERE summary IS NOT NULL AND summary != \'\'');
    const totalWithSummary = parseInt(countResult.rows[0].count);
    console.log(`Total articles with summaries: ${totalWithSummary}\n`);

    if (totalWithSummary === 0) {
      console.log('✅ No summaries to check. Done.');
      return;
    }

    // 2. Read all summaries in batches
    const BATCH_SIZE = 100;
    let invalidCount = 0;
    let validCount = 0;
    let checkedCount = 0;
    const invalidRecords = [];

    for (let offset = 0; offset < totalWithSummary; offset += BATCH_SIZE) {
      const result = await pool.query(
        'SELECT id, url, title, summary, provider FROM news_articles WHERE summary IS NOT NULL AND summary != \'\' ORDER BY created_at DESC LIMIT $1 OFFSET $2',
        [BATCH_SIZE, offset]
      );

      for (const row of result.rows) {
        checkedCount++;
        const validation = validatePersianOutput(row.summary);

        if (!validation.valid) {
          invalidCount++;
          invalidRecords.push({
            id: row.id,
            url: row.url,
            title: (row.title || '').slice(0, 60),
            reason: validation.reason,
            provider: row.provider || 'unknown',
            summary_preview: (row.summary || '').slice(0, 80),
          });
        } else {
          validCount++;
        }
      }

      // Progress
      if (checkedCount % 100 === 0) {
        console.log(`  Checked ${checkedCount}/${totalWithSummary}... (valid: ${validCount}, invalid: ${invalidCount})`);
      }
    }

    // 3. Report results
    console.log(`\n═══ RESULTS ═══`);
    console.log(`Total checked:  ${checkedCount}`);
    console.log(`Valid:          ${validCount}`);
    console.log(`Invalid:        ${invalidCount}`);
    console.log(`Invalid rate:   ${(invalidCount / checkedCount * 100).toFixed(1)}%\n`);

    if (invalidCount > 0) {
      console.log(`═══ INVALID SUMMARIES (first 20) ═══`);
      for (const rec of invalidRecords.slice(0, 20)) {
        console.log(`  [${rec.reason}] ${rec.title}...`);
        console.log(`    provider: ${rec.provider}, url: ${rec.url.slice(0, 60)}`);
        console.log(`    preview: ${rec.summary_preview}...`);
        console.log('');
      }
      if (invalidRecords.length > 20) {
        console.log(`  ... and ${invalidRecords.length - 20} more\n`);
      }

      // 4. Breakdown by reason
      const byReason = {};
      for (const rec of invalidRecords) {
        byReason[rec.reason] = (byReason[rec.reason] || 0) + 1;
      }
      console.log(`═══ BREAKDOWN BY REASON ═══`);
      for (const [reason, count] of Object.entries(byReason)) {
        console.log(`  ${reason}: ${count}`);
      }
      console.log('');
    }

    // 5. Execute cleanup if requested
    if (isExecute && invalidCount > 0) {
      console.log(`═══ EXECUTING CLEANUP ═══`);
      console.log(`Clearing ${invalidCount} invalid summaries (SET summary = NULL)...\n`);

      let cleared = 0;
      for (const rec of invalidRecords) {
        try {
          await pool.query('UPDATE news_articles SET summary = NULL WHERE id = $1', [rec.id]);
          cleared++;
        } catch (e) {
          console.error(`  ❌ Failed to clear ${rec.id}: ${e.message}`);
        }
      }

      console.log(`✅ Cleared ${cleared} invalid summaries from DB.`);
      console.log(`\nNote: KV cache invalidation (news:ai:*) must be done separately.`);
      console.log(`  The KV keys are: news:ai:{hashUrl(article_url)}`);
      console.log(`  You can clear them via: wrangler kv key delete --binding=APP_CACHE "news:ai:{hash}"`);
      console.log(`  Or simply wait for the 7-day TTL to expire.\n`);
    } else if (!isExecute && invalidCount > 0) {
      console.log(`═══ DRY RUN COMPLETE ═══`);
      console.log(`To execute cleanup, run: node scripts/cleanup-invalid-summaries.cjs --execute\n`);
    } else {
      console.log(`✅ All summaries are valid. No cleanup needed.`);
    }

  } catch (e) {
    console.error('❌ Error:', e.message);
    process.exit(1);
  } finally {
    await pool.end();
  }
}

main().catch(e => { console.error(e); process.exit(1); });
