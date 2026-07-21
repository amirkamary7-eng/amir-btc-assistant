#!/usr/bin/env node
/**
 * PRODUCTION DATABASE VERIFICATION — Referral System
 *
 * Run this script WITH your real Neon Production DATABASE_URL:
 *
 *   DATABASE_URL='postgresql://user:pass@ep-xxx.neon.tech/dbname?pgbouncer=true' \
 *     node scripts/verify-production-referral.mjs
 *
 * WHAT IT DOES:
 *   - Connects to your REAL Neon production database (read-only)
 *   - Dumps current state of: users, referrals, token_balances, token_transactions
 *   - Lets you verify a specific inviter/invitee pair after a real Telegram test
 *   - Optionally takes --inviter and --invitee args to filter
 *
 * SAFETY:
 *   - READ-ONLY. No INSERT/UPDATE/DELETE.
 *   - Uses a single Pool, closes cleanly.
 *   - Does NOT modify any production data.
 *
 * Usage:
 *   node scripts/verify-production-referral.mjs                          # full dump
 *   node scripts/verify-production-referral.mjs --inviter 100000001      # filter by inviter
 *   node scripts/verify-production-referral.mjs --invitee 200000002      # filter by invitee
 *   node scripts/verify-production-referral.mjs --inviter A --invitee B  # both
 */

const { Pool } = require('@neondatabase/serverless');

// ── Parse CLI args ──────────────────────────────────────────────────────
const args = process.argv.slice(2);
const getArg = (name) => {
  const i = args.indexOf(`--${name}`);
  return i >= 0 ? args[i + 1] : null;
};
const inviterFilter = getArg('inviter');
const inviteeFilter = getArg('invitee');

// ── Get DATABASE_URL ────────────────────────────────────────────────────
const databaseUrl = process.env.DATABASE_URL;
if (!databaseUrl || databaseUrl.startsWith('file:')) {
  console.error('❌ ERROR: DATABASE_URL not set or is a local file path.');
  console.error('');
  console.error('   Set it to your Neon Production connection string:');
  console.error('');
  console.error('   DATABASE_URL="postgresql://USER:PASS@ep-HOST.neon.tech/DB?pgbouncer=true" \\');
  console.error('     node scripts/verify-production-referral.mjs');
  console.error('');
  console.error('   You can find this in:');
  console.error('   - Cloudflare Dashboard → Workers → amir-btc-assistant-api-production → Settings → Variables');
  console.error('   - Or: wrangler secret list --env production (if logged in)');
  console.error('   - Or: Neon Dashboard → your project → Connection Details');
  process.exit(1);
}

console.log('╔══════════════════════════════════════════════════════════════════════╗');
console.log('║  PRODUCTION DATABASE VERIFICATION — Referral System                  ║');
console.log('║  READ-ONLY — no data will be modified                                 ║');
console.log('╚══════════════════════════════════════════════════════════════════════╝');
console.log(`  Database: ${databaseUrl.replace(/:[^:@]+@/, ':****@').substring(0, 60)}...`);
console.log(`  Inviter filter:  ${inviterFilter || '(none)'}`);
console.log(`  Invitee filter:  ${inviteeFilter || '(none)'}`);
console.log('');

const pool = new Pool({
  connectionString: databaseUrl,
  max: 1,
  idleTimeoutMillis: 0,
  connectionTimeoutMillis: 10000,
});

async function query(sql, params = []) {
  const client = await pool.connect();
  try {
    return await client.query(sql, params);
  } finally {
    client.release();
  }
}

function printTable(rows, title) {
  console.log(`── ${title} (${rows.length} rows) ${'─'.repeat(Math.max(0, 60 - title.length))}`);
  if (rows.length === 0) {
    console.log('   (no rows)');
    console.log('');
    return;
  }
  const cols = Object.keys(rows[0]);
  // Calculate column widths
  const widths = {};
  for (const c of cols) {
    widths[c] = Math.max(c.length, ...rows.map(r => String(r[c] ?? 'NULL').length));
  }
  // Header
  console.log('   ' + cols.map(c => c.padEnd(widths[c])).join(' | '));
  console.log('   ' + cols.map(c => '-'.repeat(widths[c])).join('-+-'));
  // Rows
  for (const row of rows) {
    console.log('   ' + cols.map(c => String(row[c] ?? 'NULL').padEnd(widths[c])).join(' | '));
  }
  console.log('');
}

async function run() {
  let exitCode = 0;

  try {
    // ── 1. Connection test ──────────────────────────────────────────────
    console.log('🔍 Testing database connection...');
    const testResult = await query('SELECT NOW() as now, current_database() as db, version() as version');
    console.log(`   ✅ Connected to: ${testResult.rows[0].db}`);
    console.log(`   📅 Server time:  ${testResult.rows[0].now}`);
    console.log(`   🐘 PostgreSQL:   ${testResult.rows[0].version.substring(0, 50)}...`);
    console.log('');

    // ── 2. Users table ──────────────────────────────────────────────────
    let userSql = `SELECT telegram_id, username, first_name, last_name, lang,
                          channel_joined, channel_verified_at, created_at, updated_at
                   FROM users`;
    const userParams = [];
    if (inviterFilter || inviteeFilter) {
      const conditions = [];
      if (inviterFilter) { conditions.push('telegram_id = $1'); userParams.push(inviterFilter); }
      if (inviteeFilter) {
        conditions.push(`telegram_id = $${userParams.length + 1}`);
        userParams.push(inviteeFilter);
      }
      userSql += ' WHERE ' + conditions.join(' OR ');
    }
    userSql += ' ORDER BY created_at DESC LIMIT 50';
    const users = await query(userSql, userParams);
    printTable(users.rows, 'users');

    // ── 3. Referrals table ──────────────────────────────────────────────
    let refSql = `SELECT id, inviter_id, invitee_id, channel_verified, rewarded, created_at
                  FROM referrals`;
    const refParams = [];
    if (inviterFilter || inviteeFilter) {
      const conditions = [];
      if (inviterFilter) { conditions.push('inviter_id = $1'); refParams.push(inviterFilter); }
      if (inviteeFilter) {
        conditions.push(`invitee_id = $${refParams.length + 1}`);
        refParams.push(inviteeFilter);
      }
      refSql += ' WHERE ' + conditions.join(' OR ');
    }
    refSql += ' ORDER BY created_at DESC LIMIT 50';
    const referrals = await query(refSql, refParams);
    printTable(referrals.rows, 'referrals');

    // ── 4. Token balances ───────────────────────────────────────────────
    let balSql = `SELECT user_id, balance, updated_at FROM token_balances`;
    const balParams = [];
    if (inviterFilter || inviteeFilter) {
      const conditions = [];
      if (inviterFilter) { conditions.push('user_id = $1'); balParams.push(inviterFilter); }
      if (inviteeFilter) {
        conditions.push(`user_id = $${balParams.length + 1}`);
        balParams.push(inviteeFilter);
      }
      balSql += ' WHERE ' + conditions.join(' OR ');
    }
    balSql += ' ORDER BY updated_at DESC LIMIT 50';
    const balances = await query(balSql, balParams);
    printTable(balances.rows, 'token_balances');

    // ── 5. Token transactions ───────────────────────────────────────────
    let txSql = `SELECT id, user_id, amount, tx_type, description, ref_id, created_at
                 FROM token_transactions`;
    const txParams = [];
    if (inviterFilter || inviteeFilter) {
      const conditions = [];
      if (inviterFilter) { conditions.push('user_id = $1'); txParams.push(inviterFilter); }
      if (inviteeFilter) {
        conditions.push(`user_id = $${txParams.length + 1}`);
        txParams.push(inviteeFilter);
      }
      txSql += ' WHERE ' + conditions.join(' OR ');
    }
    txSql += ' ORDER BY created_at DESC LIMIT 50';
    const transactions = await query(txSql, txParams);
    printTable(transactions.rows, 'token_transactions');

    // ── 6. Summary & verdict ────────────────────────────────────────────
    console.log('═'.repeat(70));
    console.log('  VERDICT');
    console.log('═'.repeat(70));

    const refRows = referrals.rows;
    const hasReferral = refRows.length > 0;
    const hasRewarded = refRows.some(r => r.rewarded === true || r.rewarded === 't');
    const hasChannelVerified = refRows.some(r => r.channel_verified === true || r.channel_verified === 't');

    console.log(`  Referral row exists:        ${hasReferral ? '✅ YES' : '❌ NO'}`);
    console.log(`  channel_verified = true:    ${hasChannelVerified ? '✅ YES' : '❌ NO'}`);
    console.log(`  rewarded = true:            ${hasRewarded ? '✅ YES' : '❌ NO'}`);

    const balRows = balances.rows;
    const inviterBalance = balRows.find(b => b.user_id === inviterFilter);
    const hasBalance = inviterBalance && Number(inviterBalance.balance) > 0;
    console.log(`  Inviter token balance > 0:  ${hasBalance ? `✅ YES (${inviterBalance.balance})` : '❌ NO'}`);

    const hasTx = transactions.rows.some(t => t.tx_type === 'referral_reward');
    console.log(`  referral_reward tx exists:  ${hasTx ? '✅ YES' : '❌ NO'}`);

    console.log('');
    if (hasReferral && hasRewarded && hasBalance && hasTx) {
      console.log('  🎉 REFERRAL FLOW VERIFIED ON PRODUCTION DATABASE');
    } else {
      console.log('  ⚠️  Referral flow NOT complete — check the table dumps above.');
      exitCode = 2;
    }

  } catch (err) {
    console.error('\n❌ DATABASE ERROR:');
    console.error('   ', err.message);
    if (err.message.includes('password')) {
      console.error('');
      console.error('   → Check your DATABASE_URL — the password may be wrong.');
    } else if (err.message.includes('does not exist') || err.message.includes('relation')) {
      console.error('');
      console.error('   → A table is missing. Has the schema been applied to this database?');
      console.error('     Run: psql "$DATABASE_URL" -f scripts/stabilization_indexes.sql');
    } else if (err.message.includes('timeout') || err.message.includes('connect')) {
      console.error('');
      console.error('   → Cannot reach the database. Check:');
      console.error('     1. Is the hostname correct?');
      console.error('     2. Is your IP allowed in Neon\'s IP allow list?');
      console.error('     3. Is ?pgbouncer=true in the connection string?');
    }
    exitCode = 1;
  } finally {
    await pool.end();
    process.exit(exitCode);
  }
}

run();
