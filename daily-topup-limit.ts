/**
 * 🛡️ DAILY TOPUP LIMIT PER PHONE NUMBER
 * DUAL PROTECTION: In-memory fast checks + Database-backed persistent checks
 * 
 * 1. In-memory: Fast per-user per-phone limit (resets on restart)
 * 2. Database: Global per-phone limit across ALL users/guests (persistent)
 * 
 * Blocks accounts that send 5+ topups to the same phone number in a single day.
 */

import { normalizePhone } from '../utils/normalize-phone';

interface DailyRecord {
  count: number;
  dateKey: string;
}

const dailyTopupStore = new Map<string, DailyRecord>();

const MAX_TOPUPS_PER_DAY_PER_PHONE = 5;
const MAX_GLOBAL_TOPUPS_PER_PHONE_PER_DAY = 5;

function getTodayKey(): string {
  const now = new Date();
  return `${now.getUTCFullYear()}-${String(now.getUTCMonth() + 1).padStart(2, '0')}-${String(now.getUTCDate()).padStart(2, '0')}`;
}

function buildKey(userId: string, phone: string): string {
  return `${userId}:${normalizePhone(phone)}`;
}

function cleanupOldDays(): void {
  const today = getTodayKey();
  const toDelete: string[] = [];
  dailyTopupStore.forEach((record, key) => {
    if (record.dateKey !== today) {
      toDelete.push(key);
    }
  });
  toDelete.forEach(k => dailyTopupStore.delete(k));
}

export function checkDailyTopupLimit(
  userId: string,
  recipientPhone: string
): { allowed: boolean; count: number; limit: number; shouldBlock: boolean } {
  cleanupOldDays();

  const key = buildKey(userId, recipientPhone);
  const today = getTodayKey();

  let record = dailyTopupStore.get(key);

  if (!record || record.dateKey !== today) {
    record = { count: 0, dateKey: today };
    dailyTopupStore.set(key, record);
  }

  if (record.count >= MAX_TOPUPS_PER_DAY_PER_PHONE) {
    console.log(`🚨 DAILY LIMIT EXCEEDED: User ${userId} has sent ${record.count} topups to ${normalizePhone(recipientPhone)} today (limit: ${MAX_TOPUPS_PER_DAY_PER_PHONE})`);
    return {
      allowed: false,
      count: record.count,
      limit: MAX_TOPUPS_PER_DAY_PER_PHONE,
      shouldBlock: true
    };
  }

  return {
    allowed: true,
    count: record.count,
    limit: MAX_TOPUPS_PER_DAY_PER_PHONE,
    shouldBlock: false
  };
}

export function recordDailyTopup(userId: string, recipientPhone: string): number {
  cleanupOldDays();

  const key = buildKey(userId, recipientPhone);
  const today = getTodayKey();

  let record = dailyTopupStore.get(key);

  if (!record || record.dateKey !== today) {
    record = { count: 0, dateKey: today };
    dailyTopupStore.set(key, record);
  }

  record.count += 1;
  console.log(`📊 DAILY TOPUP TRACK: User ${userId} → ${normalizePhone(recipientPhone)}: ${record.count}/${MAX_TOPUPS_PER_DAY_PER_PHONE} today`);
  return record.count;
}

export function getDailyTopupCount(userId: string, recipientPhone: string): number {
  const key = buildKey(userId, recipientPhone);
  const today = getTodayKey();
  const record = dailyTopupStore.get(key);
  if (!record || record.dateKey !== today) return 0;
  return record.count;
}

export function checkGuestDailyTopupLimit(
  clientIp: string,
  recipientPhone: string
): { allowed: boolean; count: number; limit: number } {
  cleanupOldDays();

  const key = `guest_ip_${clientIp}:${normalizePhone(recipientPhone)}`;
  const today = getTodayKey();

  let record = dailyTopupStore.get(key);

  if (!record || record.dateKey !== today) {
    record = { count: 0, dateKey: today };
    dailyTopupStore.set(key, record);
  }

  if (record.count >= MAX_TOPUPS_PER_DAY_PER_PHONE) {
    console.log(`🚨 GUEST DAILY LIMIT EXCEEDED: IP ${clientIp} has sent ${record.count} topups to ${normalizePhone(recipientPhone)} today (limit: ${MAX_TOPUPS_PER_DAY_PER_PHONE})`);
    return {
      allowed: false,
      count: record.count,
      limit: MAX_TOPUPS_PER_DAY_PER_PHONE
    };
  }

  return {
    allowed: true,
    count: record.count,
    limit: MAX_TOPUPS_PER_DAY_PER_PHONE
  };
}

export function recordGuestDailyTopup(clientIp: string, recipientPhone: string): number {
  cleanupOldDays();

  const key = `guest_ip_${clientIp}:${normalizePhone(recipientPhone)}`;
  const today = getTodayKey();

  let record = dailyTopupStore.get(key);

  if (!record || record.dateKey !== today) {
    record = { count: 0, dateKey: today };
    dailyTopupStore.set(key, record);
  }

  record.count += 1;
  console.log(`📊 GUEST DAILY TOPUP TRACK: IP ${clientIp} → ${normalizePhone(recipientPhone)}: ${record.count}/${MAX_TOPUPS_PER_DAY_PER_PHONE} today`);
  return record.count;
}

/**
 * 🛡️ DATABASE-BACKED GLOBAL PHONE LIMIT
 * Checks the actual database for completed topups to this phone number in the last 24 hours.
 * This survives server restarts and catches ALL topups regardless of user/guest/IP.
 */
export async function checkGlobalPhoneDailyLimit(
  storage: any,
  recipientPhone: string
): Promise<{ allowed: boolean; count: number; limit: number }> {
  try {
    const recentTxs = await storage.getRecentTransactionsByPhone(recipientPhone, 24 * 60);
    
    const completedCount = recentTxs.filter((tx: any) => 
      tx.status === 'completed' && tx.type === 'topup'
    ).length;

    if (completedCount >= MAX_GLOBAL_TOPUPS_PER_PHONE_PER_DAY) {
      console.log(`🚨 GLOBAL PHONE DAILY LIMIT: ${normalizePhone(recipientPhone)} received ${completedCount} topups in 24h (limit: ${MAX_GLOBAL_TOPUPS_PER_PHONE_PER_DAY})`);
      return {
        allowed: false,
        count: completedCount,
        limit: MAX_GLOBAL_TOPUPS_PER_PHONE_PER_DAY
      };
    }

    return {
      allowed: true,
      count: completedCount,
      limit: MAX_GLOBAL_TOPUPS_PER_PHONE_PER_DAY
    };
  } catch (error) {
    console.error('🚨 CRITICAL: Global phone daily limit check FAILED - BLOCKING for safety:', error);
    return { allowed: false, count: -1, limit: MAX_GLOBAL_TOPUPS_PER_PHONE_PER_DAY };
  }
}

setInterval(cleanupOldDays, 60 * 60 * 1000);

console.log(`🛡️ DAILY TOPUP LIMIT: System initialized (max ${MAX_TOPUPS_PER_DAY_PER_PHONE} topups per phone per user per day, global DB limit: ${MAX_GLOBAL_TOPUPS_PER_PHONE_PER_DAY})`);
