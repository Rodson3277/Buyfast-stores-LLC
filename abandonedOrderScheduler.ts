import * as cron from 'node-cron';
import { storage } from '../storage';
import { sendUserNotification } from '../services/fcmService';
import { sendAbandonedCartEmail } from '../email';

// ─── Service labels in 4 languages ───────────────────────────────────────────
const SERVICE_LABELS: Record<string, Record<string, string>> = {
  en: { topup: 'Mobile Top-Up', natcash: 'NatCash Transfer', moncash: 'MonCash Transfer', wallet: 'Wallet Deposit', gift_card: 'Gift Card', bill: 'Bill Payment', unknown: 'Payment' },
  fr: { topup: 'Recharge Mobile', natcash: 'Transfert NatCash', moncash: 'Transfert MonCash', wallet: 'Dépôt Portefeuille', gift_card: 'Carte Cadeau', bill: 'Paiement de Facture', unknown: 'Paiement' },
  ht: { topup: 'Recharge Telefòn', natcash: 'Transfè NatCash', moncash: 'Transfè MonCash', wallet: 'Depoze nan Bous', gift_card: 'Kat Kado', bill: 'Peye Fakti', unknown: 'Peman' },
  es: { topup: 'Recarga Móvil', natcash: 'Transferencia NatCash', moncash: 'Transferencia MonCash', wallet: 'Depósito en Billetera', gift_card: 'Tarjeta de Regalo', bill: 'Pago de Factura', unknown: 'Pago' },
};

// ─── Notification text in 4 languages ────────────────────────────────────────
const NOTIF_TEXT: Record<string, { title: (svc: string) => string; body: (amount: string, svc: string) => string }> = {
  en: {
    title: (svc) => `Don't forget your ${svc}!`,
    body: (amount, svc) => `Your $${amount} ${svc} payment is waiting. Tap to complete it now.`,
  },
  fr: {
    title: (svc) => `N'oubliez pas votre ${svc}!`,
    body: (amount, svc) => `Votre paiement de ${svc} ($${amount}) vous attend. Appuyez pour terminer.`,
  },
  ht: {
    title: (svc) => `Pa bliye ${svc} ou!`,
    body: (amount, svc) => `Peman $${amount} ${svc} ou ap tann. Klike pou fin konplete l.`,
  },
  es: {
    title: (svc) => `¡No olvides tu ${svc}!`,
    body: (amount, svc) => `Tu pago de $${amount} de ${svc} está esperando. Toca para completarlo ahora.`,
  },
};

const BASE_URL = 'https://buyfasttopup.com';

function getResumeUrl(paypalOrderId: string): string {
  return `${BASE_URL}/resume?orderId=${paypalOrderId}`;
}

/**
 * Process abandoned orders and send reminders.
 * Runs every 5 minutes. First reminder at 15min, then every 24h, max 3 total.
 */
async function processAbandonedOrderReminders(): Promise<void> {
  try {
    const orders = await storage.getAbandonedOrdersForReminder();
    if (orders.length === 0) return;

    console.log(`🔔 ABANDONED ORDERS: Processing ${orders.length} order(s) for reminders`);

    for (const order of orders) {
      try {
        if (!order.userId) continue;

        const user = await storage.getUser(order.userId);
        if (!user || !user.email) {
          console.warn(`⚠️ Abandoned order ${order.paypalOrderId}: user not found or no email`);
          continue;
        }

        const lang = (user.language as 'en' | 'fr' | 'ht' | 'es') || 'en';
        const serviceLabel = SERVICE_LABELS[lang]?.[order.serviceType || 'unknown'] || SERVICE_LABELS.en.unknown;
        const amount = parseFloat(order.amount as string || '0').toFixed(2);
        const firstName = user.firstName || user.email.split('@')[0];
        const resumeUrl = getResumeUrl(order.paypalOrderId);
        const reminderNum = (order.reminderCount || 0) + 1;

        console.log(`📧 Sending reminder #${reminderNum} to ${user.email} for ${order.serviceType} order ${order.paypalOrderId}`);

        // ── Email ────────────────────────────────────────────────────────────
        try {
          await sendAbandonedCartEmail({
            to: user.email,
            firstName,
            lang,
            serviceLabel,
            amount,
            resumeUrl,
            serviceType: order.serviceType || 'unknown',
            recipientPhone: order.recipientPhone,
            reminderNum,
          });
        } catch (emailErr) {
          console.error(`⚠️ Abandoned order email failed for ${order.paypalOrderId}:`, emailErr);
        }

        // ── Push notification ─────────────────────────────────────────────────
        try {
          const notif = NOTIF_TEXT[lang] || NOTIF_TEXT.en;
          await sendUserNotification(order.userId, {
            title: notif.title(serviceLabel),
            body: notif.body(amount, serviceLabel),
            clickAction: resumeUrl,
            data: {
              type: 'abandoned_order',
              paypalOrderId: order.paypalOrderId,
              serviceType: order.serviceType || 'unknown',
              resumeUrl,
            },
          });
        } catch (fcmErr) {
          console.error(`⚠️ Abandoned order FCM failed for ${order.paypalOrderId}:`, fcmErr);
        }

        // ── Mark reminder sent ────────────────────────────────────────────────
        await storage.markAbandonedReminderSent(order.paypalOrderId);
        console.log(`✅ Reminder #${reminderNum} sent for order ${order.paypalOrderId}`);

      } catch (orderErr) {
        console.error(`❌ Failed to process reminder for order ${order.paypalOrderId}:`, orderErr);
      }
    }
  } catch (err) {
    console.error('❌ Abandoned order scheduler error:', err);
  }
}

/**
 * Start the abandoned order reminder scheduler.
 * Runs every 5 minutes.
 */
export function startAbandonedOrderScheduler(): void {
  console.log('🛒 Starting abandoned PayPal order reminder scheduler — every 5 minutes');
  cron.schedule('*/5 * * * *', () => {
    processAbandonedOrderReminders().catch(err =>
      console.error('❌ Abandoned order scheduler unhandled error:', err)
    );
  }, { timezone: 'America/Port-au-Prince' });
  console.log('✅ Abandoned order scheduler started');
}
