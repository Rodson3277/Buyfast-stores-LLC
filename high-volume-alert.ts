/**
 * 🚨 HIGH VOLUME USER ALERT SYSTEM
 * Sends admin notification (FCM push + email) when a user's
 * daily topup spending exceeds $200 USD.
 *
 * - One alert per user per day (deduplication via in-memory Map)
 * - Non-blocking: call fire-and-forget after successful topup
 * - Resets at midnight UTC
 */

import { storage } from '../storage';
import { sendUserNotification } from '../services/fcmService';
import { sendEmail } from '../email';
import { db } from '../db';
import { transactions } from '../../shared/schema';
import { sql } from 'drizzle-orm';

export const HIGH_VOLUME_THRESHOLD_USD = 200;

// userId → UTC dateKey ("2026-04-20") — one alert per user per day
const alertedToday = new Map<string, string>();

function getTodayKey(): string {
  const now = new Date();
  return `${now.getUTCFullYear()}-${String(now.getUTCMonth() + 1).padStart(2, '0')}-${String(now.getUTCDate()).padStart(2, '0')}`;
}

async function getDailyTotalForUser(userId: string): Promise<number> {
  try {
    const startOfDay = new Date();
    startOfDay.setUTCHours(0, 0, 0, 0);

    const result = await db
      .select({ total: sql<number>`COALESCE(SUM(${transactions.amount}), 0)` })
      .from(transactions)
      .where(
        sql`${transactions.userId} = ${userId}
          AND ${transactions.status} IN ('completed', 'successful', 'SUCCESSFUL')
          AND ${transactions.createdAt} >= ${startOfDay.toISOString()}`
      );

    return Number(result[0]?.total ?? 0);
  } catch (err: any) {
    console.error('⚠️ high-volume-alert getDailyTotal error:', err?.message);
    return 0;
  }
}

/**
 * Call fire-and-forget after every successful authenticated topup.
 * Example: checkAndAlertHighVolumeUser({ userId, recipientPhone, amountUSD }).catch(() => {});
 */
export async function checkAndAlertHighVolumeUser(opts: {
  userId: string;
  recipientPhone: string;
  amountUSD: number;
}): Promise<void> {
  const { userId, recipientPhone, amountUSD } = opts;

  try {
    // Skip if already alerted today
    const today = getTodayKey();
    if (alertedToday.get(userId) === today) return;

    const dailyTotal = await getDailyTotalForUser(userId);
    if (dailyTotal < HIGH_VOLUME_THRESHOLD_USD) return;

    // Mark now so concurrent calls don't double-fire
    alertedToday.set(userId, today);

    // Fetch user info
    const user = await storage.getUser(userId);
    const userEmail = user?.email ?? 'unknown@email.com';
    const userName = [user?.firstName, user?.lastName].filter(Boolean).join(' ') || userEmail;
    const totalFormatted = `$${dailyTotal.toFixed(2)}`;
    const dateLabel = new Date().toLocaleDateString('en-US', {
      weekday: 'short', month: 'short', day: 'numeric',
      year: 'numeric', timeZone: 'America/Port-au-Prince'
    });

    console.log(`🚨 HIGH VOLUME ALERT: ${userEmail} — ${totalFormatted} today (limit: $${HIGH_VOLUME_THRESHOLD_USD})`);

    // ── FCM Push to all online admin devices ──────────────────────────
    try {
      const adminIds = await storage.getOnlineAdminIds();
      await Promise.allSettled(
        adminIds.map(adminId =>
          sendUserNotification(adminId, {
            title: `🚨 Gwo Volim — ${totalFormatted} jodi a`,
            body: `${userName} (${userEmail}) depanse ${totalFormatted} jodi a. Dènye topup: ${recipientPhone}`,
            clickAction: '/admin/transactions',
            data: { type: 'high_volume_alert', userId, userEmail, dailyTotal: String(dailyTotal) }
          })
        )
      );
      console.log(`📱 High-volume FCM sent to ${adminIds.length} admin(s)`);
    } catch (fcmErr: any) {
      console.warn('⚠️ high-volume FCM error:', fcmErr?.message);
    }

    // ── Email to admin ────────────────────────────────────────────────
    try {
      const subject = `🚨 [BuyFast Alert] High-Volume User — ${totalFormatted} Today`;
      const htmlContent = `
<!DOCTYPE html><html><head><meta charset="UTF-8"></head>
<body style="font-family:Arial,sans-serif;background:#f4f4f4;margin:0;padding:20px;">
  <div style="max-width:560px;margin:0 auto;background:#fff;border-radius:8px;overflow:hidden;border:1px solid #e0e0e0;">
    <div style="background:#00424C;padding:20px 28px;">
      <h1 style="color:#D6F000;margin:0;font-size:20px;">🚨 High-Volume Spending Alert</h1>
    </div>
    <div style="padding:24px 28px;">
      <table style="width:100%;border-collapse:collapse;font-size:14px;">
        <tr style="background:#FFF3CD;">
          <td style="padding:10px;font-weight:bold;border:1px solid #eee;">User</td>
          <td style="padding:10px;border:1px solid #eee;">${userName} &lt;${userEmail}&gt;</td>
        </tr>
        <tr>
          <td style="padding:10px;font-weight:bold;border:1px solid #eee;">Daily Total</td>
          <td style="padding:10px;border:1px solid #eee;color:#DC2626;font-weight:bold;">${totalFormatted}</td>
        </tr>
        <tr style="background:#f9f9f9;">
          <td style="padding:10px;font-weight:bold;border:1px solid #eee;">Threshold</td>
          <td style="padding:10px;border:1px solid #eee;">$${HIGH_VOLUME_THRESHOLD_USD}.00 USD</td>
        </tr>
        <tr>
          <td style="padding:10px;font-weight:bold;border:1px solid #eee;">Last Topup To</td>
          <td style="padding:10px;border:1px solid #eee;">${recipientPhone}</td>
        </tr>
        <tr style="background:#f9f9f9;">
          <td style="padding:10px;font-weight:bold;border:1px solid #eee;">Date</td>
          <td style="padding:10px;border:1px solid #eee;">${dateLabel} (Haiti time)</td>
        </tr>
      </table>
      <div style="margin-top:20px;padding:14px;background:#FEF2F2;border-left:4px solid #DC2626;border-radius:4px;">
        <p style="margin:0;font-size:13px;color:#7F1D1D;">
          ⚠️ This user has exceeded the $${HIGH_VOLUME_THRESHOLD_USD} daily spending alert threshold.
          Please review their transaction history and verify their identity if needed.
        </p>
      </div>
      <div style="text-align:center;margin-top:20px;">
        <a href="https://buyfasttopup.com/admin/transactions"
           style="display:inline-block;background:#00424C;color:#D6F000;text-decoration:none;padding:12px 36px;border-radius:6px;font-size:14px;font-weight:700;">
          View Transactions →
        </a>
      </div>
    </div>
    <div style="background:#f8f8f8;padding:14px 28px;text-align:center;border-top:1px solid #eee;">
      <p style="color:#aaa;font-size:11px;margin:0;">© ${new Date().getFullYear()} BuyFast TopUp · Admin Alert System</p>
    </div>
  </div>
</body></html>`;

      const textContent = `[HIGH VOLUME ALERT] ${userName} (${userEmail}) spent ${totalFormatted} today. Last topup to: ${recipientPhone}. Review: https://buyfasttopup.com/admin/transactions`;

      await Promise.allSettled([
        sendEmail({ to: 'rodsondeneus9@gmail.com', subject, htmlContent, textContent }),
        sendEmail({ to: 'support@buyfasttopup.com', subject, htmlContent, textContent }),
      ]);

      console.log('📧 High-volume alert emails sent');
    } catch (emailErr: any) {
      console.warn('⚠️ high-volume email error:', emailErr?.message);
    }

  } catch (err: any) {
    console.error('❌ checkAndAlertHighVolumeUser error:', err?.message);
  }
}
