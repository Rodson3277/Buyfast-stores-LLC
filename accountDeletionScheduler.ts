import * as cron from 'node-cron';
import { db } from '../db';
import { users } from '@shared/schema';
import { sql, and, isNotNull, lte } from 'drizzle-orm';
import { storage } from '../storage';
import { sendEmail } from '../email.js';

const DELETE_AFTER_HOURS = 24;

async function autoDeleteExpiredRequests(): Promise<void> {
  try {
    const deadline = new Date(Date.now() - DELETE_AFTER_HOURS * 60 * 60 * 1000);

    const expired = await db.execute(sql`
      SELECT id, email
      FROM users
      WHERE delete_requested_at IS NOT NULL
        AND delete_requested_at <= ${deadline.toISOString()}
        AND email NOT IN ('rodsondeneus9@gmail.com', 'support@buyfasttopup.com')
        AND COALESCE(is_owner, false) = false
    `);

    if (expired.rows.length === 0) return;

    console.log(`🗑️ Auto-delete: ${expired.rows.length} account(s) scheduled for deletion`);

    for (const row of expired.rows as any[]) {
      try {
        // Send "account deleted" email before deleting so user receives it
        try {
          const lang = (row.language || 'en') as string;
          const msgs: Record<string, { subject: string; body: string }> = {
            en: { subject: '🗑️ Your BuyFast TopUp Account Has Been Deleted', body: 'Your account deletion request has been processed. Your BuyFast TopUp account and all associated data have been permanently deleted. We are sorry to see you go. If you ever wish to return, you are welcome to create a new account.' },
            ht: { subject: '🗑️ Kont BuyFast TopUp Ou A Efase', body: 'Demann efasman ou a te trete. Kont BuyFast TopUp ou a ak tout done ki asosye yo efase nèt. Nou regrèt ou prale. Si ou vle tounen yon jou, ou ka kreye yon nouvo kont.' },
            fr: { subject: '🗑️ Votre Compte BuyFast TopUp a été Supprimé', body: 'Votre demande de suppression a été traitée. Votre compte BuyFast TopUp et toutes les données associées ont été définitivement supprimés. Nous sommes désolés de vous voir partir. Si vous souhaitez revenir, vous êtes invités à créer un nouveau compte.' },
            es: { subject: '🗑️ Su Cuenta BuyFast TopUp Ha Sido Eliminada', body: 'Su solicitud de eliminación ha sido procesada. Su cuenta de BuyFast TopUp y todos los datos asociados han sido eliminados permanentemente. Lamentamos su partida. Si desea regresar, puede crear una nueva cuenta.' },
          };
          const m = msgs[lang] || msgs.en;
          const firstName = row.first_name || 'User';
          await sendEmail({
            to: row.email,
            subject: m.subject,
            htmlContent: `<div style="font-family:Arial,sans-serif;max-width:600px;margin:auto;padding:32px;background:#fff;border-radius:12px;"><h2 style="color:#EF4444;">${m.subject}</h2><p>Hello ${firstName},</p><p>${m.body}</p><hr><p style="color:#aaa;font-size:12px;">BuyFast TopUp</p></div>`,
            textContent: `Hello ${firstName},\n\n${m.body}`,
          });
          console.log(`📧 Account deletion confirmation email sent to ${row.email}`);
        } catch (emailErr) {
          console.warn(`⚠️ Could not send deletion confirmation email to ${row.email}:`, (emailErr as any).message);
        }

        await storage.deleteUser(row.id);
        console.log(`✅ Auto-deleted account: ${row.email} (requested >24h ago)`);

        // Try to delete from Firebase Admin by email lookup
        try {
          const { getAdminAuth } = await import('../firebase-admin.js');
          const fbUser = await getAdminAuth().getUserByEmail(row.email);
          if (fbUser?.uid) {
            await getAdminAuth().deleteUser(fbUser.uid);
          }
        } catch (fbErr) {
          console.warn(`⚠️ Firebase deletion skipped for ${row.email}:`, (fbErr as any).message);
        }
      } catch (e) {
        console.error(`❌ Auto-delete failed for user ${row.id}:`, e);
      }
    }
  } catch (err) {
    console.error('❌ accountDeletionScheduler error:', err);
  }
}

export function startAccountDeletionScheduler(): void {
  // Run every hour at minute 30
  cron.schedule('30 * * * *', async () => {
    console.log('🗑️ Account deletion scheduler: checking expired requests...');
    await autoDeleteExpiredRequests();
  });

  // Also run on startup after 15s delay
  setTimeout(async () => {
    console.log('🗑️ Account deletion scheduler (startup): checking expired requests...');
    await autoDeleteExpiredRequests();
  }, 15000);

  console.log('✅ Account deletion scheduler started (runs every hour)');
}
