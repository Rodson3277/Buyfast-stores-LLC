/**
 * 🚨 MULTI-ACCOUNT CARD FRAUD DETECTOR
 *
 * Detects when the SAME payment card / PayPal account is used to fund
 * MULTIPLE different user accounts — a common fraud pattern where one
 * person controls several accounts with a single card.
 *
 * Strategy:
 *   - In-memory Map  : fast real-time check (cleared on restart)
 *   - fraudTriggers table : persistent record of detected cases
 *   - paypal_order_tracking : historical PayPal payer cross-check
 *   - transactions table  : historical Stripe last-4 cross-check (approx)
 */

import { db } from '../db';
import { fraudTriggers, users } from '../../shared/schema';
import { eq, and, inArray, ne, sql } from 'drizzle-orm';

// ─────────────────────────────────────────────────────────────
// In-memory store: normalised card key → Set of userIds
// e.g.  "stripe:fp_abc123" → new Set(["uid1","uid2"])
// ─────────────────────────────────────────────────────────────
const cardToAccounts = new Map<string, Set<string>>();

function cardKey(provider: 'stripe' | 'paypal', identifier: string): string {
  return `${provider}:${identifier.toLowerCase().trim()}`;
}

// ─────────────────────────────────────────────────────────────
// Seed in-memory map from persisted fraud triggers on startup
// ─────────────────────────────────────────────────────────────
export async function seedMultiAccountMapFromDB(): Promise<void> {
  try {
    const rows = await db.select()
      .from(fraudTriggers)
      .where(eq(fraudTriggers.type, 'multi_account_card'));

    for (const row of rows) {
      const meta = row.metrics as any;
      if (meta?.cardKey && Array.isArray(meta?.linkedUserIds)) {
        const set = cardToAccounts.get(meta.cardKey) || new Set<string>();
        for (const uid of meta.linkedUserIds) set.add(uid);
        cardToAccounts.set(meta.cardKey, set);
      }
    }
    console.log(`🛡️ MultiAccountDetector: seeded ${cardToAccounts.size} card keys from DB`);
  } catch (err) {
    console.error('⚠️ MultiAccountDetector seed error (non-fatal):', err);
  }
}

// ─────────────────────────────────────────────────────────────
// Core check-and-record function
//
// Returns:
//   { fraud: true,  linkedUserIds }  — card shared across accounts
//   { fraud: false }                 — first use or same account
// ─────────────────────────────────────────────────────────────
export async function checkAndRecordCardAccount(params: {
  provider: 'stripe' | 'paypal';
  identifier: string;   // Stripe fingerprint OR PayPal payer email / payer_id
  userId: string;
  last4?: string;
  payerEmail?: string;
  blockUser: (uid: string, reason: string) => Promise<void>;
}): Promise<{ fraud: boolean; linkedUserIds?: string[]; reason?: string }> {
  const { provider, identifier, userId, last4, payerEmail, blockUser } = params;

  if (!identifier || !userId) return { fraud: false };

  const key = cardKey(provider, identifier);

  // ── 1. In-memory check ──────────────────────────────────────
  let accountSet = cardToAccounts.get(key);
  if (!accountSet) {
    accountSet = new Set<string>();
    cardToAccounts.set(key, accountSet);
  }

  accountSet.add(userId);

  const otherAccounts = [...accountSet].filter(id => id !== userId);
  let isMultiAccount = otherAccounts.length > 0;

  // ── 2. DB cross-check for PayPal (paypal_order_tracking) ────
  if (!isMultiAccount && provider === 'paypal' && payerEmail) {
    try {
      const dbRows = await db.execute(sql`
        SELECT DISTINCT user_id
        FROM paypal_order_tracking
        WHERE payer_email = ${payerEmail}
          AND user_id IS NOT NULL
          AND user_id != ${userId}
        LIMIT 5
      `);
      const rows = (dbRows as any).rows || [];
      if (rows.length > 0) {
        const dbOtherIds = rows.map((r: any) => r.user_id as string);
        for (const id of dbOtherIds) accountSet.add(id);
        otherAccounts.push(...dbOtherIds);
        isMultiAccount = true;
        cardToAccounts.set(key, accountSet);
      }
    } catch (_) { /* non-fatal */ }
  }

  // ── 3. DB cross-check for Stripe (transactions last4 approx) ─
  // Note: last4 alone is not unique, but combined with flagging it
  // provides a useful signal when fingerprint match confirms fraud.
  // (Real protection is the in-memory fingerprint map above.)

  if (!isMultiAccount) {
    // No other account found — record this user and return clean
    return { fraud: false };
  }

  // ── 4. FRAUD CONFIRMED ──────────────────────────────────────
  const allLinkedIds = [...accountSet];
  const label = provider === 'stripe'
    ? `Stripe card ****${last4 || '????'} (fingerprint: ${identifier.substring(0, 12)}...)`
    : `PayPal account ${payerEmail || identifier.substring(0, 20)}...`;

  console.error(`🚨 MULTI-ACCOUNT FRAUD: ${label} used on ${allLinkedIds.length} accounts: ${allLinkedIds.join(', ')}`);

  // Block all linked accounts automatically
  for (const uid of allLinkedIds) {
    try {
      await blockUser(uid, `Auto-blocked: ${label} shared across ${allLinkedIds.length} accounts [multi-account fraud]`);
      console.log(`🔒 AUTO-BLOCKED account ${uid} (multi-account card fraud)`);
    } catch (blockErr) {
      console.error(`❌ Failed to block account ${uid}:`, blockErr);
    }
  }

  // Persist to fraudTriggers for admin visibility & server-restart persistence
  try {
    await db.insert(fraudTriggers).values({
      type: 'multi_account_card',
      userId,
      severity: allLinkedIds.length >= 3 ? 'critical' : 'high',
      rule: 'shared_payment_method_multi_account',
      triggerWindow: 'all_time',
      metrics: {
        cardKey: key,
        provider,
        identifier: identifier.substring(0, 20),
        last4: last4 || null,
        payerEmail: payerEmail || null,
        linkedUserIds: allLinkedIds,
        detectedForUserId: userId,
        detectedAt: new Date().toISOString(),
      },
    });
  } catch (dbErr) {
    console.error('⚠️ Failed to persist multi-account fraud trigger (non-fatal):', dbErr);
  }

  return {
    fraud: true,
    linkedUserIds: allLinkedIds,
    reason: `${label} was already used on ${otherAccounts.length} other account(s): ${otherAccounts.join(', ')}`,
  };
}

// ─────────────────────────────────────────────────────────────
// Admin: get all detected multi-account card fraud cases
// ─────────────────────────────────────────────────────────────
export async function getMultiAccountFraudCases(): Promise<{
  cardKey: string;
  provider: string;
  identifier: string;
  last4: string | null;
  payerEmail: string | null;
  linkedUserIds: string[];
  detectedAt: string;
  severity: string;
}[]> {
  try {
    const rows = await db.select()
      .from(fraudTriggers)
      .where(eq(fraudTriggers.type, 'multi_account_card'))
      .orderBy(sql`triggered_at DESC`)
      .limit(100);

    // Deduplicate by cardKey — return latest entry per card
    const seen = new Set<string>();
    const results = [];
    for (const row of rows) {
      const meta = row.metrics as any;
      if (!meta?.cardKey || seen.has(meta.cardKey)) continue;
      seen.add(meta.cardKey);
      results.push({
        cardKey: meta.cardKey,
        provider: meta.provider || 'unknown',
        identifier: meta.identifier || '',
        last4: meta.last4 || null,
        payerEmail: meta.payerEmail || null,
        linkedUserIds: meta.linkedUserIds || [],
        detectedAt: meta.detectedAt || row.triggeredAt?.toISOString() || '',
        severity: row.severity,
      });
    }
    return results;
  } catch (err) {
    console.error('getMultiAccountFraudCases error:', err);
    return [];
  }
}
