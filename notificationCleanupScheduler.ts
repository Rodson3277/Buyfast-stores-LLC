import * as cron from 'node-cron';

/**
 * Notification Cleanup Scheduler
 * Runs every day at 3:00 AM Haiti time (America/Port-au-Prince = UTC-4 or UTC-5).
 * Deletes all notifications older than 24 hours.
 */

async function deleteOldNotifications(): Promise<void> {
  try {
    const { pool } = await import('../db.js');
    const cutoff = new Date(Date.now() - 24 * 60 * 60 * 1000); // 24h ago
    const result = await pool.query(
      `DELETE FROM notifications WHERE created_at < $1`,
      [cutoff]
    );
    const count = result.rowCount ?? 0;
    if (count > 0) {
      console.log(`🗑️ NOTIFICATION CLEANUP: Deleted ${count} notification(s) older than 24h`);
    } else {
      console.log(`🗑️ NOTIFICATION CLEANUP: No old notifications to delete`);
    }
  } catch (err: any) {
    console.warn('⚠️ Notification cleanup scheduler error (non-critical):', err?.message);
  }
}

export function startNotificationCleanupScheduler(): void {
  // Run at 3:00 AM every day (Haiti time is UTC-4/UTC-5; cron uses server UTC).
  // "0 7 * * *" = 07:00 UTC = 03:00 Haiti time (EST, UTC-4 during EDT).
  cron.schedule('0 7 * * *', () => {
    console.log('⏰ NOTIFICATION CLEANUP: Running daily 24h cleanup...');
    deleteOldNotifications();
  }, { timezone: 'America/Port-au-Prince' });

  console.log('🗑️ Notification cleanup scheduler started — daily at 3 AM Haiti time');

  // Also run once immediately on startup to clean any backlog
  deleteOldNotifications();
}
