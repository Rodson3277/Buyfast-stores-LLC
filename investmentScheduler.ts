import * as cron from 'node-cron';
import { db } from '../db';
import { investments, investmentSettings, investmentServicePools, investmentAccruals } from '@shared/schema';
import { and, eq, gt, lte } from 'drizzle-orm';
import { getInvestmentSettings } from '../investmentRoutes';
import { ensureServicePools, getServiceRevenue, SERVICE_DEFS } from '../investmentServices';

/**
 * Daily profit accrual for the BuyFast Investment pools.
 *
 * Each service has its OWN pool funded ONLY by that service's own revenue, and
 * investors who picked that service share ONLY its pool.
 *
 * Safety invariant (per pool): profit distributed can never exceed the revenue
 * actually collected for that service. For each enabled service pool we:
 *   1. Lock the pool row FOR UPDATE (single-writer → no double-counting).
 *   2. Sum that service's revenue COMPLETED in (lastAccrualAt, now], read in-tx.
 *   3. Route poolPercentage of it into the pool buffer.
 *   4. Flip matured investments of this service to 'matured'.
 *   5. Distribute the buffer pro-rata (principal × weight) to that service's
 *      still-active investments, with residual allocation so distributed ≤ pool.
 */
export async function runDailyInvestmentAccrual(): Promise<void> {
  const bootSettings = await getInvestmentSettings();
  if (!bootSettings.isEnabled) return;
  await ensureServicePools();

  for (const def of SERVICE_DEFS) {
    try {
      await accrueServicePool(def.serviceType);
    } catch (err: any) {
      console.error(`❌ Investment accrual error for ${def.serviceType}:`, err?.message || err);
    }
  }
}

async function accrueServicePool(serviceType: string): Promise<void> {
  await db.transaction(async (tx) => {
    // 🔒 SINGLE-WRITER: lock THIS service's pool row so two overlapping runs
    // serialize. The second run reads the already-advanced last_accrual_at and
    // computes a ~0 revenue window, so the same revenue can never be counted
    // (and distributed) twice — the bounded-payout invariant, per pool.
    const [pool] = await tx.select().from(investmentServicePools)
      .where(eq(investmentServicePools.serviceType, serviceType)).for('update');
    if (!pool) return;

    const now = new Date();

    // Disabled pool: do NOT accrue, but STILL advance the window so re-enabling
    // later cannot retroactively sweep revenue earned while it was off.
    if (!pool.isEnabled) {
      await tx.update(investmentServicePools)
        .set({ lastAccrualAt: now, updatedAt: now })
        .where(eq(investmentServicePools.serviceType, serviceType));
      return;
    }

    const lastAt = pool.lastAccrualAt ? new Date(pool.lastAccrualAt) : new Date(0);
    const poolPct = parseFloat(pool.poolPercentage || '0');

    // This service's revenue in (lastAt, now], read INSIDE the locked tx.
    const revenue = await getServiceRevenue(tx, serviceType, lastAt, now);
    const contribution = Math.max(0, (revenue * poolPct) / 100);

    // Flip matured investments of THIS service so they stop earning.
    await tx.update(investments)
      .set({ status: 'matured' })
      .where(and(
        eq(investments.serviceType, serviceType),
        eq(investments.status, 'active'),
        lte(investments.maturityDate, now),
      ));

    // Still-locked investments of this service that earn this cycle.
    const active = await tx.select().from(investments)
      .where(and(
        eq(investments.serviceType, serviceType),
        eq(investments.status, 'active'),
        gt(investments.maturityDate, now),
      ));

    const poolTotal = parseFloat(pool.poolBalance || '0') + contribution;
    const totalContributed = parseFloat(pool.totalContributed || '0') + contribution;

    const totalShares = active.reduce(
      (s, inv) => s + parseFloat(inv.principal || '0') * parseFloat(inv.weight || '1'),
      0,
    );

    // Residual allocation: draw down a running `remainingPool`; the LAST eligible
    // row mops up the rounding remainder, so the sum distributed is EXACTLY ≤ pool.
    let remainingPool = poolTotal;
    if (totalShares > 0 && poolTotal > 0) {
      for (let i = 0; i < active.length; i++) {
        const inv = active[i];
        const isLast = i === active.length - 1;
        const share = parseFloat(inv.principal || '0') * parseFloat(inv.weight || '1');
        let profitShare = isLast ? remainingPool : (poolTotal * share) / totalShares;
        if (profitShare > remainingPool) profitShare = remainingPool;
        if (profitShare <= 0) continue;
        remainingPool -= profitShare;
        const newProfit = parseFloat(inv.accruedProfit || '0') + profitShare;
        await tx.update(investments)
          .set({ accruedProfit: newProfit.toFixed(6) })
          .where(eq(investments.id, inv.id));
        // Ledger row powering the investor's "profit over time" chart.
        await tx.insert(investmentAccruals).values({
          investmentId: inv.id,
          userId: inv.userId,
          serviceType,
          amount: profitShare.toFixed(6),
        });
      }
    }

    const distributed = poolTotal - remainingPool; // ≤ poolTotal by construction
    const totalDistributed = parseFloat(pool.totalDistributed || '0') + distributed;

    await tx.update(investmentServicePools).set({
      poolBalance: Math.max(0, remainingPool).toFixed(6),
      totalContributed: totalContributed.toFixed(6),
      totalDistributed: totalDistributed.toFixed(6),
      lastAccrualAt: now,
      updatedAt: now,
    }).where(eq(investmentServicePools.serviceType, serviceType));

    if (contribution > 0 || distributed > 0) {
      console.log(`💹 [${serviceType}] accrual: +$${contribution.toFixed(4)} pooled, $${distributed.toFixed(4)} to ${active.length} investment(s)`);
    }
  });
}

/** Start the daily investment accrual scheduler (1:00 AM Haiti time). */
export function startInvestmentScheduler(): void {
  console.log('💹 Starting investment profit accrual scheduler — daily at 1:00 AM Haiti time');
  cron.schedule('0 1 * * *', () => {
    runDailyInvestmentAccrual().catch((err) =>
      console.error('❌ Investment accrual scheduler error:', err),
    );
  }, { timezone: 'America/Port-au-Prince' });
  console.log('✅ Investment accrual scheduler started');
}
