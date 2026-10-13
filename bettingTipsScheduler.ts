import * as cron from 'node-cron';
import { autoGenerateBettingTips, autoUpdateBettingResults } from '../services/oddsApiService';
import { autoGenerateFromOddsApi } from '../services/theOddsApiService';
import { db } from '../db';
import { users, bettingTips } from '@shared/schema';
import { or, eq, gte, and } from 'drizzle-orm';

let bettingTipsCronJob: ReturnType<typeof cron.schedule> | null = null;
let resultUpdateCronJob: ReturnType<typeof cron.schedule> | null = null;

// In-memory guard: date string (YYYY-MM-DD UTC) of last catch-up attempt.
// Prevents hammering the API on every restart when the quota is already exhausted.
let lastCatchUpAttemptDate = '';

async function getSystemCreatorId(): Promise<string | null> {
  try {
    // Prefer owner, then superAdmin, then admin — never hardcode email
    const [user] = await db.select({ id: users.id, email: users.email })
      .from(users)
      .where(or(
        eq(users.isOwner, true),
        eq(users.isSuperAdmin, true),
        eq(users.isAdmin, true),
      ))
      .limit(1);

    if (user) {
      console.log(`⚽ Betting tips scheduler: using creator ${user.email}`);
      return user.id;
    }
    return null;
  } catch (err: any) {
    console.error('❌ Failed to resolve system creator:', err.message);
    return null;
  }
}

/** Returns true if we already ran auto-generation TODAY (UTC day).
 *  Prevents wasting API quota on every server restart. */
async function generatedToday(): Promise<boolean> {
  try {
    // Start of today in UTC
    const todayStart = new Date();
    todayStart.setUTCHours(0, 0, 0, 0);

    const rows = await db
      .select({ id: bettingTips.id })
      .from(bettingTips)
      .where(
        and(
          eq(bettingTips.status, 'published'),
          gte(bettingTips.createdAt, todayStart),
        ),
      )
      .limit(1);
    return rows.length > 0;
  } catch {
    return false;
  }
}

export function startBettingTipsScheduler(): void {
  if (bettingTipsCronJob) {
    console.log('⚠️ Betting tips scheduler already running');
    return;
  }

  const hasOddsApiKey     = !!process.env.THE_ODDS_API_KEY?.trim();
  const hasApiFootballKey = !!process.env.API_FOOTBALL_KEY?.trim();

  if (!hasOddsApiKey && !hasApiFootballKey) {
    console.log('⚠️ Ni THE_ODDS_API_KEY ni API_FOOTBALL_KEY konfigire — betting tips scheduler dezaktive');
    return;
  }

  const activeApi = hasOddsApiKey ? 'The Odds API (THE_ODDS_API_KEY)' : 'API-Football (API_FOOTBALL_KEY)';
  console.log(`⚽ Betting tips scheduler: ap itilize ${activeApi}`);

  console.log('⚽ Starting betting tips scheduler - daily at 6:00 AM');

  // ── STARTUP CATCH-UP ────────────────────────────────────────────────────────
  // Fires once per UTC day, only if no tips were created today AND we haven't
  // already attempted a catch-up today (in-memory guard prevents hammering the
  // API across multiple restarts when the daily quota is exhausted).
  setTimeout(async () => {
    const todayUTC = new Date().toISOString().split('T')[0]; // e.g. "2026-05-04"
    if (lastCatchUpAttemptDate === todayUTC) {
      console.log(`⚽ Startup check: catch-up already attempted today (${todayUTC}) — skipping`);
      return;
    }
    try {
      const alreadyRan = await generatedToday();
      if (alreadyRan) {
        console.log('⚽ Startup check: tips already generated today — skipping catch-up');
        return;
      }
      lastCatchUpAttemptDate = todayUTC; // mark attempt BEFORE calling API
      console.log(`⚽ Startup catch-up: no tips yet for ${todayUTC} — triggering auto-generation...`);
      const creatorId = await getSystemCreatorId();
      if (!creatorId) {
        console.warn('⚠️ Startup catch-up: no admin user found, skipping');
        return;
      }
      const useOddsApi = !!process.env.THE_ODDS_API_KEY?.trim();
      const result = useOddsApi
        ? await autoGenerateFromOddsApi(creatorId)
        : await autoGenerateBettingTips(creatorId);
      console.log(`✅ Startup catch-up done [${useOddsApi ? 'TheOddsAPI' : 'API-Football'}]: ${result.created} created (${result.singles} singles, ${result.combos} combos)`);
    } catch (err: any) {
      console.error('❌ Startup catch-up failed:', err.message);
    }
  }, 15_000); // wait 15 s for full server boot

  // Runs at 6 AM Haiti time every day (America/Port-au-Prince = UTC-5 / UTC-4 DST).
  // The catch-up guard is reset so the backup can fire if the server was down at 6 AM.
  bettingTipsCronJob = cron.schedule('0 6 * * *', async () => {
    console.log('⚽ Betting Tips Cron Job: Starting daily auto-generation (6 AM Haiti)...');
    // Reset in-memory catch-up guard so today's date gets a fresh catch-up slot
    lastCatchUpAttemptDate = '';
    try {
      const creatorId = await getSystemCreatorId();
      if (!creatorId) {
        console.warn('⚠️ Betting Tips Cron: No admin/owner user found in DB, skipping auto-generation');
        return;
      }

      const useOddsApi = !!process.env.THE_ODDS_API_KEY?.trim();
      const result = useOddsApi
        ? await autoGenerateFromOddsApi(creatorId)
        : await autoGenerateBettingTips(creatorId);

      console.log(`✅ Betting Tips Cron Job completed [${useOddsApi ? 'TheOddsAPI' : 'API-Football'}]:`, {
        created: result.created,
        skipped: result.skipped,
        singles: result.singles,
        combos: result.combos,
        quotaRemaining: result.quotaRemaining,
        time: new Date().toISOString(),
      });
    } catch (error: any) {
      console.error('❌ Betting Tips Cron Job failed:', error.message);
    }
  }, { timezone: 'America/Port-au-Prince' });

  console.log('✅ Betting tips scheduler started - auto-generating daily at 6:00 AM Haiti time');

  // ─── RESULT AUTO-UPDATE: every 2 hours (at :00) ──────────────────────────
  resultUpdateCronJob = cron.schedule('0 */2 * * *', async () => {
    console.log('⚽ Result Update Cron: checking finished matches...');
    try {
      const stats = await autoUpdateBettingResults();
      console.log(`✅ Result Update done: ${stats.updated} updated, ${stats.skipped} skipped, ${stats.failed} failed`);
    } catch (err: any) {
      console.error('❌ Result Update Cron failed:', err.message);
    }
  }, { timezone: 'America/Port-au-Prince' });

  console.log('✅ Result auto-update scheduler started - runs every 2 hours');
}

export function stopBettingTipsScheduler(): void {
  if (bettingTipsCronJob) {
    bettingTipsCronJob.stop();
    bettingTipsCronJob.destroy();
    bettingTipsCronJob = null;
    console.log('🛑 Betting tips scheduler stopped');
  }
  if (resultUpdateCronJob) {
    resultUpdateCronJob.stop();
    resultUpdateCronJob.destroy();
    resultUpdateCronJob = null;
    console.log('🛑 Result update scheduler stopped');
  }
}

export function getBettingTipsSchedulerStatus(): { running: boolean; nextRun?: string } {
  if (!bettingTipsCronJob) {
    return { running: false };
  }
  return {
    running: true,
    nextRun: bettingTipsCronJob.nextDate()?.toISOString(),
  };
}
