/**
 * 🛡️ CARD/PAYMENT SOURCE BLOCKING SYSTEM
 * Detects and blocks payment sources (cards, PayPal accounts) that send excessive topups.
 * Admin can manually block/unblock payment sources.
 * Auto-blocks cards with 10+ topups in 24 hours or 3+ failed attempts in 1 hour.
 */

interface PaymentSourceRecord {
  identifier: string;
  provider: string;
  last4?: string;
  network?: string;
  payerEmail?: string;
  payerId?: string;
  userId?: string;
  attempts: {
    timestamp: number;
    amount: string;
    status: 'success' | 'failed' | 'pending';
    transactionId?: string;
    ip?: string;
  }[];
  blocked: boolean;
  blockedAt?: number;
  blockedReason?: string;
  blockedBy?: string;
  permanent: boolean;
  expiresAt?: number;
}

const blockedPaymentSources = new Map<string, PaymentSourceRecord>();

const AUTO_BLOCK_MAX_TOPUPS_24H = 10;
const AUTO_BLOCK_MAX_FAILED_1H = 3;
const AUTO_BLOCK_DURATION_MS = 48 * 60 * 60 * 1000;
const WINDOW_24H_MS = 24 * 60 * 60 * 1000;
const WINDOW_1H_MS = 60 * 60 * 1000;

function generateSourceKey(provider: string, identifier: string): string {
  return `${provider}:${identifier}`.toLowerCase();
}

function cleanupExpired(): void {
  const now = Date.now();
  const toDelete: string[] = [];
  blockedPaymentSources.forEach((record, key) => {
    if (!record.permanent && record.expiresAt && now > record.expiresAt) {
      record.blocked = false;
      record.blockedAt = undefined;
      record.blockedReason = undefined;
      record.expiresAt = undefined;
    }
    record.attempts = record.attempts.filter(a => now - a.timestamp < WINDOW_24H_MS);
    if (record.attempts.length === 0 && !record.blocked) {
      toDelete.push(key);
    }
  });
  toDelete.forEach(key => blockedPaymentSources.delete(key));
}

export function trackPaymentSourceTopup(params: {
  provider: string;
  identifier: string;
  last4?: string;
  network?: string;
  payerEmail?: string;
  payerId?: string;
  userId?: string;
  amount: string;
  status: 'success' | 'failed' | 'pending';
  transactionId?: string;
  ip?: string;
}): void {
  const key = generateSourceKey(params.provider, params.identifier);
  let record = blockedPaymentSources.get(key);

  if (!record) {
    record = {
      identifier: params.identifier,
      provider: params.provider,
      last4: params.last4,
      network: params.network,
      payerEmail: params.payerEmail,
      payerId: params.payerId,
      userId: params.userId,
      attempts: [],
      blocked: false,
      permanent: false
    };
    blockedPaymentSources.set(key, record);
  }

  if (params.last4) record.last4 = params.last4;
  if (params.network) record.network = params.network;
  if (params.payerEmail) record.payerEmail = params.payerEmail;
  if (params.payerId) record.payerId = params.payerId;
  if (params.userId) record.userId = params.userId;

  record.attempts.push({
    timestamp: Date.now(),
    amount: params.amount,
    status: params.status,
    transactionId: params.transactionId,
    ip: params.ip
  });
}

export function checkPaymentSourceBlocked(
  provider: string,
  identifier: string
): { blocked: boolean; reason?: string; remainingSeconds?: number } {
  cleanupExpired();
  const key = generateSourceKey(provider, identifier);
  const record = blockedPaymentSources.get(key);

  if (!record) {
    return { blocked: false };
  }

  if (record.blocked) {
    const now = Date.now();
    let remainingSeconds: number | undefined;

    if (!record.permanent && record.expiresAt) {
      if (now > record.expiresAt) {
        record.blocked = false;
        record.blockedAt = undefined;
        record.blockedReason = undefined;
        record.expiresAt = undefined;
        return { blocked: false };
      }
      remainingSeconds = Math.ceil((record.expiresAt - now) / 1000);
    }

    console.log(`🚫 PAYMENT SOURCE BLOCKED: ${key} - ${record.blockedReason}`);
    return {
      blocked: true,
      reason: record.blockedReason || 'Payment source blocked due to excessive activity',
      remainingSeconds
    };
  }

  return { blocked: false };
}

export function autoCheckAndBlock(
  provider: string,
  identifier: string
): { blocked: boolean; reason?: string } {
  cleanupExpired();
  const key = generateSourceKey(provider, identifier);
  const record = blockedPaymentSources.get(key);

  if (!record || record.blocked) {
    return { blocked: record?.blocked || false, reason: record?.blockedReason };
  }

  const now = Date.now();

  const attempts24h = record.attempts.filter(a => now - a.timestamp < WINDOW_24H_MS);
  if (attempts24h.length >= AUTO_BLOCK_MAX_TOPUPS_24H) {
    record.blocked = true;
    record.blockedAt = now;
    record.expiresAt = now + AUTO_BLOCK_DURATION_MS;
    record.blockedReason = `Auto-blocked: ${attempts24h.length} topups in 24 hours (limit: ${AUTO_BLOCK_MAX_TOPUPS_24H})`;
    record.blockedBy = 'system';
    record.permanent = false;
    console.log(`🚨 AUTO-BLOCK CARD: ${key} - ${record.blockedReason}`);
    return { blocked: true, reason: record.blockedReason };
  }

  const failedAttempts1h = record.attempts.filter(
    a => now - a.timestamp < WINDOW_1H_MS && a.status === 'failed'
  );
  if (failedAttempts1h.length >= AUTO_BLOCK_MAX_FAILED_1H) {
    record.blocked = true;
    record.blockedAt = now;
    record.expiresAt = now + AUTO_BLOCK_DURATION_MS;
    record.blockedReason = `Auto-blocked: ${failedAttempts1h.length} failed attempts in 1 hour (limit: ${AUTO_BLOCK_MAX_FAILED_1H})`;
    record.blockedBy = 'system';
    record.permanent = false;
    console.log(`🚨 AUTO-BLOCK CARD: ${key} - ${record.blockedReason}`);
    return { blocked: true, reason: record.blockedReason };
  }

  return { blocked: false };
}

export function adminBlockPaymentSource(
  provider: string,
  identifier: string,
  reason: string,
  blockedBy: string,
  permanent: boolean = true,
  durationHours?: number
): boolean {
  const key = generateSourceKey(provider, identifier);
  let record = blockedPaymentSources.get(key);

  if (!record) {
    record = {
      identifier,
      provider,
      attempts: [],
      blocked: true,
      blockedAt: Date.now(),
      blockedReason: reason,
      blockedBy,
      permanent
    };
  } else {
    record.blocked = true;
    record.blockedAt = Date.now();
    record.blockedReason = reason;
    record.blockedBy = blockedBy;
    record.permanent = permanent;
  }

  if (!permanent && durationHours) {
    record.expiresAt = Date.now() + durationHours * 60 * 60 * 1000;
  }

  blockedPaymentSources.set(key, record);
  console.log(`🚫 ADMIN BLOCKED PAYMENT SOURCE: ${key} by ${blockedBy} - ${reason} (${permanent ? 'permanent' : `${durationHours}h`})`);
  return true;
}

export function adminUnblockPaymentSource(
  provider: string,
  identifier: string,
  unblockedBy: string
): boolean {
  const key = generateSourceKey(provider, identifier);
  const record = blockedPaymentSources.get(key);

  if (!record) {
    return false;
  }

  record.blocked = false;
  record.blockedAt = undefined;
  record.blockedReason = undefined;
  record.blockedBy = undefined;
  record.permanent = false;
  record.expiresAt = undefined;
  console.log(`✅ ADMIN UNBLOCKED PAYMENT SOURCE: ${key} by ${unblockedBy}`);
  return true;
}

export function getAllBlockedPaymentSources(): Array<{
  key: string;
  provider: string;
  identifier: string;
  last4?: string;
  network?: string;
  payerEmail?: string;
  payerId?: string;
  userId?: string;
  blocked: boolean;
  blockedAt?: number;
  blockedReason?: string;
  blockedBy?: string;
  permanent: boolean;
  expiresAt?: number;
  totalAttempts: number;
  successfulAttempts: number;
  failedAttempts: number;
  recentAttempts: number;
}> {
  cleanupExpired();
  const results: any[] = [];
  const now = Date.now();

  blockedPaymentSources.forEach((record, key) => {
    results.push({
      key,
      provider: record.provider,
      identifier: record.identifier,
      last4: record.last4,
      network: record.network,
      payerEmail: record.payerEmail,
      payerId: record.payerId,
      userId: record.userId,
      blocked: record.blocked,
      blockedAt: record.blockedAt,
      blockedReason: record.blockedReason,
      blockedBy: record.blockedBy,
      permanent: record.permanent,
      expiresAt: record.expiresAt,
      totalAttempts: record.attempts.length,
      successfulAttempts: record.attempts.filter(a => a.status === 'success').length,
      failedAttempts: record.attempts.filter(a => a.status === 'failed').length,
      recentAttempts: record.attempts.filter(a => now - a.timestamp < WINDOW_1H_MS).length
    });
  });

  return results.sort((a, b) => {
    if (a.blocked && !b.blocked) return -1;
    if (!a.blocked && b.blocked) return 1;
    return b.totalAttempts - a.totalAttempts;
  });
}

export function getPaymentSourceStats(): {
  totalTracked: number;
  totalBlocked: number;
  autoBlocked: number;
  adminBlocked: number;
} {
  cleanupExpired();
  let totalBlocked = 0;
  let autoBlocked = 0;
  let adminBlocked = 0;

  blockedPaymentSources.forEach(record => {
    if (record.blocked) {
      totalBlocked++;
      if (record.blockedBy === 'system') autoBlocked++;
      else adminBlocked++;
    }
  });

  return {
    totalTracked: blockedPaymentSources.size,
    totalBlocked,
    autoBlocked,
    adminBlocked
  };
}

export interface StripeCardDetails {
  fingerprint: string | null;
  last4: string | null;
  brand: string | null;
  country: string | null;
  expMonth: number | null;
  expYear: number | null;
  funding: string | null;
}

export async function extractStripeCardDetails(stripe: any, paymentIntentId: string): Promise<StripeCardDetails> {
  const empty: StripeCardDetails = { fingerprint: null, last4: null, brand: null, country: null, expMonth: null, expYear: null, funding: null };
  try {
    const paymentIntent = await stripe.paymentIntents.retrieve(paymentIntentId, {
      expand: ['payment_method']
    });
    const pm = paymentIntent.payment_method;
    if (pm && typeof pm === 'object' && pm.card) {
      const card = pm.card;
      const details: StripeCardDetails = {
        fingerprint: card.fingerprint || null,
        last4: card.last4 || null,
        brand: card.brand || null,
        country: card.country || null,
        expMonth: card.exp_month || null,
        expYear: card.exp_year || null,
        funding: card.funding || null
      };
      console.log(`🔍 STRIPE CARD: fingerprint=${details.fingerprint}, last4=${details.last4}, brand=${details.brand}, country=${details.country}, funding=${details.funding}`);
      return details;
    }
  } catch (err: any) {
    console.error(`⚠️ Failed to extract Stripe card details for ${paymentIntentId}:`, err.message);
  }
  return empty;
}

setInterval(cleanupExpired, 10 * 60 * 1000);

console.log(`🛡️ CARD BLOCKING: System initialized (auto-block: ${AUTO_BLOCK_MAX_TOPUPS_24H} topups/24h, ${AUTO_BLOCK_MAX_FAILED_1H} failures/1h)`);
