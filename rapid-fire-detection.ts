/**
 * 🛡️ RAPID-FIRE FRAUD DETECTION
 * Detects and blocks rapid consecutive top-ups to the same phone number
 * Prevents fraud where someone sends multiple topups in quick succession
 */

import { normalizePhone } from '../utils/normalize-phone';

interface TopupAttempt {
  timestamp: number;
  amount: string;
  ip: string;
}

interface PhoneRapidFireRecord {
  attempts: TopupAttempt[];
  blocked: boolean;
  blockedUntil?: number;
}

const rapidFireStore = new Map<string, PhoneRapidFireRecord>();

const RAPID_FIRE_WINDOW_MS = 5 * 60 * 1000;
const MAX_ATTEMPTS_IN_WINDOW = 1;
const COOLDOWN_PERIOD_MS = 15 * 60 * 1000;

function cleanupOldEntries(): void {
  const now = Date.now();
  const toDelete: string[] = [];

  rapidFireStore.forEach((record, phone) => {
    record.attempts = record.attempts.filter(
      a => now - a.timestamp < RAPID_FIRE_WINDOW_MS
    );

    if (record.blocked && record.blockedUntil && now > record.blockedUntil) {
      record.blocked = false;
      record.blockedUntil = undefined;
    }

    if (record.attempts.length === 0 && !record.blocked) {
      toDelete.push(phone);
    }
  });

  toDelete.forEach(phone => rapidFireStore.delete(phone));
}

export function checkRapidFire(
  recipientPhone: string,
  amount: string,
  clientIp: string
): { allowed: boolean; reason?: string; attemptsInWindow?: number; cooldownRemainingSeconds?: number } {
  cleanupOldEntries();

  const normalizedPhone = normalizePhone(recipientPhone);
  const now = Date.now();

  let record = rapidFireStore.get(normalizedPhone);

  if (!record) {
    record = { attempts: [], blocked: false };
    rapidFireStore.set(normalizedPhone, record);
  }

  if (record.blocked && record.blockedUntil && now < record.blockedUntil) {
    const remainingMs = record.blockedUntil - now;
    const remainingSec = Math.ceil(remainingMs / 1000);
    console.log(`🚨 RAPID-FIRE BLOCKED: ${normalizedPhone} is in cooldown for ${remainingSec}s more`);
    return {
      allowed: false,
      reason: 'RAPID_FIRE_COOLDOWN',
      attemptsInWindow: record.attempts.length,
      cooldownRemainingSeconds: remainingSec
    };
  }

  if (record.blocked && record.blockedUntil && now >= record.blockedUntil) {
    record.blocked = false;
    record.blockedUntil = undefined;
    record.attempts = [];
  }

  const recentAttempts = record.attempts.filter(
    a => now - a.timestamp < RAPID_FIRE_WINDOW_MS
  );

  if (recentAttempts.length >= MAX_ATTEMPTS_IN_WINDOW) {
    record.blocked = true;
    record.blockedUntil = now + COOLDOWN_PERIOD_MS;
    console.log(`🚨 RAPID-FIRE DETECTED: ${normalizedPhone} had ${recentAttempts.length + 1} attempts in ${RAPID_FIRE_WINDOW_MS / 1000}s window. Blocked for ${COOLDOWN_PERIOD_MS / 60000} minutes.`);
    return {
      allowed: false,
      reason: 'RAPID_FIRE_DETECTED',
      attemptsInWindow: recentAttempts.length + 1,
      cooldownRemainingSeconds: Math.ceil(COOLDOWN_PERIOD_MS / 1000)
    };
  }

  record.attempts.push({
    timestamp: now,
    amount,
    ip: clientIp
  });

  console.log(`✅ RAPID-FIRE CHECK: ${normalizedPhone} - ${recentAttempts.length + 1}/${MAX_ATTEMPTS_IN_WINDOW + 1} attempts in window`);

  return {
    allowed: true,
    attemptsInWindow: recentAttempts.length + 1
  };
}

export function checkRapidFireByKey(
  key: string,
  amount: string,
  clientIp: string
): { allowed: boolean; reason?: string; attemptsInWindow?: number; cooldownRemainingSeconds?: number } {
  cleanupOldEntries();

  const now = Date.now();

  let record = rapidFireStore.get(key);

  if (!record) {
    record = { attempts: [], blocked: false };
    rapidFireStore.set(key, record);
  }

  if (record.blocked && record.blockedUntil && now < record.blockedUntil) {
    const remainingMs = record.blockedUntil - now;
    const remainingSec = Math.ceil(remainingMs / 1000);
    console.log(`🚨 RAPID-FIRE BLOCKED: ${key} is in cooldown for ${remainingSec}s more`);
    return {
      allowed: false,
      reason: 'RAPID_FIRE_COOLDOWN',
      attemptsInWindow: record.attempts.length,
      cooldownRemainingSeconds: remainingSec
    };
  }

  if (record.blocked && record.blockedUntil && now >= record.blockedUntil) {
    record.blocked = false;
    record.blockedUntil = undefined;
    record.attempts = [];
  }

  const recentAttempts = record.attempts.filter(
    a => now - a.timestamp < RAPID_FIRE_WINDOW_MS
  );

  if (recentAttempts.length >= MAX_ATTEMPTS_IN_WINDOW) {
    record.blocked = true;
    record.blockedUntil = now + COOLDOWN_PERIOD_MS;
    console.log(`🚨 RAPID-FIRE DETECTED: ${key} had ${recentAttempts.length + 1} attempts in ${RAPID_FIRE_WINDOW_MS / 1000}s window. Blocked for ${COOLDOWN_PERIOD_MS / 60000} minutes.`);
    return {
      allowed: false,
      reason: 'RAPID_FIRE_DETECTED',
      attemptsInWindow: recentAttempts.length + 1,
      cooldownRemainingSeconds: Math.ceil(COOLDOWN_PERIOD_MS / 1000)
    };
  }

  record.attempts.push({
    timestamp: now,
    amount,
    ip: clientIp
  });

  console.log(`✅ RAPID-FIRE CHECK: ${key} - ${recentAttempts.length + 1}/${MAX_ATTEMPTS_IN_WINDOW + 1} attempts in window`);

  return {
    allowed: true,
    attemptsInWindow: recentAttempts.length + 1
  };
}

export function getRapidFireStatus(recipientPhone: string): {
  isBlocked: boolean;
  attemptsInWindow: number;
  cooldownRemainingSeconds?: number;
} {
  cleanupOldEntries();
  const normalizedPhone = normalizePhone(recipientPhone);
  const record = rapidFireStore.get(normalizedPhone);

  if (!record) {
    return { isBlocked: false, attemptsInWindow: 0 };
  }

  const now = Date.now();
  if (record.blocked && record.blockedUntil && now < record.blockedUntil) {
    return {
      isBlocked: true,
      attemptsInWindow: record.attempts.length,
      cooldownRemainingSeconds: Math.ceil((record.blockedUntil - now) / 1000)
    };
  }

  return {
    isBlocked: false,
    attemptsInWindow: record.attempts.filter(
      a => now - a.timestamp < RAPID_FIRE_WINDOW_MS
    ).length
  };
}

setInterval(cleanupOldEntries, 3 * 60 * 1000);

console.log('🛡️ RAPID-FIRE DETECTION: System initialized (1 topup per 5min per number, 15min cooldown)');
